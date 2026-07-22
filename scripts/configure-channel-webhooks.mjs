import crypto from 'node:crypto';
import { loadEnv, requiredEnv, jsonRequest, assert } from './runtime-env.mjs';

loadEnv();
requiredEnv([
  'N8N_BASE_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET',
  'IG_WEBHOOK_VERIFY_TOKEN', 'IG_ACCESS_TOKEN', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID',
]);

const publicBase = process.env.N8N_BASE_URL.replace(/\/$/, '');
const telegramBase = 'https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN;
const telegramWebhook = publicBase + '/webhook/telegram-rag-webhook';
const setWebhook = await jsonRequest(telegramBase + '/setWebhook', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url: telegramWebhook,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'edited_message'],
    drop_pending_updates: false,
  }),
});
assert(setWebhook.ok === true, 'Telegram rejected setWebhook');
const telegramMe = await jsonRequest(telegramBase + '/getMe');
const telegramInfo = await jsonRequest(telegramBase + '/getWebhookInfo');
assert(telegramInfo.result?.url === telegramWebhook, 'Telegram webhook URL did not persist');

async function verifyMeta(pathname, token) {
  const challenge = crypto.randomBytes(12).toString('hex');
  const url = new URL(publicBase + '/webhook/' + pathname);
  url.searchParams.set('hub.mode', 'subscribe');
  url.searchParams.set('hub.verify_token', token);
  url.searchParams.set('hub.challenge', challenge);
  const response = await fetch(url);
  const text = await response.text();
  assert(response.ok && text === challenge, pathname + ' verification callback failed with HTTP ' + response.status);
  return true;
}

await verifyMeta('instagram-rag-webhook', process.env.IG_WEBHOOK_VERIFY_TOKEN);
await verifyMeta('whatsapp-rag-webhook', process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN);

const igVersion = process.env.IG_GRAPH_API_VERSION || 'v25.0';
const igUrl = new URL('https://graph.instagram.com/' + igVersion + '/me');
igUrl.searchParams.set('fields', 'id,user_id,username,account_type');
igUrl.searchParams.set('access_token', process.env.IG_ACCESS_TOKEN);
const instagram = await jsonRequest(igUrl.toString());

const waVersion = process.env.WHATSAPP_GRAPH_API_VERSION || 'v25.0';
const whatsapp = await jsonRequest('https://graph.facebook.com/' + waVersion + '/' + process.env.WHATSAPP_PHONE_NUMBER_ID + '?fields=id,display_phone_number,verified_name,quality_rating', {
  headers: { authorization: 'Bearer ' + process.env.WHATSAPP_ACCESS_TOKEN },
});

console.log(JSON.stringify({
  telegram: { username: telegramMe.result?.username, webhook: telegramInfo.result?.url, pending_updates: telegramInfo.result?.pending_update_count },
  instagram: { id: instagram.id, username: instagram.username, account_type: instagram.account_type, callback_verified: true },
  whatsapp: { id: whatsapp.id, display_phone_number: whatsapp.display_phone_number, quality_rating: whatsapp.quality_rating, callback_verified: true },
}, null, 2));
