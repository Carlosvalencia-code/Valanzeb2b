/**
 * Valanze B2B — Orquestador de Mensajes y Lógica de Negocio
 * Aplica confirmación estructurada previa, matriz de roles y trazabilidad
 */

import { parseB2BMessage, calculateTaxBreakdown } from './parser.js';
import { 
  getUserRole, 
  registerStaffUser, 
  findProduct, 
  upsertProduct, 
  recordStockPurchase, 
  recordStockSale, 
  recordCashExpense, 
  getKardexSummary, 
  getShiftCashReport, 
  undoLastTransaction 
} from './db.js';
import { generateAccountingWorksheet } from './exportAccounting.js';

// Almacén en memoria para compras pendientes de confirmación de comprobante
// Estructura: Map<pendingId, { type, product, quantity, totalAmount, description, userId, timestamp }>
const pendingConfirmations = new Map();

// Limpieza automática de pendientes mayores a 15 minutos
setInterval(() => {
  const now = Date.now();
  for (const [id, item] of pendingConfirmations.entries()) {
    if (now - item.timestamp > 15 * 60 * 1000) {
      pendingConfirmations.delete(id);
    }
  }
}, 5 * 60 * 1000);

export async function handleB2BMessage(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  if (!text) return;

  // 1. Verificación de Rol y Seguridad
  const { role, user } = await getUserRole(userId);
  if (role === 'UNKNOWN' && !text.startsWith('/start')) {
    await bot.sendMessage(chatId, '🔒 *Acceso restringido.*\nEste canal de trabajo es exclusivo para el personal autorizado del negocio. Solicita al administrador que registre tu Telegram ID.', { parse_mode: 'Markdown' });
    return;
  }

  // 2. Parseo de intención
  const parsed = parseB2BMessage(text);
  if (!parsed) {
    await bot.sendMessage(chatId, '🤔 No logré entender la operación.\nPuedes registrar:\n• Compra: `+24 sixpack cristal 96`\n• Venta: `venta 2 sixpack cristal`\n• Gasto: `25 hielo y bolsas`\n• Ver stock: /stock', { parse_mode: 'Markdown' });
    return;
  }

  // --- MANEJO DE COMANDOS ---
  if (parsed.type === 'COMMAND') {
    const cmd = parsed.command;
    const args = parsed.args;

    // Comando /start
    if (cmd === '/start') {
      const isAdmin = role === 'ADMIN';
      const welcome = `👋 *Valanze B2B — Control de Kardex y Caja*\n` +
        `Rol detectado: *${isAdmin ? 'Administrador / Dueño' : 'Personal Operativo'}*\n\n` +
        `📦 *Operaciones diarias:*\n` +
        `• \`+24 sixpack cristal 96\` → Entra stock y abre selector de comprobante.\n` +
        `• \`venta 2 sixpack cristal\` → Descuenta stock y suma a caja.\n` +
        `• \`15 pasajes mercado\` → Registra gasto de caja chica.\n\n` +
        `📋 *Comandos:*\n` +
        `• /stock — Consulta inventario y alertas de stock mínimo.\n` +
        `• /cerrar_turno — Cuadre de caja y efectivo en gaveta.\n` +
        (isAdmin ? `• /balance — Resumen de ingresos, compras y márgenes.\n• /producto — Dar de alta un producto en el catálogo.\n• /staff — Autorizar a un empleado.\n• /exportar_contable — Descarga la sábana para el contador.` : '');

      await bot.sendMessage(chatId, welcome, { parse_mode: 'Markdown' });
      return;
    }

    // Comando /stock o /kardex
    if (cmd === '/stock' || cmd === '/kardex') {
      try {
        const items = await getKardexSummary();
        if (!items || items.length === 0) {
          await bot.sendMessage(chatId, '📦 El catálogo de productos está vacío.\nEl administrador puede registrar ítems con: `/producto SKU Nombre Precio Costo`', { parse_mode: 'Markdown' });
          return;
        }

        let msgStock = `📦 *Inventario y Kardex Actual*\n\n`;
        let totalValor = 0;

        items.forEach(it => {
          const alert = it.is_low_stock ? ' ⚠️ *(Stock Bajo)*' : '';
          msgStock += `• *${it.product_name}* (${it.sku}): ${it.stock} ${it.unit} · Costo prom.: S/ ${parseFloat(it.avg_cost).toFixed(2)}${alert}\n`;
          totalValor += parseFloat(it.total_value) || 0;
        });

        if (role === 'ADMIN') {
          msgStock += `\n💰 *Valorización Total del Stock:* S/ ${totalValor.toFixed(2)}`;
        }

        await bot.sendMessage(chatId, msgStock, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error en /stock:', err);
        await bot.sendMessage(chatId, '❌ Error al consultar el stock.');
      }
      return;
    }

    // Comando /producto (Solo Admin)
    if (cmd === '/producto') {
      if (role !== 'ADMIN') {
        await bot.sendMessage(chatId, '🔒 Solo el Administrador puede crear o editar productos en el catálogo.');
        return;
      }

      // Sintaxis: /producto SKU Nombre Precio Venta Costo
      // Ej: /producto CRISTAL-6 Cerveza Cristal Sixpack 18.00 12.00
      if (args.length < 4) {
        await bot.sendMessage(chatId, 'ℹ️ *Formato para registrar producto:*\n`/producto [SKU] [Nombre] [Precio_Venta] [Costo_Promedio]`\n\nEjemplo:\n`/producto CRISTAL-6 Sixpack Cristal 18.00 12.00`', { parse_mode: 'Markdown' });
        return;
      }

      const sku = args[0].toUpperCase();
      const salePrice = parseFloat(args[args.length - 2]);
      const avgCost = parseFloat(args[args.length - 1]);
      const name = args.slice(1, args.length - 2).join(' ');

      if (isNaN(salePrice) || isNaN(avgCost) || !name) {
        await bot.sendMessage(chatId, '❌ Precios o nombre inválidos. Revisa el formato.');
        return;
      }

      try {
        await upsertProduct({
          sku,
          name,
          category: 'Abarrotes/Bebidas',
          unit: 'unid',
          salePrice,
          avgCost,
          currentStock: 0,
          minStock: 5,
          userId
        });
        await bot.sendMessage(chatId, `✅ *Producto guardado en catálogo:*\n• *${name}* (${sku})\n• Venta: S/ ${salePrice.toFixed(2)} | Costo base: S/ ${avgCost.toFixed(2)}`, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error guardando producto:', err);
        await bot.sendMessage(chatId, '❌ Error al guardar producto en catálogo.');
      }
      return;
    }

    // Comando /staff (Solo Admin)
    if (cmd === '/staff') {
      if (role !== 'ADMIN') {
        await bot.sendMessage(chatId, '🔒 Solo el Administrador puede gestionar el personal.');
        return;
      }

      // Sintaxis: /staff [telegram_id] [Nombre] [ADMIN|STAFF]
      if (args.length < 3) {
        await bot.sendMessage(chatId, 'ℹ️ *Formato para registrar personal:*\n`/staff [Telegram_ID] [Nombre] [STAFF o ADMIN]`\n\nEjemplo:\n`/staff 987654321 Kevin STAFF`', { parse_mode: 'Markdown' });
        return;
      }

      const staffId = parseInt(args[0], 10);
      const staffRole = args[args.length - 1].toUpperCase();
      const staffName = args.slice(1, args.length - 1).join(' ');

      if (isNaN(staffId) || !['ADMIN', 'STAFF'].includes(staffRole)) {
        await bot.sendMessage(chatId, '❌ ID de Telegram o rol inválido (debe ser ADMIN o STAFF).');
        return;
      }

      try {
        await registerStaffUser({
          telegramId: staffId,
          fullName: staffName,
          role: staffRole,
          adminId: userId
        });
        await bot.sendMessage(chatId, `✅ *Personal autorizado con éxito:*\n• ${staffName} (ID: ${staffId})\n• Rol: *${staffRole}*`, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error registrando staff:', err);
        await bot.sendMessage(chatId, '❌ Error al autorizar personal.');
      }
      return;
    }

    // Comando /cerrar_turno
    if (cmd === '/cerrar_turno') {
      const summary = await getShiftCashReport();
      const efectivoTeorico = summary.efectivo_teorico_en_caja;

      let msgCierre = `🏁 *Cuadre de Caja — Turno Actual*\n` +
        `• Ventas Efectivo: S/ ${summary.total_ventas_efectivo.toFixed(2)}\n` +
        `• Ventas Digital (Yape/Plin): S/ ${summary.total_ventas_digital.toFixed(2)}\n` +
        `• Compras Efectivo: -S/ ${summary.total_compras_efectivo.toFixed(2)}\n` +
        `• Gastos Caja Chica: -S/ ${summary.total_gastos_efectivo.toFixed(2)}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💵 *Efectivo Teórico en Gaveta:* **S/ ${efectivoTeorico.toFixed(2)}**\n\n` +
        `_Cuenta el efectivo físico en gaveta y verifica que coincida con el valor teórico._`;

      await bot.sendMessage(chatId, msgCierre, { parse_mode: 'Markdown' });
      return;
    }

    // Comando /balance (Solo Admin)
    if (cmd === '/balance') {
      if (role !== 'ADMIN') {
        await bot.sendMessage(chatId, '🔒 Acción restringida. Este reporte financiero es exclusivo para la administración.');
        return;
      }
      const summary = await getShiftCashReport();
      const items = await getKardexSummary();
      const totalValorStock = items.reduce((acc, it) => acc + (parseFloat(it.total_value) || 0), 0);

      const balMsg = `📊 *Balance Financiero del Negocio*\n\n` +
        `📥 *Ventas Totales Hoy:* S/ ${(summary.total_ventas_efectivo + summary.total_ventas_digital).toFixed(2)}\n` +
        `💸 *Salidas de Dinero Hoy:* S/ ${(summary.total_compras_efectivo + summary.total_gastos_efectivo).toFixed(2)}\n` +
        `💵 *Efectivo Neto en Caja:* S/ ${summary.efectivo_teorico_en_caja.toFixed(2)}\n` +
        `📦 *Activo en Inventario (Kardex):* S/ ${totalValorStock.toFixed(2)}`;

      await bot.sendMessage(chatId, balMsg, { parse_mode: 'Markdown' });
      return;
    }

    // Comando /exportar_contable (Solo Admin)
    if (cmd === '/exportar_contable') {
      if (role !== 'ADMIN') {
        await bot.sendMessage(chatId, '🔒 Acción restringida. La exportación de libros de trabajo es exclusiva para la administración.');
        return;
      }

      await bot.sendMessage(chatId, '⏳ Generando sábana de revisión para el contador...');
      try {
        const monthArg = args[0]; // Puede pasar '2026-09'
        const { filename, content } = await generateAccountingWorksheet(monthArg);

        await bot.sendDocument(chatId, Buffer.from(content, 'utf-8'), {
          caption: '📑 *Archivo de Trabajo para Revisión Contable*\nIncluye compras con base e IGV preliminar, ventas y Kardex valorizado con diccionario de campos.',
          parse_mode: 'Markdown'
        }, {
          filename,
          contentType: 'text/csv'
        });
      } catch (err) {
        console.error('Error exportando sábana contable:', err);
        await bot.sendMessage(chatId, '❌ Error generando el archivo contable.');
      }
      return;
    }
  }

  // --- MANEJO DE COMPRA DE STOCK (Kardex) ---
  if (parsed.type === 'COMPRA_STOCK') {
    const product = await findProduct(parsed.productName);
    if (!product) {
      await bot.sendMessage(chatId, `⚠️ Producto *"${parsed.productName}"* no encontrado en el catálogo.\nEl administrador debe agregarlo primero con:\n\`/producto [SKU] ${parsed.productName} [Precio] [Costo]\``, { parse_mode: 'Markdown' });
      return;
    }

    // Generar confirmación previa estructurada con botones
    const pendingId = `p_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    pendingConfirmations.set(pendingId, {
      type: 'STOCK_PURCHASE',
      product,
      quantity: parsed.quantity,
      totalAmount: parsed.totalAmount,
      rawText: parsed.rawText,
      userId,
      timestamp: Date.now()
    });

    const confirmMsg = `📦 *Confirmación de Compra de Inventario:*\n` +
      `• *Producto:* ${product.name} (${product.sku})\n` +
      `• *Cantidad:* +${parsed.quantity} ${product.unit}\n` +
      `• *Total:* S/ ${parsed.totalAmount.toFixed(2)} (Costo unit.: S/ ${parsed.unitCost.toFixed(2)})\n\n` +
      `¿Qué comprobante sustenta esta adquisición?`;

    await bot.sendMessage(chatId, confirmMsg, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📄 Factura con RUC', callback_data: `tax:${pendingId}:FACTURA` },
            { text: '🧾 Boleta', callback_data: `tax:${pendingId}:BOLETA` }
          ],
          [
            { text: '📝 Sin Comprobante', callback_data: `tax:${pendingId}:SIN_COMPROBANTE` },
            { text: '❌ Cancelar', callback_data: `tax:${pendingId}:CANCEL` }
          ]
        ]
      }
    });
    return;
  }

  // --- MANEJO DE VENTA DE STOCK (Kardex) ---
  if (parsed.type === 'VENTA_STOCK') {
    const product = await findProduct(parsed.productName);
    if (!product) {
      await bot.sendMessage(chatId, `⚠️ Producto *"${parsed.productName}"* no encontrado en el catálogo de ventas.`, { parse_mode: 'Markdown' });
      return;
    }

    try {
      const res = await recordStockSale({
        product,
        quantity: parsed.quantity,
        totalAmount: parsed.totalAmount,
        paymentMethod: 'Efectivo',
        userId,
        rawText: parsed.rawText
      });

      const alertStock = res.isLowStock ? `\n⚠️ *Alerta: Quedan solo ${res.newStock} ${product.unit} en stock.*` : '';
      const saleMsg = `✅ *Venta registrada:* ${res.quantity} ${product.unit} ${res.productName}\n` +
        `💰 Total: S/ ${res.totalAmount.toFixed(2)} (Efectivo)\n` +
        `📦 Stock restante: ${res.newStock} ${product.unit}${alertStock}`;

      await bot.sendMessage(chatId, saleMsg, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ Deshacer venta', callback_data: `undo:${userId}` }]
          ]
        }
      });
    } catch (err) {
      console.error('Error registrando venta:', err);
      await bot.sendMessage(chatId, '❌ Error al registrar la venta en Kardex.');
    }
    return;
  }

  // --- MANEJO DE GASTO GENERAL DE CAJA CHICA ---
  if (parsed.type === 'GASTO_CAJA') {
    const pendingId = `g_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    pendingConfirmations.set(pendingId, {
      type: 'CASH_EXPENSE',
      amount: parsed.totalAmount,
      description: parsed.description,
      rawText: parsed.rawText,
      userId,
      timestamp: Date.now()
    });

    const confirmMsg = `💸 *Gasto de Caja Chica detectado:*\n` +
      `• *Concepto:* "${parsed.description}"\n` +
      `• *Monto:* S/ ${parsed.totalAmount.toFixed(2)}\n\n` +
      `¿Qué comprobante respalda este gasto?`;

    await bot.sendMessage(chatId, confirmMsg, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📄 Factura con RUC', callback_data: `tax:${pendingId}:FACTURA` },
            { text: '🧾 Boleta', callback_data: `tax:${pendingId}:BOLETA` }
          ],
          [
            { text: '📝 Sin Comprobante', callback_data: `tax:${pendingId}:SIN_COMPROBANTE` },
            { text: '❌ Cancelar', callback_data: `tax:${pendingId}:CANCEL` }
          ]
        ]
      }
    });
    return;
  }
}

