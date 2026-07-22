import fs from 'node:fs/promises';
import pg from 'pg';
import { loadEnv, requiredEnv, brainHeaders, jsonRequest, assert } from './runtime-env.mjs';

loadEnv();
requiredEnv(['BRAIN_API_URL', 'BRAIN_API_TOKEN', 'N8N_BASE_URL', 'N8N_API_KEY', 'LOCAL_POSTGRES_URL', 'TELEGRAM_BOT_TOKEN']);
const brain = await jsonRequest(process.env.BRAIN_API_URL.replace(/\/$/, '') + '/health', { headers: brainHeaders() });
assert(brain.status === 'ok' || brain.ok === true, 'Brain is not healthy');

const n8n = process.env.N8N_BASE_URL.replace(/\/$/, '') + '/api/v1';
const workflows = await jsonRequest(n8n + '/workflows?limit=250', { headers: { 'X-N8N-API-KEY': process.env.N8N_API_KEY } });
const expectedChannels = ['Channel - Instagram - Shared AI Brain', 'Channel - WhatsApp - Shared AI Brain', 'Channel - Telegram - Shared AI Brain'];
for (const name of expectedChannels) {
  const item = (workflows.data ?? []).find((candidate) => candidate.name === name);
  assert(item?.active === true, name + ' is not active');
}

const templates = [];
for (const filename of await fs.readdir('workflows/generated')) {
  if (!filename.endsWith('.json')) continue;
  const text = await fs.readFile('workflows/generated/' + filename, 'utf8');
  templates.push(text);
  assert(!/sk-proj-|EAA[A-Za-z0-9]|\d{8,10}:[A-Za-z0-9_-]{20,}/.test(text), filename + ' appears to contain a real credential');
}

const pool = new pg.Pool({ connectionString: process.env.LOCAL_POSTGRES_URL });
const schema = await pool.query("select count(*)::int as count from information_schema.tables where table_schema = 'agent'");
const vector = await pool.query("select count(*)::int as count from pg_extension where extname = 'vector'");
const counts = await pool.query('select (select count(*)::int from agent.knowledge_documents) as documents, (select count(*)::int from agent.knowledge_chunks) as chunks, (select count(*)::int from agent.messages) as messages');
await pool.end();
assert(schema.rows[0].count >= 8, 'Agent schema is incomplete');
assert(vector.rows[0].count === 1, 'pgvector is not installed');
assert(counts.rows[0].chunks > 0, 'Knowledge base has no chunks');

const telegram = await jsonRequest('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/getWebhookInfo');
assert(telegram.ok === true && telegram.result?.url?.endsWith('/webhook/telegram-rag-webhook'), 'Telegram webhook is not configured');

console.log(JSON.stringify({
  brain: 'healthy',
  n8n_workflows: (workflows.data ?? []).length,
  active_channels: expectedChannels,
  postgres_tables: schema.rows[0].count,
  knowledge_documents: counts.rows[0].documents,
  knowledge_chunks: counts.rows[0].chunks,
  stored_messages: counts.rows[0].messages,
  public_templates: templates.length,
  telegram_webhook: 'configured',
}, null, 2));
