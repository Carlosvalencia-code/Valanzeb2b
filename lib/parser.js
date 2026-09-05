/**
 * Valanze B2B — Parser de Lenguaje Natural para Kardex, Caja y Operaciones
 * Diseñado para alta tolerancia a errores y confirmaciones estructuradas
 */

/**
 * Calcula desglose tributario preliminar para Perú (18% IGV)
 * @param {number} totalAmount 
 * @param {'FACTURA'|'BOLETA'|'SIN_COMPROBANTE'} voucherType 
 * @returns {{ total: number, base: number, igv: number }}
 */
export function calculateTaxBreakdown(totalAmount, voucherType = 'SIN_COMPROBANTE') {
  const total = Math.abs(parseFloat(totalAmount));
  if (isNaN(total)) return { total: 0, base: 0, igv: 0 };

  if (voucherType === 'FACTURA') {
    const base = Math.round((total / 1.18) * 100) / 100;
    const igv = Math.round((total - base) * 100) / 100;
    return { total, base, igv };
  }

  // Boleta o Sin Comprobante en RER/MYPE: no genera crédito fiscal de IGV
  return { total, base: total, igv: 0.00 };
}

/**
 * Extrae la intención operativa del mensaje: COMPRA_STOCK, VENTA_STOCK, GASTO_GENERAL, INGRESO_GENERAL o COMANDO
 * @param {string} text 
 * @returns {object|null}
 */
export function parseB2BMessage(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // 1. Detección de Comandos Especiales
  if (trimmed.startsWith('/')) {
    const parts = trimmed.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);
    return {
      type: 'COMMAND',
      command,
      args,
      rawText: trimmed
    };
  }

  // 2. Detección de Compra / Entrada de Mercadería al Kardex
  // Ejemplos: "+24 sixpack cristal 96", "+10 arroz a 35", "compra 5 aceite 45.50"
  const compraKardexRegex = /^(?:\+|compra\s+)(\d+(?:[.,]\d+)?)\s+(?:unid(?:ades)?\s+|cajas?\s+|paquetes?\s+)?(.+?)(?:\s+(?:a|por|de))?\s+(\d+(?:[.,]\d+)?)$/i;
  const matchCompra = trimmed.match(compraKardexRegex);
  if (matchCompra) {
    const quantity = parseFloat(matchCompra[1].replace(',', '.'));
    const productName = matchCompra[2].trim();
    const totalAmount = parseFloat(matchCompra[3].replace(',', '.'));

    if (quantity > 0 && totalAmount > 0) {
      const unitCost = Math.round((totalAmount / quantity) * 100) / 100;
      return {
        type: 'COMPRA_STOCK',
        quantity,
        productName,
        totalAmount,
        unitCost,
        rawText: trimmed
      };
    }
  }

  // 3. Detección de Venta / Salida de Mercadería del Kardex
  // Ejemplos: "venta 2 sixpack cristal 32", "venta 3 coca cola", "-2 cerveza cristal 16"
  const ventaConMonto = /^(?:venta\s+|-)(\d+(?:[.,]\d+)?)\s+(?:unid(?:ades)?\s+|cajas?\s+|paquetes?\s+)?(.+?)\s+(?:a|por|de\s+)?(\d+(?:[.,]\d+)?)$/i;
  const ventaSinMonto = /^(?:venta\s+|-)(\d+(?:[.,]\d+)?)\s+(?:unid(?:ades)?\s+|cajas?\s+|paquetes?\s+)?(.+)$/i;

  const matchVentaMonto = trimmed.match(ventaConMonto);
  if (matchVentaMonto) {
    const quantity = parseFloat(matchVentaMonto[1].replace(',', '.'));
    const productName = matchVentaMonto[2].trim();
    const totalAmount = parseFloat(matchVentaMonto[3].replace(',', '.'));
    if (quantity > 0 && totalAmount > 0) {
      return {
        type: 'VENTA_STOCK',
        quantity,
        productName,
        totalAmount,
        rawText: trimmed
      };
    }
  }

  const matchVentaSimple = trimmed.match(ventaSinMonto);
  if (matchVentaSimple) {
    const quantity = parseFloat(matchVentaSimple[1].replace(',', '.'));
    const productName = matchVentaSimple[2].trim();
    if (quantity > 0 && productName) {
      return {
        type: 'VENTA_STOCK',
        quantity,
        productName,
        totalAmount: null, // Se tomará del catálogo
        rawText: trimmed
      };
    }
  }

  // 4. Detección de Gastos Generales de Caja Chica (Sin Kardex o insumos varios)
  // Ejemplos: "45 verduras mercado", "12 taxi compras", "gasté 25 en hielo"
  const numberRegex = /(?:^|\s)([+-]?\d+(?:[.,]\d+)?)(?:\s|$)/;
  const matchNumber = trimmed.match(numberRegex);
  if (matchNumber) {
    const rawNumber = matchNumber[1];
    let amount = parseFloat(rawNumber.replace(',', '.'));
    if (!isNaN(amount) && amount > 0 && amount <= 1000000) {
      let description = trimmed.replace(rawNumber, '').trim().replace(/\s+/g, ' ');
      if (!description) description = 'Gasto general';

      // Ingreso directo de caja (ej. +500 sencillo)
      if (rawNumber.startsWith('+') || /^(?:ingreso|cobro|sencillo)/i.test(description)) {
        return {
          type: 'INGRESO_CAJA',
          totalAmount: amount,
          description,
          rawText: trimmed
        };
      }

      // Gasto de caja chica
      return {
        type: 'GASTO_CAJA',
        totalAmount: amount,
        description,
        rawText: trimmed
      };
    }
  }

  return null;
}
