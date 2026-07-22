import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnv, requiredEnv, jsonRequest } from './runtime-env.mjs';

loadEnv();
requiredEnv([
  'N8N_BASE_URL', 'N8N_API_KEY', 'BRAIN_API_URL', 'BRAIN_API_TOKEN', 'BRAIN_ADMIN_TOKEN', 'BRAIN_TENANT_KEY',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'IG_WEBHOOK_VERIFY_TOKEN', 'IG_ACCESS_TOKEN', 'IG_API_USER_ID',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID',
]);

const replacements = {
  __BRAIN_API_URL__: process.env.BRAIN_API_URL,
  __BRAIN_API_TOKEN__: process.env.BRAIN_API_TOKEN,
  __BRAIN_ADMIN_TOKEN__: process.env.BRAIN_ADMIN_TOKEN,
  __BRAIN_TENANT_KEY__: process.env.BRAIN_TENANT_KEY,
  __TELEGRAM_BOT_TOKEN__: process.env.TELEGRAM_BOT_TOKEN,
  __TELEGRAM_WEBHOOK_SECRET__: process.env.TELEGRAM_WEBHOOK_SECRET,
  __IG_WEBHOOK_VERIFY_TOKEN__: process.env.IG_WEBHOOK_VERIFY_TOKEN,
  __IG_ACCESS_TOKEN__: process.env.IG_ACCESS_TOKEN,
  __IG_API_USER_ID__: process.env.IG_API_USER_ID,
  __IG_GRAPH_API_VERSION__: process.env.IG_GRAPH_API_VERSION || 'v25.0',
  __WHATSAPP_WEBHOOK_VERIFY_TOKEN__: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  __WHATSAPP_ACCESS_TOKEN__: process.env.WHATSAPP_ACCESS_TOKEN,
  __WHATSAPP_PHONE_NUMBER_ID__: process.env.WHATSAPP_PHONE_NUMBER_ID,
  __WHATSAPP_GRAPH_API_VERSION__: process.env.WHATSAPP_GRAPH_API_VERSION || 'v25.0',
};

function materialize(value) {
  if (typeof value === 'string') {
    let output = value;
    for (const [marker, replacement] of Object.entries(replacements)) output = output.split(marker).join(replacement);
    return output;
  }
  if (Array.isArray(value)) return value.map(materialize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materialize(item)]));
  return value;
}

function workflowWritePayload(workflow) {
  const writableFields = ['name', 'nodes', 'connections', 'settings', 'staticData'];
  return Object.fromEntries(
    writableFields
      .filter((field) => workflow[field] !== undefined)
      .map((field) => [field, workflow[field]]),
  );
}

const base = process.env.N8N_BASE_URL.replace(/\/$/, '') + '/api/v1';
const headers = { 'X-N8N-API-KEY': process.env.N8N_API_KEY, 'content-type': 'application/json' };
const listing = await jsonRequest(base + '/workflows?limit=250', { headers });
const existing = new Map((listing.data ?? []).map((item) => [item.name, item]));
const directory = path.resolve('workflows/generated');
const files = (await fs.readdir(directory)).filter((name) => name.endsWith('.json')).sort();
const deployed = [];

for (const filename of files) {
  const template = JSON.parse(await fs.readFile(path.join(directory, filename), 'utf8'));
  const payload = workflowWritePayload(materialize(template));
  const current = existing.get(payload.name);
  const saved = current
    ? await jsonRequest(base + '/workflows/' + current.id, { method: 'PUT', headers, body: JSON.stringify(payload) })
    : await jsonRequest(base + '/workflows', { method: 'POST', headers, body: JSON.stringify(payload) });
  const shouldActivate = payload.name.startsWith('Channel - ');
  if (shouldActivate) {
    await jsonRequest(base + '/workflows/' + saved.id + '/activate', { method: 'POST', headers });
  } else if (saved.active) {
    await jsonRequest(base + '/workflows/' + saved.id + '/deactivate', { method: 'POST', headers });
  }
  deployed.push({ id: saved.id, name: payload.name, active: shouldActivate });
}

console.log(JSON.stringify({ deployed }, null, 2));
