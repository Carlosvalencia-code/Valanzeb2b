/**
 * Valanze B2B — Generador de Exportación Contable Estructurada
 * Diseñado para entrega al contador externo con diccionario de datos y deslinde legal
 */

import { supabase } from './db.js';

/**
 * Genera el paquete de trabajo contable en formato CSV con BOM (compatible con Excel)
 * @param {string} monthStr YYYY-MM
 * @returns {Promise<{ filename: string, content: string }>}
 */
export async function generateAccountingWorksheet(monthStr) {
  const targetMonth = monthStr || new Date().toISOString().slice(0, 7); // 'YYYY-MM'

  let purchases = [];
  let sales = [];
  let kardex = [];

  if (supabase) {
    // 1. Obtener Compras y Gastos del mes
    const { data: pData } = await supabase
      .from('cash_transactions')
      .select('created_at, voucher_type, voucher_number, supplier_ruc, supplier_name, description, base_amount, igv_amount, total_amount, payment_method, review_status, user_id')
      .in('type', ['COMPRA', 'GASTO_OPERATIVO'])
      .gte('created_at', `${targetMonth}-01T00:00:00Z`)
      .lte('created_at', `${targetMonth}-31T23:59:59Z`)
      .neq('review_status', 'ANULADO')
      .order('created_at', { ascending: true });

    purchases = pData || [];

    // 2. Obtener Ventas del mes
    const { data: sData } = await supabase
      .from('cash_transactions')
      .select('created_at, description, total_amount, payment_method, review_status')
      .eq('type', 'VENTA')
      .gte('created_at', `${targetMonth}-01T00:00:00Z`)
      .lte('created_at', `${targetMonth}-31T23:59:59Z`)
      .neq('review_status', 'ANULADO')
      .order('created_at', { ascending: true });

    sales = sData || [];

    // 3. Obtener Kardex valorizado actual
    const { data: kData } = await supabase
      .from('products_catalog')
      .select('sku, name, category, unit, current_stock, avg_cost, min_stock')
      .eq('is_active', true)
      .order('category', { ascending: true });

    kardex = kData || [];
  }

  // Encabezado con Deslinde Legal y Regulatorio
  let csv = '\uFEFF'; // Byte Order Mark para que Excel abra UTF-8 directamente
  csv += `# VALANZE B2B — ARCHIVO DE TRABAJO PARA REVISIÓN CONTABLE\n`;
  csv += `# Periodo: ${targetMonth}\n`;
  csv += `# AVISO REGULATORIO: La base imponible y el IGV (18%) son cálculos preliminares basados en las operaciones clasificadas por el usuario. No constituyen liquidación tributaria oficial ante SUNAT.\n\n`;

  // SECCIÓN 1: REGISTRO DE COMPRAS Y GASTOS OPERATIVOS
  csv += `=== SECCION 1: COMPRAS E INSUMOS (PROPUESTA REGISTRO DE COMPRAS) ===\n`;
  csv += `Fecha,Tipo_Comprobante,RUC_Proveedor,Razon_Social,Descripcion,Base_Imponible_Preliminar,IGV_18_Preliminar,Total,Metodo_Pago,Estado_Revision\n`;

  let totalCompras = 0;
  let totalBaseCompras = 0;
  let totalIgvCompras = 0;

  purchases.forEach(row => {
    const date = row.created_at ? row.created_at.split('T')[0] : '';
    const desc = `"${(row.description || '').replace(/"/g, '""')}"`;
    const ruc = row.supplier_ruc || 'S/N';
    const supplier = `"${(row.supplier_name || 'Varios / Mercado').replace(/"/g, '""')}"`;
    const base = parseFloat(row.base_amount) || 0;
    const igv = parseFloat(row.igv_amount) || 0;
    const total = parseFloat(row.total_amount) || 0;

    totalCompras += total;
    totalBaseCompras += base;
    totalIgvCompras += igv;

    csv += `${date},${row.voucher_type},${ruc},${supplier},${desc},${base.toFixed(2)},${igv.toFixed(2)},${total.toFixed(2)},${row.payment_method},${row.review_status}\n`;
  });

  csv += `TOTALES COMPRAS,,,,,${totalBaseCompras.toFixed(2)},${totalIgvCompras.toFixed(2)},${totalCompras.toFixed(2)},,\n\n`;

  // SECCIÓN 2: REGISTRO DE VENTAS Y CAJA
  csv += `=== SECCION 2: VENTAS E INGRESOS OPERATIVOS ===\n`;
  csv += `Fecha,Descripcion,Monto_Total,Metodo_Pago,Estado\n`;

  let totalVentas = 0;
  sales.forEach(row => {
    const date = row.created_at ? row.created_at.split('T')[0] : '';
    const desc = `"${(row.description || '').replace(/"/g, '""')}"`;
    const total = parseFloat(row.total_amount) || 0;
    totalVentas += total;
    csv += `${date},${desc},${total.toFixed(2)},${row.payment_method},${row.review_status}\n`;
  });

  csv += `TOTAL VENTAS,,${totalVentas.toFixed(2)},,\n\n`;

  // SECCIÓN 3: KARDEX VALORIZADO
  csv += `=== SECCION 3: INVENTARIO Y KARDEX VALORIZADO (COSTO PROMEDIO) ===\n`;
  csv += `SKU,Producto,Categoria,Unidad,Stock_Actual,Costo_Promedio_Unitario,Valor_Total_Inventario,Alerta_Stock\n`;

  let valorTotalInventario = 0;
  kardex.forEach(row => {
    const stock = parseFloat(row.current_stock) || 0;
    const cost = parseFloat(row.avg_cost) || 0;
    const value = Math.round(stock * cost * 100) / 100;
    valorTotalInventario += value;
    const alert = stock <= (row.min_stock || 5) ? 'ALERTA_STOCK_BAJO' : 'OK';
    csv += `${row.sku},"${row.name.replace(/"/g, '""')}",${row.category},${row.unit},${stock.toFixed(2)},${cost.toFixed(2)},${value.toFixed(2)},${alert}\n`;
  });

  csv += `TOTAL VALORIZACION INVENTARIO,,,,,${valorTotalInventario.toFixed(2)},\n\n`;

  // DICCIONARIO DE CAMPOS
  csv += `=== DICCIONARIO DE CAMPOS Y GUIA PARA EL CONTADOR ===\n`;
  csv += `Campo,Definicion,Uso Tributario\n`;
  csv += `Tipo_Comprobante,FACTURA / BOLETA / SIN_COMPROBANTE,Solo FACTURA calcula credito fiscal (18% IGV) preliminar.\n`;
  csv += `Base_Imponible_Preliminar,Total / 1.18 para facturas; Total completo para boletas,Monto neto deducible para costo/gasto sujeto a sustento.\n`;
  csv += `IGV_18_Preliminar,Credito fiscal preliminar calculado,Requiere verificacion de validez de comprobante en SUNAT.\n`;
  csv += `Estado_Revision,PENDIENTE / VALIDADO_CONTADOR / OBSERVADO,Permite al contador marcar operaciones ya procesadas en el sistema contable.\n`;

  return {
    filename: `Valanze_Contable_${targetMonth}.csv`,
    content: csv
  };
}
