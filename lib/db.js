/**
 * Valanze B2B — Capa de Base de Datos y Lógica Transaccional
 * Implementa control de roles, idempotencia, trazabilidad y cálculo de Kardex
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { logAuditEvent } from './audit.js';
import { calculateTaxBreakdown } from './parser.js';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

export const supabase = (supabaseUrl && supabaseKey) 
  ? createClient(supabaseUrl, supabaseKey) 
  : null;

/**
 * Verifica si un update_id de Telegram ya fue procesado para evitar duplicados
 * @param {number} updateId 
 * @returns {Promise<boolean>} true si es nuevo y se procesó, false si es duplicado
 */
export async function checkIdempotency(updateId) {
  if (!supabase || !updateId) return true; // Si no hay BD, continuar en simulación
  try {
    const { error } = await supabase
      .from('webhook_idempotency')
      .insert([{ update_id: updateId }]);

    if (error && error.code === '23505') {
      console.warn(`[Idempotency] Mensaje duplicado detectado: update_id=${updateId}`);
      return false; // Ya fue procesado
    }
    return true;
  } catch (err) {
    console.error('[Idempotency Error]', err);
    return true;
  }
}

/**
 * Obtiene el rol del usuario (ADMIN, STAFF o UNKNOWN)
 * @param {number} telegramId 
 * @returns {Promise<{ role: 'ADMIN'|'STAFF'|'UNKNOWN', user: object|null }>}
 */
export async function getUserRole(telegramId) {
  const adminIdEnv = process.env.ADMIN_TELEGRAM_ID;
  if (adminIdEnv && telegramId.toString() === adminIdEnv.toString()) {
    return { role: 'ADMIN', user: { full_name: 'Administrador Principal', role: 'ADMIN' } };
  }

  if (!supabase) {
    return { role: 'ADMIN', user: { full_name: 'Simulador Admin', role: 'ADMIN' } };
  }

  const { data, error } = await supabase
    .from('business_users')
    .select('*')
    .eq('telegram_id', telegramId)
    .eq('status', 'ACTIVO')
    .maybeSingle();

  if (error || !data) {
    return { role: 'UNKNOWN', user: null };
  }

  return { role: data.role, user: data };
}

/**
 * Registra o actualiza un miembro del staff (Solo ejecutable por Admin)
 */
export async function registerStaffUser({ telegramId, username, fullName, role, adminId }) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('business_users')
    .upsert([{
      telegram_id: telegramId,
      telegram_username: username || null,
      full_name: fullName,
      role: role.toUpperCase(),
      status: 'ACTIVO'
    }], { onConflict: 'telegram_id' })
    .select()
    .single();

  if (error) throw error;

  await logAuditEvent(supabase, {
    action: 'REGISTER_USER',
    entity: 'business_users',
    entityId: telegramId,
    details: { fullName, role },
    userId: adminId
  });

  return data;
}

/**
 * Busca un producto en el catálogo por nombre aproximado o SKU
 */
export async function findProduct(searchTerm) {
  if (!supabase) return null;
  const term = searchTerm.trim().toLowerCase();

  const { data, error } = await supabase
    .from('products_catalog')
    .select('*')
    .eq('is_active', true);

  if (error || !data) return null;

  // 1. Coincidencia exacta de SKU o Nombre
  const exact = data.find(p => p.sku.toLowerCase() === term || p.name.toLowerCase() === term);
  if (exact) return exact;

  // 2. Coincidencia parcial contenida
  const partial = data.find(p => p.name.toLowerCase().includes(term) || term.includes(p.name.toLowerCase()));
  return partial || null;
}

/**
 * Registra o actualiza un producto en el catálogo (Solo Admin)
 */
export async function upsertProduct({ sku, name, category, unit, salePrice, avgCost, currentStock, minStock, userId }) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('products_catalog')
    .upsert([{
      sku,
      name,
      category: category || 'General',
      unit: unit || 'unid',
      sale_price: salePrice,
      avg_cost: avgCost,
      current_stock: currentStock || 0,
      min_stock: minStock || 5,
      is_active: true,
      updated_at: new Date().toISOString()
    }], { onConflict: 'sku' })
    .select()
    .single();

  if (error) throw error;

  await logAuditEvent(supabase, {
    action: 'UPSERT_PRODUCT',
    entity: 'products_catalog',
    entityId: sku,
    details: { name, salePrice, avgCost },
    userId
  });

  return data;
}

/**
 * Ejecuta compra de stock e impacta Kardex con costo promedio ponderado
 */
