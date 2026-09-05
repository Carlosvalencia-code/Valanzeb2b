-- ==============================================================================
-- Valanze B2B — Esquema de Base de Datos PostgreSQL para Supabase
-- Sistema de Kardex, Caja Chica y Pre-Contabilidad para Retail y Gastronomía
-- ==============================================================================

-- 1. Perfil del Negocio y Régimen Tributario
CREATE TABLE IF NOT EXISTS public.business_profile (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ruc VARCHAR(11) NOT NULL,
  business_name TEXT NOT NULL,
  trade_name TEXT,
  tax_regime TEXT NOT NULL DEFAULT 'RER' CHECK (tax_regime IN ('RER', 'MYPE_TRIBUTARIO', 'GENERAL', 'RUS')),
  currency VARCHAR(3) NOT NULL DEFAULT 'PEN',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Control de Roles y Usuarios por Telegram ID
CREATE TABLE IF NOT EXISTS public.business_users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  telegram_username TEXT,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'STAFF')),
  status TEXT NOT NULL DEFAULT 'ACTIVO' CHECK (status IN ('ACTIVO', 'INACTIVO', 'REVOCADO')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_business_users_telegram_id ON public.business_users(telegram_id);

-- 3. Catálogo Pre-configurado de Productos e Insumos Discretos
CREATE TABLE IF NOT EXISTS public.products_catalog (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  unit TEXT NOT NULL DEFAULT 'unid', -- unid, caja, sixpack, kg, saco, paquete
  sale_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  avg_cost NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  current_stock NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  min_stock NUMERIC(12, 2) NOT NULL DEFAULT 5.00,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_catalog_name ON public.products_catalog(name);
CREATE INDEX IF NOT EXISTS idx_products_catalog_sku ON public.products_catalog(sku);

-- 4. Movimientos de Kardex (Inventario con Costo Promedio Ponderado)
CREATE TABLE IF NOT EXISTS public.kardex_movements (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES public.products_catalog(id) ON DELETE RESTRICT,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('COMPRA_ENTRADA', 'VENTA_SALIDA', 'MERMA_AVERIA', 'AJUSTE')),
  quantity NUMERIC(12, 2) NOT NULL,
  unit_cost NUMERIC(12, 2) NOT NULL,
  prev_stock NUMERIC(12, 2) NOT NULL,
  new_stock NUMERIC(12, 2) NOT NULL,
  reference_id UUID, -- Referencia a cash_transactions si aplica
  notes TEXT,
  user_id BIGINT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kardex_product ON public.kardex_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_kardex_created_at ON public.kardex_movements(created_at);

-- 5. Transacciones de Caja, Compras y Ventas (Desglose Tributario Preliminar)
CREATE TABLE IF NOT EXISTS public.cash_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('VENTA', 'COMPRA', 'GASTO_OPERATIVO')),
  total_amount NUMERIC(12, 2) NOT NULL,
  base_amount NUMERIC(12, 2) NOT NULL,
  igv_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  voucher_type TEXT NOT NULL DEFAULT 'SIN_COMPROBANTE' CHECK (voucher_type IN ('FACTURA', 'BOLETA', 'SIN_COMPROBANTE', 'PENDIENTE')),
  voucher_number TEXT,
  supplier_ruc VARCHAR(11),
  supplier_name TEXT,
  payment_method TEXT NOT NULL DEFAULT 'Efectivo' CHECK (payment_method IN ('Efectivo', 'Yape/Plin', 'Tarjeta', 'Transferencia')),
  description TEXT NOT NULL,
  product_id UUID REFERENCES public.products_catalog(id),
  quantity NUMERIC(12, 2),
  raw_text TEXT,
  review_status TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK (review_status IN ('PENDIENTE', 'VALIDADO_CONTADOR', 'OBSERVADO', 'ANULADO')),
  user_id BIGINT NOT NULL,
  shift_id TEXT, -- Identificador de turno YYYYMMDD-HH
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_transactions_user ON public.cash_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_cash_transactions_created_at ON public.cash_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_cash_transactions_type ON public.cash_transactions(type);

-- 6. Idempotencia de Webhooks de Telegram (Anti-duplicación)
CREATE TABLE IF NOT EXISTS public.webhook_idempotency (
  update_id BIGINT PRIMARY KEY,
  processed_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 7. Registro de Auditoría Inmutable (Audit Trail)
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  action TEXT NOT NULL, -- INSERT, UPDATE, DELETE, ROLLBACK, SHIFT_CLOSE
  entity TEXT NOT NULL, -- transactions, kardex, catalog, users
  entity_id TEXT,
  details JSONB,
  user_id BIGINT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON public.audit_logs(created_at);

-- 8. Seguridad a Nivel de Fila (Row Level Security - RLS)
ALTER TABLE public.business_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kardex_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- 9. Funciones RPC de Alto Rendimiento

-- RPC: Resumen Valorizado de Kardex con Alerta de Stock Mínimo
CREATE OR REPLACE FUNCTION get_kardex_valuation()
RETURNS TABLE(
  sku TEXT,
  product_name TEXT,
  category TEXT,
  unit TEXT,
  stock NUMERIC,
  avg_cost NUMERIC,
  total_value NUMERIC,
  is_low_stock BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    p.sku,
    p.name AS product_name,
    p.category,
    p.unit,
    p.current_stock AS stock,
    p.avg_cost,
    ROUND(p.current_stock * p.avg_cost, 2) AS total_value,
    (p.current_stock <= p.min_stock) AS is_low_stock
  FROM public.products_catalog p
  WHERE p.is_active = true
  ORDER BY p.category, p.name;
END;
$$ LANGUAGE plpgsql;

-- RPC: Resumen de Caja por Turno / Día
CREATE OR REPLACE FUNCTION get_shift_cash_summary(p_date DATE)
RETURNS TABLE(
  total_ventas_efectivo NUMERIC,
  total_ventas_digital NUMERIC,
  total_ventas_tarjeta NUMERIC,
  total_compras_efectivo NUMERIC,
  total_gastos_efectivo NUMERIC,
  efectivo_teorico_en_caja NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(SUM(CASE WHEN type = 'VENTA' AND payment_method = 'Efectivo' THEN total_amount ELSE 0 END), 0) AS total_ventas_efectivo,
    COALESCE(SUM(CASE WHEN type = 'VENTA' AND payment_method = 'Yape/Plin' THEN total_amount ELSE 0 END), 0) AS total_ventas_digital,
    COALESCE(SUM(CASE WHEN type = 'VENTA' AND payment_method = 'Tarjeta' THEN total_amount ELSE 0 END), 0) AS total_ventas_tarjeta,
    COALESCE(SUM(CASE WHEN type = 'COMPRA' AND payment_method = 'Efectivo' THEN total_amount ELSE 0 END), 0) AS total_compras_efectivo,
    COALESCE(SUM(CASE WHEN type = 'GASTO_OPERATIVO' AND payment_method = 'Efectivo' THEN total_amount ELSE 0 END), 0) AS total_gastos_efectivo,
    COALESCE(SUM(CASE 
      WHEN type = 'VENTA' AND payment_method = 'Efectivo' THEN total_amount
      WHEN type IN ('COMPRA', 'GASTO_OPERATIVO') AND payment_method = 'Efectivo' THEN -total_amount
      ELSE 0 
    END), 0) AS efectivo_teorico_en_caja
  FROM public.cash_transactions
  WHERE date_trunc('day', created_at) = p_date
    AND review_status != 'ANULADO';
END;
$$ LANGUAGE plpgsql;
