import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_WEBHOOK_BYTES = Number(process.env.BRAIN_MAX_WEBHOOK_BYTES || 2 * 1024 * 1024);

function safeTextEqual(left, right) {
  const leftDigest = createHmac('sha256', 'constant-time-compare').update(String(left || '')).digest();
  const rightDigest = createHmac('sha256', 'constant-time-compare').update(String(right || '')).digest();
  return timingSafeEqual(leftDigest, rightDigest) && String(left || '').length === String(right || '').length;
}

export function decodeRawWebhook(rawBodyBase64) {
  if (typeof rawBodyBase64 !== 'string' || rawBodyBase64.length === 0) {
    throw Object.assign(new Error('raw_body_base64 is required'), { code: 'RAW_BODY_REQUIRED' });
  }
  const body = Buffer.from(rawBodyBase64, 'base64');
  if (body.length === 0 || body.length > MAX_WEBHOOK_BYTES) {
    throw Object.assign(new Error('raw webhook body is empty or too large'), { code: 'RAW_BODY_INVALID' });
  }
  return body;
}

export function verifyMetaWebhook({ rawBody, signature, appSecrets }) {
  const supplied = String(signature || '').trim();
  if (!/^sha256=[a-f0-9]{64}$/i.test(supplied)) return false;
  const secrets = [...new Set((appSecrets || []).map((value) => String(value || '').trim()).filter(Boolean))];
  return secrets.some((secret) => {
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    return safeTextEqual(expected.toLowerCase(), supplied.toLowerCase());
  });
}

export function verifyTelegramSecret({ supplied, expected }) {
  if (!String(expected || '').trim() || !String(supplied || '').trim()) return false;
  return safeTextEqual(String(supplied).trim(), String(expected).trim());
}

export function parseVerifiedJson(rawBody) {
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw Object.assign(new Error('verified webhook body is not valid JSON'), { code: 'WEBHOOK_JSON_INVALID' });
  }
}
