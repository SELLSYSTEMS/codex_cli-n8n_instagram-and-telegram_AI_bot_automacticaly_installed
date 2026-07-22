import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

function loadEnvFile(path = '.env') {
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      let value = match[2];
      if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
      process.env[match[1]] = value;
    }
  } catch {}
}

loadEnvFile();

const baseUrl = (process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || '').replace(/\/$/, '');
const auth = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY || ''}:${process.env.LANGFUSE_SECRET_KEY || ''}`).toString('base64');

export function langfuseConfigured() {
  return Boolean(baseUrl && process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
}

export async function langfuseRequest(path, { method = 'GET', query, body } = {}) {
  if (!langfuseConfigured()) throw new Error('Langfuse credentials are not configured');
  const url = new URL(`${baseUrl}/api/public/${path.replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    throw new Error(`Langfuse ${method} ${path} failed (${response.status}): ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

export function rows(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['data', 'items', 'scores', 'traces', 'observations']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

export function stableUuid(namespace, value) {
  const hex = createHash('sha256').update(`${namespace}:${value}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

export async function ensureDataset(definition) {
  const existing = rows(await langfuseRequest('datasets', { query: { limit: 100 } })).find((item) => item.name === definition.name);
  if (existing) return existing;
  return langfuseRequest('datasets', { method: 'POST', body: definition });
}

export async function ensureDatasetItem(datasetName, item) {
  const id = item.id || stableUuid(datasetName, item.metadata?.scenarioId || JSON.stringify(item.input));
  return langfuseRequest('dataset-items', { method: 'POST', body: { ...item, id, datasetName } });
}

export async function ensureScoreConfig(definition) {
  const existing = rows(await langfuseRequest('score-configs', { query: { limit: 100 } })).find((item) => item.name === definition.name);
  if (existing) return existing;
  return langfuseRequest('score-configs', { method: 'POST', body: definition });
}

export async function ensureModel(definition) {
  const existing = rows(await langfuseRequest('models', { query: { limit: 100 } })).find((item) => item.modelName === definition.modelName);
  if (existing) return existing;
  return langfuseRequest('models', { method: 'POST', body: definition });
}

export async function createScore(score) {
  return langfuseRequest('scores', {
    method: 'POST',
    body: { id: score.id || randomUUID(), source: 'API', ...score },
  });
}

export async function linkDatasetRun(item) {
  return langfuseRequest('dataset-run-items', { method: 'POST', body: item });
}

function pickReply(result) {
  return result?.reply ?? result?.response ?? result?.output ?? result?.message ?? '';
}

function routeName(result) {
  if (typeof result?.modelRoute === 'string') return result.modelRoute;
  if (typeof result?.model_route === 'string') return result.model_route;
  return result?.modelRoute?.model
    ?? result?.modelRoute?.route
    ?? result?.model_route?.model
    ?? result?.model_route?.route
    ?? result?.model
    ?? result?.telemetry?.modelRoute
    ?? result?.telemetry?.model_route
    ?? result?.telemetry?.model
    ?? '';
}

export function runtimeScoreDefinitions(result) {
  const reply = pickReply(result);
  const outbound = result?.outbound_message ?? result?.outboundMessage ?? null;
  const outboundText = typeof outbound === 'string'
    ? outbound
    : outbound?.text ?? outbound?.message ?? outbound?.content ?? '';
  const silent = result?.should_reply === false
    || result?.shouldReply === false
    || result?.duplicate === true
    || result?.suppressed === true
    || result?.silent === true
    || result?.action === 'silent';
  const hasReply = typeof reply === 'string' && reply.trim().length > 0;
  const hasOutbound = typeof outboundText === 'string' && outboundText.trim().length > 0;
  const escalation = result?.escalation ?? result?.state?.escalation ?? result?.conversation?.escalation;
  const memory = result?.memory ?? result?.state ?? result?.conversation ?? result?.thread;
  const commercial = result?.commercialAction ?? result?.commercial_action ?? result?.action;
  return [
    ['response_contract_valid', silent || hasReply, 'A model reply or an explicit no-reply action is present.'],
    ['reply_policy_consistent', silent ? !hasOutbound : hasReply, 'A no-reply turn emits no outbound message; a reply turn contains model output.'],
    ['memory_state_returned', Boolean(memory), 'The Brain returned persistent conversation state.'],
    ['model_route_recorded', silent || Boolean(routeName(result)), 'A model route is recorded whenever model inference is required.'],
    ['commercial_action_valid', commercial === undefined || commercial === null || typeof commercial === 'string' || typeof commercial === 'object', 'Commercial action has a machine-readable contract.'],
    ['escalation_policy_consistent', !escalation || typeof escalation === 'boolean' || typeof escalation === 'string' || typeof escalation === 'object', 'Escalation state has a valid contract.'],
  ].map(([name, value, comment]) => ({ name, value: value ? 1 : 0, dataType: 'BOOLEAN', comment }));
}

export async function publishRuntimeScores(traceId, result, metadata = {}) {
  if (!traceId || !langfuseConfigured()) return [];
  const scores = runtimeScoreDefinitions(result);
  return Promise.all(scores.map((score) => createScore({
    ...score,
    id: stableUuid(traceId, score.name),
    traceId,
    metadata: { evaluator: 'runtime-contract-v1', ...metadata },
  })));
}