/**
 * Manejador de Botones Interactivos (Callback Queries)
 */
export async function handleB2BCallbackQuery(bot, callbackQuery) {
  const data = callbackQuery.data;
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const clickUserId = callbackQuery.from.id;

  if (data.startsWith('tax:')) {
    const [, pendingId, voucherType] = data.split(':');
    const pending = pendingConfirmations.get(pendingId);

    if (voucherType === 'CANCEL') {
      pendingConfirmations.delete(pendingId);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Operación cancelada.' });
      await bot.editMessageText('❌ *Operación cancelada.* Ningún dato fue registrado en Kardex ni en Caja.', {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'Markdown'
      });
      return;
    }

    if (!pending) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'La solicitud expiró. Escribe la operación nuevamente.', show_alert: true });
      return;
    }

    try {
      if (pending.type === 'STOCK_PURCHASE') {
        const result = await recordStockPurchase({
          product: pending.product,
          quantity: pending.quantity,
          totalAmount: pending.totalAmount,
          voucherType,
          userId: clickUserId,
          rawText: pending.rawText
        });

        pendingConfirmations.delete(pendingId);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '¡Compra registrada con éxito!' });

        const taxNote = voucherType === 'FACTURA' 
          ? `\n📊 Base: S/ ${result.base.toFixed(2)} | IGV (Crédito Fiscal preliminar): S/ ${result.igv.toFixed(2)}`
          : `\nℹ️ Registrado como ${voucherType} (sin crédito fiscal).`;

        const finalMsg = `✅ *Compra Guardada:* +${pending.quantity} ${result.unit} ${result.productName}\n` +
          `💰 Total: S/ ${result.total.toFixed(2)} [${voucherType}]\n` +
          `📦 Nuevo Stock en Kardex: ${result.newStock} ${result.unit}${taxNote}`;

        await bot.editMessageText(finalMsg, {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '❌ Deshacer registro', callback_data: `undo:${clickUserId}` }]
            ]
          }
        });
      } else if (pending.type === 'CASH_EXPENSE') {
        const result = await recordCashExpense({
          amount: pending.amount,
          description: pending.description,
          voucherType,
          userId: clickUserId,
          rawText: pending.rawText
        });

        pendingConfirmations.delete(pendingId);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Gasto guardado.' });

        const finalMsg = `✅ *Gasto de Caja Chica guardado:*\n` +
          `• Concepto: "${result.description}"\n` +
          `• Total: S/ ${result.total.toFixed(2)} [${voucherType}]\n` +
          (voucherType === 'FACTURA' ? `• Base: S/ ${result.base.toFixed(2)} | IGV: S/ ${result.igv.toFixed(2)}` : '');

        await bot.editMessageText(finalMsg, {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '❌ Deshacer gasto', callback_data: `undo:${clickUserId}` }]
            ]
          }
        });
      }
    } catch (err) {
      console.error('Error ejecutando confirmación:', err);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Error al procesar la operación.', show_alert: true });
    }
    return;
  }

  // Deshacer última transacción
  if (data.startsWith('undo:')) {
    const [, targetUserId] = data.split(':');
    if (clickUserId.toString() !== targetUserId.toString()) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Solo la persona que registró el movimiento puede deshacerlo.', show_alert: true });
      return;
    }

    try {
      const undone = await undoLastTransaction(clickUserId);
      if (undone) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Transacción anulada y stock revertido.' });
        await bot.editMessageText(`🗑️ *Movimiento Anulado:*\nSe revirtió la operación de S/ ${undone.total_amount} ("${undone.description}").`, {
          chat_id: chatId,
          message_id: msg.message_id,
          parse_mode: 'Markdown'
        });
      } else {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'No hay movimientos recientes para anular.', show_alert: true });
      }
    } catch (err) {
      console.error('Error al deshacer:', err);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Error al anular transacción.', show_alert: true });
    }
  }
}
