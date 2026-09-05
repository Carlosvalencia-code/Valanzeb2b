/**
 * Valanze B2B — Endpoint Serverless Webhook para Vercel
 * Incluye validación de token secreto e idempotencia estricta
 */

import TelegramBot from 'node-telegram-bot-api';
import { handleB2BMessage, handleB2BCallbackQuery } from '../lib/botLogic.js';
import { checkIdempotency } from '../lib/db.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  // 1. Seguridad: Validar token secreto de Telegram
  const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
  const expectedSecret = process.env.TELEGRAM_SECRET_TOKEN;
  if (expectedSecret && secretHeader !== expectedSecret) {
    console.warn('[Security] Intento de acceso no autorizado al webhook B2B');
    return res.status(401).send('Unauthorized');
  }

  try {
    const update = req.body;
    if (!update || typeof update !== 'object') {
      return res.status(400).send('Invalid Body');
    }

    // 2. Idempotencia: Verificar que el update_id no haya sido procesado previamente
    if (update.update_id) {
      const isNew = await checkIdempotency(update.update_id);
      if (!isNew) {
        // Ya fue procesado en un reintento anterior. Responder 200 para frenar el retry de Telegram.
        return res.status(200).send('Duplicate Skipped');
      }
    }

    // 3. Despacho de Eventos
    if (update.message) {
      await handleB2BMessage(bot, update.message);
    } else if (update.callback_query) {
      await handleB2BCallbackQuery(bot, update.callback_query);
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('[Webhook Error]', error);
    return res.status(500).send('Internal Error');
  }
}
