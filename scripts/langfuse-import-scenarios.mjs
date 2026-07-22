#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

async function loadEnv(file = '.env') {
  try {
    const text = await fs.readFile(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      let value = match[2].trim();
      if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

await loadEnv();

const baseUrl = (process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || 'http://127.0.0.1:8110').replace(/\/$/, '');
const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;
const datasetName = process.env.LANGFUSE_ACCEPTANCE_DATASET || 'brain-production-acceptance-v1';
if (!publicKey || !secretKey) throw new Error('LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required.');
const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;

async function request(apiPath, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method,
    headers: {
      authorization: auth,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Langfuse ${method} ${apiPath} returned HTTP ${response.status}: ${text.slice(0, 800)}`);
  return text ? JSON.parse(text) : null;
}

function rows(payload) {
  return Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
}

async function latestReport(target) {
  if (target && target.endsWith('.json')) return target;
  const directory = target || '.runtime/test-results';
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  if (entries.length === 0) throw new Error(`No scenario report exists in ${directory}.`);
  const candidates = await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry.name);
    return { file, stat: await fs.stat(file) };
  }));
  return candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0].file;
}

function scenarioId(row) {
  return row?.scenario_id ?? row?.scenarioId ?? row?.id ?? row?.name;
}

function traceIdsFrom(row) {
  const values = [row?.trace_id, row?.traceId];
  const turns = row?.turns ?? row?.transcript ?? row?.messages ?? [];
  for (const turn of Array.isArray(turns) ? turns : []) {
    values.push(
      turn?.trace_id,
      turn?.traceId,
      turn?.result?.telemetry?.traceId,
      turn?.output?.telemetry?.traceId,
      turn?.response?.telemetry?.traceId,
    );
  }
  return [...new Set(values.filter(Boolean))];
}

function judgeFor(report, id) {
  const scores = report?.judged?.scenario_scores ?? report?.judged?.scenarioScores ?? report?.scenario_scores ?? [];
  return Array.isArray(scores) ? scores.find((score) => scenarioId(score) === id) ?? null : null;
}

function judgeValue(judge) {
  const value = Number(judge?.score ?? judge?.overall_score ?? judge?.overallScore ?? judge?.quality_score ?? judge?.qualityScore);
  return Number.isFinite(value) ? value : null;
}

function itemScenarioId(item) {
  return item?.metadata?.scenarioId
    ?? item?.metadata?.scenario
    ?? item?.input?.scenario_id
    ?? item?.input?.scenarioId
    ?? item?.input?.id;
}

const reportFile = await latestReport(process.argv[2]);
const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
const transcripts = report.transcripts ?? report.results ?? report.scenarios ?? [];
if (!Array.isArray(transcripts) || transcripts.length === 0) throw new Error(`Scenario report ${reportFile} has no transcripts.`);

const [itemPayload, tracePayload] = await Promise.all([
  request(`/api/public/dataset-items?datasetName=${encodeURIComponent(datasetName)}&limit=100`),
  request('/api/public/traces?limit=100&orderBy=timestamp.desc'),
]);
const items = rows(itemPayload);
const traces = rows(tracePayload);
const runName = `brain-acceptance-${report.run_id ?? Date.now()}`;
const imported = [];
const missing = [];

for (const transcript of transcripts) {
  const id = scenarioId(transcript);
  if (!id) {
    missing.push({ scenario: null, reason: 'scenario id missing from report' });
    continue;
  }

  let item = items.find((candidate) => itemScenarioId(candidate) === id);
  if (!item) {
    item = await request('/api/public/dataset-items', {
      method: 'POST',
      body: {
        datasetName,
        input: { scenario_id: id, conversation: transcript?.turns ?? transcript?.transcript ?? transcript },
        expectedOutput: { minimum_quality_score: 8, no_critical_failures: true },
        metadata: { scenarioId: id, source: 'scenario-report' },
      },
    });
    items.push(item);
  }

  const explicit = traceIdsFrom(transcript);
  const matched = traces.filter((trace) => {
    if (explicit.includes(trace?.id)) return true;
    const metadataId = trace?.metadata?.scenarioId ?? trace?.metadata?.scenario ?? trace?.metadata?.scenario_id;
    return metadataId === id;
  }).sort((a, b) => String(a?.timestamp ?? '').localeCompare(String(b?.timestamp ?? '')));
  const trace = matched.at(-1);
  if (!trace?.id) {
    missing.push({ scenario: id, reason: 'no matching Langfuse trace' });
    continue;
  }

  const judge = judgeFor(report, id);
  const quality = judgeValue(judge);
  const passed = judge?.passed === true || (quality !== null && quality >= 8);
  await request('/api/public/dataset-run-items', {
    method: 'POST',
    body: {
      runName,
      datasetItemId: item.id,
      traceId: trace.id,
      metadata: {
        scenarioId: id,
        reportRunId: report.run_id ?? null,
        qualityGate: passed ? 'passed' : 'failed',
        allTraceIds: matched.map((candidate) => candidate.id),
      },
    },
  });

  if (quality !== null) {
    await request('/api/public/scores', {
      method: 'POST',
      body: {
        traceId: trace.id,
        name: 'scenario_quality',
        value: quality,
        dataType: 'NUMERIC',
        comment: judge?.reason ?? judge?.summary ?? 'LLM judge score from the channel-free acceptance run.',
        metadata: { scenarioId: id, runName, evaluator: 'acceptance-judge' },
      },
    });
  }
  imported.push({ scenarioId: id, datasetItemId: item.id, traceId: trace.id, quality, passed });
}

if (missing.length > 0) {
  throw new Error(`Scenario import was incomplete: ${JSON.stringify({ runName, imported, missing })}`);
}

process.stdout.write(`${JSON.stringify({
  status: 'imported',
  reportFile,
  datasetName,
  runName,
  scenarios: imported.length,
  imported,
}, null, 2)}\n`);
