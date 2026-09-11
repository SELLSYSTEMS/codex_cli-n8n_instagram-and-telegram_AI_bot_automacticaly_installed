import { createHmac, timingSafeEqual } from 'node:crypto';

import { claimDelivery, completeDelivery } from './runtime-store.mjs';

const MAX_BODY_BYTES = 1024 * 1024;

function writeJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function badRequest(code) {
  const error = new Error(code);
  error.statusCode = 400;
  throw error;
}

function requiredString(value, code) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) badRequest(code);
  return normalized;
}

function optionalObject(value, code, fallback = {}) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'object' || Array.isArray(value)) badRequest(code);
  return value;
}

function decodeStrictBase64(value) {
  if (typeof value !== 'string' || !value) return null;
  if (
    value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request_body_too_large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('invalid_json');
    error.statusCode = 400;
    throw error;
  }
}

function secretForMetaProvider(provider, env = process.env) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized === 'whatsapp') {
    return env.WHATSAPP_APP_SECRET || env.META_APP_SECRET || '';
  }
  if (normalized === 'instagram') {
    return env.IG_APP_SECRET
      || env.IG_APP_SECRET_1
      || env.IG_APP_SECRET_2
      || env.INSTAGRAM_APP_SECRET
      || env.META_APP_SECRET
      || '';
  }
  return '';
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyMetaWebhook({ provider, signature, rawBodyBase64, env = process.env }) {
  const secret = secretForMetaProvider(provider, env);
  if (!secret) return { ok: false, code: 'meta_app_secret_not_configured' };
  if (!/^sha256=[a-f0-9]{64}$/i.test(String(signature || ''))) {
    return { ok: false, code: 'meta_signature_missing_or_malformed' };
  }
  if (typeof rawBodyBase64 !== 'string' || !rawBodyBase64) {
    return { ok: false, code: 'meta_raw_body_missing' };
  }

  const rawBody = decodeStrictBase64(rawBodyBase64);
  if (!rawBody) return { ok: false, code: 'meta_raw_body_invalid' };
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return safeEqual(signature.toLowerCase(), expected)
    ? { ok: true, code: 'verified' }
    : { ok: false, code: 'meta_signature_invalid' };
}

export function verifyTelegramWebhook({ suppliedToken, env = process.env }) {
  const expected = env.TELEGRAM_WEBHOOK_SECRET
    || env.TELEGRAM_WEBHOOK_SECRET_TOKEN
    || env.TELEGRAM_SECRET_TOKEN
    || '';
  if (!expected) return { ok: false, code: 'telegram_secret_not_configured' };
  return safeEqual(suppliedToken, expected)
    ? { ok: true, code: 'verified' }
    : { ok: false, code: 'telegram_secret_invalid' };
}

function deliveryClaimInput(body) {
  const input = {
    ...body,
    tenantId: body.tenantId ?? body.tenant_id,
    conversationId: body.conversationId ?? body.conversation_id,
    channel: body.channel,
    sourceInboundMessageId: body.sourceInboundMessageId ?? body.source_inbound_message_id,
    replyHash: body.replyHash ?? body.reply_hash,
    idempotencyKey: body.idempotencyKey ?? body.idempotency_key,
    payload: body.payload ?? body.delivery_payload ?? {},
  };
  return {
    ...input,
    tenantId: requiredString(input.tenantId, 'tenant_id_required'),
    conversationId: requiredString(input.conversationId, 'conversation_id_required'),
    channel: requiredString(input.channel, 'channel_required'),
    sourceInboundMessageId: requiredString(
      input.sourceInboundMessageId,
      'source_inbound_message_id_required',
    ),
    replyHash: requiredString(input.replyHash, 'reply_hash_required'),
    idempotencyKey: requiredString(input.idempotencyKey, 'idempotency_key_required'),
    payload: optionalObject(input.payload, 'delivery_payload_invalid'),
  };
}

function deliveryCompleteInput(body) {
  const input = {
    ...body,
    tenantId: body.tenantId ?? body.tenant_id,
    deliveryId: body.deliveryId ?? body.delivery_id,
    status: body.status,
    providerMessageId: body.providerMessageId ?? body.provider_message_id,
    providerResponse: body.providerResponse ?? body.provider_response,
    error: body.error ?? body.error_detail,
  };
  return {
    ...input,
    tenantId: requiredString(input.tenantId, 'tenant_id_required'),
    deliveryId: requiredString(input.deliveryId, 'delivery_id_required'),
    status: requiredString(input.status, 'status_required'),
    providerMessageId: typeof input.providerMessageId === 'string'
      ? input.providerMessageId.trim()
      : undefined,
    providerResponse: optionalObject(
      input.providerResponse,
      'provider_response_invalid',
      {},
    ),
  };
}

export async function handleChannelIntegrityRoute(request, response) {
  const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
  const supported = new Set([
    '/v1/webhooks/meta/verify',
    '/v1/webhooks/telegram/verify',
    '/v1/delivery/claim',
    '/v1/delivery/complete',
  ]);
  if (!supported.has(pathname)) return false;

  if (request.method !== 'POST') {
    writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  try {
    const body = await readJson(request);
    if (pathname === '/v1/webhooks/meta/verify') {
      const result = verifyMetaWebhook({
        provider: body.provider,
        signature: body.signature,
        rawBodyBase64: body.raw_body_base64 ?? body.rawBodyBase64,
      });
      writeJson(response, result.ok ? 200 : 401, { verified: result.ok, code: result.code });
      return true;
    }
    if (pathname === '/v1/webhooks/telegram/verify') {
      const result = verifyTelegramWebhook({
        suppliedToken: body.secret_token ?? body.secretToken,
      });
      writeJson(response, result.ok ? 200 : 401, { verified: result.ok, code: result.code });
      return true;
    }
    if (pathname === '/v1/delivery/claim') {
      const result = await claimDelivery(deliveryClaimInput(body));
      writeJson(response, 200, result);
      return true;
    }

    const result = await completeDelivery(deliveryCompleteInput(body));
    writeJson(response, 200, result);
    return true;
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 500;
    writeJson(response, statusCode, {
      ok: false,
      error: statusCode >= 500 ? 'channel_integrity_error' : error.message,
    });
    return true;
  }
}
