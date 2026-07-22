#!/usr/bin/env node

import fs from 'node:fs';

function loadEnv(path = '.env') {
  if (!fs.existsSync(path)) return;
  for (const raw of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnv();

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.join('=') || true];
}));
const fixedTraceId = args.get('trace-id') === true ? '' : args.get('trace-id');
const timeoutMs = Number(args.get('timeout-ms') === true ? 90_000 : args.get('timeout-ms') ?? 90_000);
const pollMs = Number(args.get('poll-ms') === true ? 2_000 : args.get('poll-ms') ?? 2_000);
const baseUrl = (process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || 'http://127.0.0.1:8110').replace(/\/$/, '');
const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;

if (!publicKey || !secretKey) {
  throw new Error('LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required.');
}

const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;

async function request(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: auth, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Langfuse ${path} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

function rows(payload) {
  return Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
}

function nonEmpty(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function observationCost(observation) {
  const direct = numeric(observation?.calculatedTotalCost ?? observation?.totalCost);
  if (direct > 0) return direct;
  const details = observation?.costDetails;
  return details && typeof details === 'object'
    ? Object.values(details).reduce((sum, value) => sum + numeric(value), 0)
    : 0;
}

function observationUsage(observation) {
  const details = observation?.usageDetails ?? observation?.usage ?? {};
  if (!details || typeof details !== 'object') return 0;
  return Object.values(details).reduce((sum, value) => sum + numeric(value), 0);
}

function scoreNumber(score) {
  return numeric(score?.value ?? score?.numericValue ?? score?.booleanValue);
}

function latestScores(scores) {
  const ordered = [...scores].sort((a, b) => String(b?.timestamp ?? b?.createdAt ?? '').localeCompare(String(a?.timestamp ?? a?.createdAt ?? '')));
  const byName = new Map();
  for (const score of ordered) if (score?.name && !byName.has(score.name)) byName.set(score.name, score);
  return byName;
}

async function inspectTrace(traceId) {
  const [trace, observationPayload, scorePayload] = await Promise.all([
    request(`/api/public/traces/${encodeURIComponent(traceId)}`),
    request(`/api/public/observations?traceId=${encodeURIComponent(traceId)}&limit=100`),
    request(`/api/public/scores?traceId=${encodeURIComponent(traceId)}&limit=100`),
  ]);
  const observations = rows(observationPayload);
  const scores = rows(scorePayload);
  const generations = observations.filter((observation) => String(observation?.type ?? '').toUpperCase() === 'GENERATION');
  const names = observations.map((observation) => String(observation?.name ?? '').toLowerCase());
  const scoreMap = latestScores(scores);
  const requiredScores = [
    'response_contract_valid',
    'reply_policy_consistent',
    'memory_state_returned',
    'model_route_recorded',
    'commercial_action_valid',
    'escalation_policy_consistent',
  ];
  const totalCost = numeric(trace?.totalCost) || observations.reduce((sum, observation) => sum + observationCost(observation), 0);
  const failures = [];

  if (!nonEmpty(trace?.input)) failures.push('trace.input is empty');
  if (!nonEmpty(trace?.output)) failures.push('trace.output is empty');
  if (!trace?.sessionId) failures.push('trace.sessionId is missing');
  if (observations.length < 4) failures.push(`only ${observations.length} observations were exported`);
  if (!names.some((name) => name.includes('agent'))) failures.push('agent observation is missing');
  if (!names.some((name) => name.includes('memory'))) failures.push('memory observation is missing');
  if (!names.some((name) => name.includes('retriev') || name.includes('rag'))) failures.push('retrieval observation is missing');
  if (generations.length === 0) failures.push('generation observation is missing');
  if (generations.some((generation) => !generation?.parentObservationId)) failures.push('a generation is not nested below its parent observation');
  if (!generations.some((generation) => nonEmpty(generation?.input) && nonEmpty(generation?.output))) failures.push('generation input/output is missing');
  if (!generations.some((generation) => observationUsage(generation) > 0)) failures.push('provider token usage is missing');
  if (!(totalCost > 0)) failures.push('calculated/provider cost is zero');
  for (const name of requiredScores) {
    const score = scoreMap.get(name);
    if (!score) failures.push(`runtime score ${name} is missing`);
    else if (scoreNumber(score) < 0.999) failures.push(`runtime score ${name} failed with value ${scoreNumber(score)}`);
  }

  return {
    trace,
    observations,
    generations,
    scores,
    totalCost,
    failures,
    summary: {
      traceId,
      traceName: trace?.name,
      sessionId: trace?.sessionId,
      observations: observations.length,
      generations: generations.length,
      scores: scores.length,
      totalCost,
      inputPresent: nonEmpty(trace?.input),
      outputPresent: nonEmpty(trace?.output),
      observationTypes: [...new Set(observations.map((observation) => observation?.type).filter(Boolean))],
      scoreValues: Object.fromEntries([...scoreMap].map(([name, score]) => [name, scoreNumber(score)])),
    },
  };
}

async function candidateIds() {
  if (fixedTraceId) return [fixedTraceId];
  const payload = await request('/api/public/traces?limit=50&orderBy=timestamp.desc');
  return rows(payload)
    .filter((trace) => trace?.id && (!trace?.name || trace.name === 'brain.message'))
    .map((trace) => trace.id);
}

const startedAt = Date.now();
let best = null;
let lastError = null;

while (Date.now() - startedAt <= timeoutMs) {
  try {
    const ids = await candidateIds();
    for (const id of ids.slice(0, fixedTraceId ? 1 : 12)) {
      const inspected = await inspectTrace(id);
      if (!best || inspected.failures.length < best.failures.length) best = inspected;
      if (inspected.failures.length === 0) {
        process.stdout.write(`${JSON.stringify({ status: 'passed', ...inspected.summary }, null, 2)}\n`);
        process.exit(0);
      }
    }
  } catch (error) {
    lastError = error;
  }
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}

process.stderr.write(`${JSON.stringify({
  status: 'failed',
  timeoutMs,
  trace: best?.summary ?? null,
  failures: best?.failures ?? [lastError?.message ?? 'No brain.message trace was found.'],
}, null, 2)}\n`);
process.exit(1);
