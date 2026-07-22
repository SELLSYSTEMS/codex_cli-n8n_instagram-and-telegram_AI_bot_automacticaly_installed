import crypto from 'node:crypto';
import pg from 'pg';
import { loadEnv, requiredEnv, brainHeaders, jsonRequest, assert } from './runtime-env.mjs';

loadEnv();
requiredEnv(['BRAIN_API_URL', 'BRAIN_API_TOKEN', 'BRAIN_TENANT_KEY', 'LOCAL_POSTGRES_URL']);
const base = process.env.BRAIN_API_URL.replace(/\/$/, '');
const health = await jsonRequest(base + '/health');
assert(health.status === 'ok' || health.ok === true, 'Brain health is not OK');

const suffix = crypto.randomUUID();
const payload = {
  tenant_key: process.env.BRAIN_TENANT_KEY,
  channel: 'internal_test',
  external_user_id: 'smoke-' + suffix,
  external_thread_id: 'smoke-' + suffix,
  external_message_id: 'message-' + suffix,
  text: 'Hello. In one natural sentence, tell me how you would begin understanding a new client need.',
  display_name: 'Smoke test',
  metadata: { test: true },
};
const first = await jsonRequest(base + '/v1/messages', { method: 'POST', headers: brainHeaders(), body: JSON.stringify(payload) });
assert(first.should_reply === true, 'Brain did not approve a normal reply');
assert(typeof first.reply === 'string' && first.reply.trim().length > 10, 'Brain returned no useful reply');
const duplicate = await jsonRequest(base + '/v1/messages', { method: 'POST', headers: brainHeaders(), body: JSON.stringify(payload) });

const pool = new pg.Pool({ connectionString: process.env.LOCAL_POSTGRES_URL });
const count = await pool.query('select count(*)::int as count from agent.messages where external_message_id = $1', [payload.external_message_id]);
await pool.end();
assert(count.rows[0].count === 1, 'Inbound idempotency failed');
assert(duplicate.duplicate === true || duplicate.idempotent === true || duplicate.should_reply === false || duplicate.reply === first.reply, 'Duplicate response was not idempotent');

console.log(JSON.stringify({ health: 'ok', reply_chars: first.reply.length, idempotency: 'ok', model: first.model ?? null, provider: first.provider ?? null }, null, 2));