export async function recordStockPurchase({ product, quantity, totalAmount, voucherType, userId, rawText }) {
  if (!supabase) {
    return {
      productName: product.name,
      newStock: (product.current_stock || 0) + quantity,
      totalAmount,
      voucherType
    };
  }

  const { total, base, igv } = calculateTaxBreakdown(totalAmount, voucherType);
  const unitCost = Math.round((total / quantity) * 100) / 100;

  // Cálculo de Costo Promedio Ponderado
  const currentStock = parseFloat(product.current_stock) || 0;
  const currentAvgCost = parseFloat(product.avg_cost) || 0;
  const newStock = currentStock + quantity;
  const newAvgCost = newStock > 0 
    ? Math.round(((currentStock * currentAvgCost + total) / newStock) * 100) / 100 
    : unitCost;

  // 1. Actualizar catálogo
  const { error: catErr } = await supabase
    .from('products_catalog')
    .update({
      current_stock: newStock,
      avg_cost: newAvgCost,
      updated_at: new Date().toISOString()
    })
    .eq('id', product.id);

  if (catErr) throw catErr;

  // 2. Registrar transacción financiera
  const { data: txData, error: txErr } = await supabase
    .from('cash_transactions')
    .insert([{
      type: 'COMPRA',
      total_amount: total,
      base_amount: base,
      igv_amount: igv,
      voucher_type: voucherType,
      description: `Compra stock: ${quantity} ${product.unit} ${product.name}`,
      product_id: product.id,
      quantity,
      payment_method: 'Efectivo',
      review_status: 'PENDIENTE',
      user_id: userId,
      raw_text: rawText
    }])
    .select()
    .single();

  if (txErr) throw txErr;

  // 3. Registrar movimiento de Kardex
  await supabase
    .from('kardex_movements')
    .insert([{
      product_id: product.id,
      movement_type: 'COMPRA_ENTRADA',
      quantity,
      unit_cost: unitCost,
      prev_stock: currentStock,
      new_stock: newStock,
      reference_id: txData.id,
      notes: `Compra con ${voucherType}`,
      user_id: userId
    }]);

  await logAuditEvent(supabase, {
    action: 'PURCHASE_STOCK',
    entity: 'kardex_movements',
    entityId: product.id,
    details: { quantity, total, newStock, voucherType },
    userId
  });

  return {
    productName: product.name,
    unit: product.unit,
    newStock,
    unitCost,
    total,
    base,
    igv,
    voucherType,
    txId: txData.id
  };
}

/**
 * Ejecuta venta de stock y descuenta unidades del Kardex
 */
export async function recordStockSale({ product, quantity, totalAmount, paymentMethod = 'Efectivo', userId, rawText }) {
  const currentStock = parseFloat(product.current_stock) || 0;
  const newStock = currentStock - quantity;
  const finalAmount = totalAmount !== null ? totalAmount : (parseFloat(product.sale_price) * quantity);

  if (!supabase) {
    return {
      productName: product.name,
      quantity,
      newStock,
      totalAmount: finalAmount,
      isLowStock: newStock <= (product.min_stock || 5)
    };
  }

  // 1. Actualizar catálogo
  await supabase
    .from('products_catalog')
    .update({
      current_stock: newStock,
      updated_at: new Date().toISOString()
    })
    .eq('id', product.id);

  // 2. Registrar transacción
  const { data: txData } = await supabase
    .from('cash_transactions')
    .insert([{
      type: 'VENTA',
      total_amount: finalAmount,
      base_amount: finalAmount,
      igv_amount: 0.00,
      voucher_type: 'SIN_COMPROBANTE',
      payment_method: paymentMethod,
      description: `Venta: ${quantity} ${product.unit} ${product.name}`,
      product_id: product.id,
      quantity,
      user_id: userId,
      raw_text: rawText
    }])
    .select()
    .single();

  // 3. Registrar Kardex salida
  await supabase
    .from('kardex_movements')
    .insert([{
      product_id: product.id,
      movement_type: 'VENTA_SALIDA',
      quantity,
      unit_cost: product.avg_cost || 0,
      prev_stock: currentStock,
      new_stock: newStock,
      reference_id: txData?.id || null,
      user_id: userId
    }]);

  await logAuditEvent(supabase, {
    action: 'SALE_STOCK',
    entity: 'kardex_movements',
    entityId: product.id,
    details: { quantity, finalAmount, newStock },
    userId
  });

  return {
    productName: product.name,
    quantity,
    newStock,
    totalAmount: finalAmount,
    isLowStock: newStock <= (product.min_stock || 5),
    txId: txData?.id
  };
}

/**
 * Registra un gasto general de caja chica (insumos varios, hielo, limpieza)
 */
