import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { runBrain } from './instrumented-brain-graph.mjs';
import {
  dbHealth,
  resetEscalation,
  linkIdentities,
  getContactState,
  replaceKnowledge,
  closeDatabase,
} from './db.mjs';
import { getModelRoutes, setModelRoutes } from './model-router.mjs';
import { chunkText, sha256 } from './knowledge.mjs';

function normalizeKnowledge(input) {
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  const sourceKey = String(
    input.source_key || input.sourceKey || input.source_path || input.sourcePath || ''
  ).trim();
  const tenantKey = String(
    input.tenant_key || input.tenantKey || process.env.BRAIN_TENANT_KEY || 'default'
  ).trim();

  if (!content || !sourceKey || !tenantKey) {
    throw new Error('tenant_key, source_key/source_path and content are required');
  }

  const chunks = chunkText(content);
  if (!chunks.length) throw new Error('Knowledge content produced no chunks');

  return {
    tenantKey,
    tenantName:
      input.tenant_name ||
      input.tenantName ||
      process.env.BRAIN_TENANT_NAME ||
      tenantKey,
    sourceKey,
    title: String(input.title || sourceKey),
    contentHash: sha256(content),
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    chunks,
  };
}

const host = process.env.BRAIN_HOST || '127.0.0.1';
const port = Number(process.env.BRAIN_PORT || 8789);
const apiToken = process.env.BRAIN_API_TOKEN || '';
const adminToken = process.env.BRAIN_ADMIN_TOKEN || '';

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function secureEqual(actual, expected) {
  const a = Buffer.from(actual || '');
  const b = Buffer.from(expected || '');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function bearer(req) {
  const value = req.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function authorized(req, admin = false) {
  return secureEqual(bearer(req), admin ? adminToken : apiToken);
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function normalizeMessage(input) {
  if (!input.channel || !input.external_user_id || !input.external_message_id || typeof input.text !== 'string') {
    throw new Error('channel, external_user_id, external_message_id and text are required');
  }
  return {
    tenantKey: input.tenant_key || process.env.BRAIN_TENANT_KEY || 'default',
    tenantName: input.tenant_name || process.env.BRAIN_TENANT_NAME || 'Default tenant',
    channel: String(input.channel),
    channelAccountId: String(input.channel_account_id || 'default'),
    externalUserId: String(input.external_user_id),
    externalThreadId: String(input.external_thread_id || input.external_user_id),
    externalMessageId: String(input.external_message_id),
    displayName: input.display_name ? String(input.display_name) : null,
    text: input.text,
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      const database = await dbHealth();
      send(res, 200, { ok: true, service: 'local-conversational-brain', database, models: await getModelRoutes() });
      return;
    }

    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
      send(res, 200, await runBrain(normalizeMessage(await body(req))));
      return;
    }

    if (url.pathname === '/v1/admin/model-routes' && req.method === 'GET') {
      if (!authorized(req, true)) return send(res, 401, { error: 'unauthorized' });
      send(res, 200, await getModelRoutes());
      return;
    }

    if (url.pathname === '/v1/admin/model-routes' && req.method === 'PUT') {
      if (!authorized(req, true)) return send(res, 401, { error: 'unauthorized' });
      send(res, 200, await setModelRoutes(await body(req)));
      return;
    }

    if (url.pathname === '/v1/admin/escalations/reset' && req.method === 'POST') {
      if (!authorized(req, true)) return send(res, 401, { error: 'unauthorized' });
      const input = await body(req);
  send(res, 200, await resetEscalation({
    tenantKey: input.tenant_key ?? input.tenantKey,
    conversationId: input.conversation_id ?? input.conversationId,
    channel: input.channel,
    externalThreadId: input.external_thread_id ?? input.externalThreadId ?? input.external_user_id ?? input.externalUserId,
  }));
      return;
    }

    if (url.pathname === '/v1/admin/identities/link' && req.method === 'POST') {
      if (!authorized(req, true)) return send(res, 401, { error: 'unauthorized' });
      send(res, 200, await linkIdentities(await body(req)));
      return;
    }

    if (url.pathname === '/v1/admin/contact-state' && req.method === 'POST') {
      if (!authorized(req, true)) return send(res, 401, { error: 'unauthorized' });
      send(res, 200, await getContactState(await body(req)));
      return;
    }

      if (url.pathname === '/v1/admin/knowledge' && req.method === 'POST') {
        if (!authorized(req, true)) return send(res, 401, { error: 'unauthorized' });
        send(res, 200, await replaceKnowledge(normalizeKnowledge(await body(req))));
        return;
      }

    send(res, 404, { error: 'not found' });
  } catch (error) {
    console.error(error);
    send(res, 500, { error: String(error?.message || error) });
  }
});

server.listen(port, host, () => {
  console.log('brain service listening on http://' + host + ':' + port);
});

async function shutdown() {
  server.close();
  await closeDatabase();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
