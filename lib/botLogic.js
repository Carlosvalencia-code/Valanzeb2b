/**
 * Valanze B2B — Orquestador de Mensajes y Lógica de Negocio
 * Experiencia de usuario simplificada, lenguaje directo sin jerga y confirmaciones estructuradas
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
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, item] of pendingConfirmations.entries()) {
    if (now - item.timestamp > 15 * 60 * 1000) {
      pendingConfirmations.delete(id);
    }
  }
}, 5 * 60 * 1000);
if (cleanupInterval.unref) cleanupInterval.unref();

export async function handleB2BMessage(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = msg.text;

  if (!text || !userId) return;

  // 1. Verificación de Rol y Seguridad
  const { role, user } = await getUserRole(userId);
  if (role === 'UNKNOWN' && !text.startsWith('/start')) {
    await bot.sendMessage(chatId, '🔒 *Acceso no registrado*\nEste canal es para uso interno del negocio. Pide al dueño o administrador que te registre con tu ID de Telegram.', { parse_mode: 'Markdown' });
    return;
  }

  // 2. Parseo de intención
  const parsed = parseB2BMessage(text);
  if (!parsed) {
    await bot.sendMessage(chatId, '🤔 No logré entender la operación.\nPuedes escribir algo como:\n• Compra: `+24 sixpack cristal 96`\n• Venta: `venta 2 sixpack cristal`\n• Gasto: `15 pasajes mercado`\n• Ver inventario: /stock', { parse_mode: 'Markdown' });
    return;
  }

  // --- MANEJO DE COMANDOS ---
  if (parsed.type === 'COMMAND') {
    const cmd = parsed.command;
    const args = parsed.args;
    const isAdmin = role === 'ADMIN';

    // Comando /start
    if (cmd === '/start') {
      const welcome = `👋 *Hola, soy Valanze Negocios.*\n` +
        `Llevo la cuenta de tu mercadería y el dinero de tu caja, sin planillas complicadas ni computadoras en el mostrador.\n\n` +
        `✍️ *¿Cómo se usa en el día a día?*\n` +
        `Solo escríbeme lo que pasa en tu local:\n` +
        `• *Si compraste mercadería:* \`+24 sixpack cristal 96\`\n` +
        `• *Si vendiste algo:* \`venta 2 sixpack cristal\`\n` +
        `• *Si gastaste de caja chica:* \`15 pasajes mercado\`\n\n` +
        `📋 *Tus herramientas:*\n` +
        `• /stock — cuánta mercadería te queda\n` +
        `• /caja — cuánto dinero en efectivo debe haber hoy\n` +
        (isAdmin ? `• /producto — agregar un producto nuevo a tu lista\n• /equipo — permitir que un empleado use el bot\n• /balance — resumen de ganancias y ventas\n• /excel — descargar el reporte del mes para tu contador` : '');

      await bot.sendMessage(chatId, welcome, { parse_mode: 'Markdown' });
      return;
    }

    // Comando /stock o /kardex
    if (cmd === '/stock' || cmd === '/kardex') {
      try {
        const items = await getKardexSummary();
        if (!items || items.length === 0) {
          const emptyMsg = `📦 *Tu lista de productos todavía está vacía.*\n\n` +
            `Para empezar, agrega tu primer producto así:\n` +
            `/producto CRISTAL-6 Sixpack Cristal 18.00 12.00\n\n` +
            `_(Donde 18.00 es el precio al que vendes y 12.00 es lo que te cuesta a ti)._`;
          await bot.sendMessage(chatId, emptyMsg, { parse_mode: 'Markdown' });
          return;
        }

        let msgStock = `📦 *Mercadería e Inventario Actual*\n\n`;
        let totalValor = 0;

        items.forEach(it => {
          const alert = it.is_low_stock ? ' ⚠️ *(Poco Stock)*' : '';
          msgStock += `• *${it.product_name}*: ${it.stock} ${it.unit} · Costo prom.: S/ ${parseFloat(it.avg_cost).toFixed(2)}${alert}\n`;
          totalValor += parseFloat(it.total_value) || 0;
        });

        if (isAdmin) {
          msgStock += `\n💰 *Valor Total de tu Mercadería:* S/ ${totalValor.toFixed(2)}`;
        }

        await bot.sendMessage(chatId, msgStock, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error en /stock:', err);
        await bot.sendMessage(chatId, '❌ Error al consultar el inventario.');
      }
      return;
    }

    // Comando /producto o /nuevo_producto (Solo Admin)
    if (cmd === '/producto' || cmd === '/nuevo_producto') {
      if (!isAdmin) {
        await bot.sendMessage(chatId, '🔒 Solo el Administrador puede agregar o modificar productos en la lista.');
        return;
      }

      // Sintaxis: /producto SKU Nombre Precio Venta Costo
      if (args.length < 4) {
        const helpProd = `📦 *Para agregar un producto nuevo, escríbelo así:*\n` +
          `/producto [Código] [Nombre] [Precio de Venta] [Costo]\n\n` +
          `*Ejemplo:*\n` +
          `/producto CRISTAL-6 Sixpack Cristal 18.00 12.00\n\n` +
          `_(18.00 es tu precio al público y 12.00 es lo que te cobra el distribuidor)._`;
        await bot.sendMessage(chatId, helpProd, { parse_mode: 'Markdown' });
        return;
      }

      const sku = args[0].toUpperCase();
      const salePrice = parseFloat(args[args.length - 2]);
      const avgCost = parseFloat(args[args.length - 1]);
      const name = args.slice(1, args.length - 2).join(' ');

      if (isNaN(salePrice) || isNaN(avgCost) || !name) {
        await bot.sendMessage(chatId, '❌ Precios o nombre inválidos. Revisa que los números estén bien escritos.');
        return;
      }

      try {
        await upsertProduct({
          sku,
          name,
          category: 'General',
          unit: 'unid',
          salePrice,
          avgCost,
          currentStock: 0,
          minStock: 5,
          userId
        });
        await bot.sendMessage(chatId, `✅ *Producto agregado a tu lista:*\n• *${name}* (${sku})\n• Precio venta: S/ ${salePrice.toFixed(2)} | Costo: S/ ${avgCost.toFixed(2)}`, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error guardando producto:', err);
        await bot.sendMessage(chatId, '❌ Error al guardar el producto.');
      }
      return;
    }

    // Comando /equipo o /staff o /personal (Solo Admin)
    if (cmd === '/equipo' || cmd === '/staff' || cmd === '/personal') {
      if (!isAdmin) {
        await bot.sendMessage(chatId, '🔒 Solo el Administrador puede dar acceso a nuevos empleados.');
        return;
      }

      // Sintaxis: /equipo [telegram_id] [Nombre] [ADMIN|STAFF]
      if (args.length < 3) {
        const helpStaff = `👥 *Para dar acceso a un empleado, escribe:*\n` +
          `/equipo [ID_Telegram] [Nombre] [STAFF o ADMIN]\n\n` +
          `*Ejemplo:*\n` +
          `/equipo 987654321 Kevin STAFF\n\n` +
          `_(El empleado puede saber su ID enviando cualquier mensaje al bot @userinfobot en Telegram)._`;
        await bot.sendMessage(chatId, helpStaff, { parse_mode: 'Markdown' });
        return;
      }

      const staffId = parseInt(args[0], 10);
      const staffRole = args[args.length - 1].toUpperCase();
      const staffName = args.slice(1, args.length - 1).join(' ');

      if (isNaN(staffId) || !['ADMIN', 'STAFF'].includes(staffRole)) {
        await bot.sendMessage(chatId, '❌ ID de Telegram o rol inválido. Debe terminar en STAFF o ADMIN.');
        return;
      }

      try {
        await registerStaffUser({
          telegramId: staffId,
          fullName: staffName,
          role: staffRole,
          adminId: userId
        });
        await bot.sendMessage(chatId, `✅ *Empleado autorizado:*\n• ${staffName} (ID: ${staffId})\n• Rol: *${staffRole === 'ADMIN' ? 'Administrador' : 'Personal Operativo'}*`, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error registrando staff:', err);
        await bot.sendMessage(chatId, '❌ Error al autorizar al empleado.');
      }
      return;
    }

    // Comando /caja o /cierre o /cerrar_turno
    if (cmd === '/caja' || cmd === '/cierre' || cmd === '/cerrar_turno') {
      const summary = await getShiftCashReport();
      const efectivoTeorico = summary.efectivo_teorico_en_caja;

      let msgCierre = `🏁 *Cierre de Caja de Hoy*\n\n` +
        `• *Ventas en Efectivo:* S/ ${summary.total_ventas_efectivo.toFixed(2)}\n` +
        `• *Ventas por Yape / Plin:* S/ ${summary.total_ventas_digital.toFixed(2)}\n` +
        `• *Salidas / Gastos de Caja:* -S/ ${(summary.total_compras_efectivo + summary.total_gastos_efectivo).toFixed(2)}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💵 *Efectivo que debe haber en gaveta:* **S/ ${efectivoTeorico.toFixed(2)}**\n\n` +
        `_Cuenta el dinero físico que tienes en mano y confirma que coincida con este monto._`;

      await bot.sendMessage(chatId, msgCierre, { parse_mode: 'Markdown' });
      return;
    }

    // Comando /balance
    if (cmd === '/balance') {
      if (!isAdmin) {
        await bot.sendMessage(chatId, '🔒 Este reporte financiero es exclusivo para el dueño o administrador.');
        return;
      }
      const summary = await getShiftCashReport();
      const items = await getKardexSummary();
      const totalValorStock = items.reduce((acc, it) => acc + (parseFloat(it.total_value) || 0), 0);

      const balMsg = `📊 *Resumen Financiero del Negocio*\n\n` +
        `📥 *Ventas Totales Hoy:* S/ ${(summary.total_ventas_efectivo + summary.total_ventas_digital).toFixed(2)}\n` +
        `💸 *Gastos y Salidas Hoy:* S/ ${(summary.total_compras_efectivo + summary.total_gastos_efectivo).toFixed(2)}\n` +
        `💵 *Efectivo en Caja:* S/ ${summary.efectivo_teorico_en_caja.toFixed(2)}\n` +
        `📦 *Mercadería en Stock:* S/ ${totalValorStock.toFixed(2)}`;

      await bot.sendMessage(chatId, balMsg, { parse_mode: 'Markdown' });
      return;
    }

    // Comando /excel o /contador o /exportar_contable
    if (cmd === '/excel' || cmd === '/contador' || cmd === '/exportar_contable') {
      if (!isAdmin) {
        await bot.sendMessage(chatId, '🔒 La exportación del reporte es exclusiva para el dueño o administrador.');
        return;
      }

      await bot.sendMessage(chatId, '⏳ Generando archivo de trabajo para tu contador...');
      try {
        const monthArg = args[0]; // Puede pasar '2026-09'
        const { filename, content } = await generateAccountingWorksheet(monthArg);

        await bot.sendDocument(chatId, Buffer.from(content, 'utf-8'), {
          caption: '📑 *Reporte de Trabajo para el Contador*\nContiene compras con cálculo preliminar de IGV, ventas del mes y stock valorizado.',
          parse_mode: 'Markdown'
        }, {
          filename,
          contentType: 'text/csv'
        });
      } catch (err) {
        console.error('Error exportando sábana contable:', err);
        await bot.sendMessage(chatId, '❌ Error generando el archivo.');
      }
      return;
    }
  }

  // --- MANEJO DE COMPRA DE MERCADERÍA (Kardex) ---
  if (parsed.type === 'COMPRA_STOCK') {
    const product = await findProduct(parsed.productName);
    if (!product) {
      await bot.sendMessage(chatId, `⚠️ El producto *"${parsed.productName}"* no está en tu lista.\nEl administrador debe agregarlo primero escribiendo:\n\`/producto [Código] ${parsed.productName} [Precio] [Costo]\``, { parse_mode: 'Markdown' });
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

    const confirmMsg = `📦 *Anotando compra de mercadería:*\n` +
      `• *Producto:* ${product.name}\n` +
      `• *Cantidad:* +${parsed.quantity} ${product.unit}\n` +
      `• *Total pagado:* S/ ${parsed.totalAmount.toFixed(2)} _(S/ ${parsed.unitCost.toFixed(2)} c/u)_\n\n` +
      `¿Te dieron comprobante?`;

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

  // --- MANEJO DE VENTA DE MERCADERÍA (Kardex) ---
  if (parsed.type === 'VENTA_STOCK') {
    const product = await findProduct(parsed.productName);
    if (!product) {
      await bot.sendMessage(chatId, `⚠️ El producto *"${parsed.productName}"* no está registrado en tu lista.`, { parse_mode: 'Markdown' });
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

      const alertStock = res.isLowStock ? `\n⚠️ *Atención: Quedan solo ${res.newStock} en stock.*` : '';
      const saleMsg = `✅ *Listo. Venta anotada.*\n` +
        `${res.quantity} ${product.name} · S/ ${res.totalAmount.toFixed(2)} _(Quedan ${res.newStock} en stock)_${alertStock}`;

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
      await bot.sendMessage(chatId, '❌ Error al registrar la venta.');
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

    const confirmMsg = `💸 *Gasto de caja chica:*\n` +
      `• *Concepto:* "${parsed.description}"\n` +
      `• *Monto:* S/ ${parsed.totalAmount.toFixed(2)}\n\n` +
      `¿Te dieron comprobante?`;

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
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelado' });
      await bot.editMessageText('❌ *Operación cancelada.* No se guardó nada en caja ni en inventario.', {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'Markdown'
      });
      return;
    }

    if (!pending) {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'El tiempo expiró. Escribe la operación otra vez.', show_alert: true });
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
        await bot.answerCallbackQuery(callbackQuery.id, { text: '¡Guardado!' });

        const taxNote = voucherType === 'FACTURA' 
          ? `\n📊 Base: S/ ${result.base.toFixed(2)} | IGV (Crédito Fiscal preliminar): S/ ${result.igv.toFixed(2)}`
          : `\nℹ️ Sin crédito fiscal (${voucherType}).`;

        const finalMsg = `✅ *Listo. Compra anotada.*\n` +
          `+${pending.quantity} ${result.productName} · S/ ${result.total.toFixed(2)} [${voucherType}]\n` +
          `📦 Stock actual: ${result.newStock} ${result.unit}${taxNote}`;

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
        await bot.answerCallbackQuery(callbackQuery.id, { text: '¡Guardado!' });

        const finalMsg = `✅ *Listo. Gasto anotado.*\n` +
          `"${result.description}" · S/ ${result.total.toFixed(2)} [${voucherType}]\n` +
          (voucherType === 'FACTURA' ? `📊 Base: S/ ${result.base.toFixed(2)} | IGV: S/ ${result.igv.toFixed(2)}` : '');

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
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Solo quien registró el movimiento puede deshacerlo.', show_alert: true });
      return;
    }

    try {
      const undone = await undoLastTransaction(clickUserId);
      if (undone) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Movimiento anulado.' });
        await bot.editMessageText(`🗑️ *Movimiento anulado.*\nSe canceló la operación de S/ ${undone.total_amount} ("${undone.description}"). El stock y la caja fueron restaurados.`, {
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