export async function recordCashExpense({ amount, description, voucherType = 'SIN_COMPROBANTE', userId, rawText }) {
  const { total, base, igv } = calculateTaxBreakdown(amount, voucherType);

  if (!supabase) {
    return { total, base, igv, description, voucherType };
  }

  const { data, error } = await supabase
    .from('cash_transactions')
    .insert([{
      type: 'GASTO_OPERATIVO',
      total_amount: total,
      base_amount: base,
      igv_amount: igv,
      voucher_type: voucherType,
      description,
      payment_method: 'Efectivo',
      review_status: 'PENDIENTE',
      user_id: userId,
      raw_text: rawText
    }])
    .select()
    .single();

  if (error) throw error;

  await logAuditEvent(supabase, {
    action: 'CASH_EXPENSE',
    entity: 'cash_transactions',
    entityId: data.id,
    details: { total, base, igv, voucherType },
    userId
  });

  return { total, base, igv, description, voucherType, txId: data.id };
}

/**
 * Consulta de valoración de Kardex
 */
export async function getKardexSummary() {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('get_kardex_valuation');
  if (error) {
    // Si no está el RPC, consultar directo de la tabla
    const { data: catData } = await supabase
      .from('products_catalog')
      .select('sku, name, category, unit, current_stock, avg_cost, min_stock')
      .eq('is_active', true)
      .order('name');

    return (catData || []).map(p => ({
      sku: p.sku,
      product_name: p.name,
      category: p.category,
      unit: p.unit,
      stock: p.current_stock,
      avg_cost: p.avg_cost,
      total_value: Math.round(p.current_stock * p.avg_cost * 100) / 100,
      is_low_stock: p.current_stock <= p.min_stock
    }));
  }
  return data || [];
}

/**
 * Consulta de cuadre de caja del turno o día actual
 */
export async function getShiftCashReport(dateStr) {
  const today = dateStr || new Date().toISOString().split('T')[0];
  if (!supabase) {
    return {
      total_ventas_efectivo: 0,
      total_ventas_digital: 0,
      total_compras_efectivo: 0,
      total_gastos_efectivo: 0,
      efectivo_teorico_en_caja: 0
    };
  }

  const { data, error } = await supabase.rpc('get_shift_cash_summary', { p_date: today });
  if (error || !data || data.length === 0) {
    // Consulta directa de fallback
    const { data: txs } = await supabase
      .from('cash_transactions')
      .select('type, total_amount, payment_method')
      .gte('created_at', `${today}T00:00:00Z`)
      .lte('created_at', `${today}T23:59:59Z`)
      .neq('review_status', 'ANULADO');

    let ventasEf = 0, ventasDig = 0, comprasEf = 0, gastosEf = 0;
    (txs || []).forEach(tx => {
      const val = parseFloat(tx.total_amount) || 0;
      if (tx.type === 'VENTA') {
        if (tx.payment_method === 'Efectivo') ventasEf += val;
        else ventasDig += val;
      } else if (tx.type === 'COMPRA' && tx.payment_method === 'Efectivo') {
        comprasEf += val;
      } else if (tx.type === 'GASTO_OPERATIVO' && tx.payment_method === 'Efectivo') {
        gastosEf += val;
      }
    });

    return {
      total_ventas_efectivo: ventasEf,
      total_ventas_digital: ventasDig,
      total_compras_efectivo: comprasEf,
      total_gastos_efectivo: gastosEf,
      efectivo_teorico_en_caja: ventasEf - comprasEf - gastosEf
    };
  }

  return data[0];
}

/**
 * Anula la última transacción registrada por el usuario
 */
export async function undoLastTransaction(userId) {
  if (!supabase) return null;

  const { data: lastTx, error } = await supabase
    .from('cash_transactions')
    .select('*')
    .eq('user_id', userId)
    .neq('review_status', 'ANULADO')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !lastTx) return null;

  // Marcar como anulada
  await supabase
    .from('cash_transactions')
    .update({ review_status: 'ANULADO' })
    .eq('id', lastTx.id);

  // Si tenía impacto en Kardex, revertir stock
  if (lastTx.product_id && lastTx.quantity) {
    const { data: prod } = await supabase
      .from('products_catalog')
      .select('current_stock')
      .eq('id', lastTx.product_id)
      .single();

    if (prod) {
      const curr = parseFloat(prod.current_stock) || 0;
      const revertedStock = lastTx.type === 'COMPRA' ? (curr - lastTx.quantity) : (curr + lastTx.quantity);
      await supabase
        .from('products_catalog')
        .update({ current_stock: revertedStock })
        .eq('id', lastTx.product_id);

      await supabase
        .from('kardex_movements')
        .insert([{
          product_id: lastTx.product_id,
          movement_type: 'AJUSTE',
          quantity: lastTx.quantity,
          unit_cost: 0,
          prev_stock: curr,
          new_stock: revertedStock,
          notes: `Reverso de transacción anulada: ${lastTx.id}`,
          user_id: userId
        }]);
    }
  }

  await logAuditEvent(supabase, {
    action: 'UNDO_TRANSACTION',
    entity: 'cash_transactions',
    entityId: lastTx.id,
    details: { type: lastTx.type, amount: lastTx.total_amount },
    userId
  });

  return lastTx;
}
