/**
 * Valanze B2B — Runner Local en Modo Polling (Desarrollo y Pruebas)
 */

import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { handleB2BMessage, handleB2BCallbackQuery } from './lib/botLogic.js';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token || token.includes('your-telegram-token')) {
  console.error('❌ ERROR: TELEGRAM_BOT_TOKEN no configurado en el archivo .env.');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

console.log('🤖 Valanze B2B está activo en modo LOCAL (Polling)...');
console.log('📦 Listo para registrar compras, ventas, Kardex y arqueos de caja.');

bot.on('message', async (msg) => {
  await handleB2BMessage(bot, msg);
});

bot.on('callback_query', async (callbackQuery) => {
  await handleB2BCallbackQuery(bot, callbackQuery);
});
