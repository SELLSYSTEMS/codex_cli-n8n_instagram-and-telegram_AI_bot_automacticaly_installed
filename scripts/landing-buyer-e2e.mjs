#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

import {
  langfuseConfigured,
  langfuseRequest,
  rows as langfuseRows,
} from './langfuse-api.mjs';

const { Client } = pg;

function loadEnvFile(path = '.env') {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    return;
  }

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || process.env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile();

const brainBaseUrl = (
  process.env.BRAIN_API_URL
  || process.env.BRAIN_BASE_URL
  || `http://127.0.0.1:${process.env.BRAIN_PORT || '8789'}`
).replace(/\/+$/u, '');
const brainApiToken = process.env.BRAIN_API_TOKEN || '';
const databaseUrl = (
  process.env.LOCAL_POSTGRES_URL
  || process.env.BRAIN_DATABASE_URL
  || process.env.DATABASE_URL
  || process.env.POSTGRES_URL
  || process.env.POSTGRES_CONNECTION_STRING
  || ''
);
const tenantKey = process.env.E2E_TENANT_KEY || process.env.BRAIN_TENANT_KEY || '';
const expectedPrice = process.env.E2E_EXPECTED_PRICE || '';
const expectedDepositPercent = process.env.E2E_EXPECTED_DEPOSIT_PERCENT || '';
const expectedPaymentUrl = process.env.E2E_EXPECTED_PAYMENT_URL || '';
const expectedModel = process.env.E2E_EXPECTED_MODEL || '';
const expectedProvider = process.env.E2E_EXPECTED_PROVIDER || '';
const requireLangfuse = !/^(0|false|no)$/iu.test(process.env.E2E_REQUIRE_LANGFUSE || 'true');

if (!brainApiToken) throw new Error('BRAIN_API_TOKEN is required');
if (!databaseUrl) throw new Error('A PostgreSQL connection URL is required');
if (!tenantKey) throw new Error('E2E_TENANT_KEY or BRAIN_TENANT_KEY is required');

const runId = randomUUID();
const externalUserId = `e2e-landing-buyer-${runId}`;
const externalThreadId = `e2e-landing-thread-${runId}`;
const channel = 'internal-e2e';
const source = 'landing-buyer-e2e';
const artifactPath = `/tmp/landing-buyer-e2e-${runId}.json`;

const turns = [
  'Hi, I need a simple landing page for my bookkeeping business.',
  'The goal is to book consultations. I already have the logo and copy. I need a responsive one-page site with a contact form and analytics, launched three weeks from today.',
  'I already have the domain and hosting. Please give me the exact price in USD and the shortest sensible next step.',
    `That works. I approve the 35% deposit and want to start now. My name is Alex Morgan and my email is landing.e2e.${runId.replaceAll('-', '')}@sellsystems.agency. Send the payment instructions.`,
];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|password|authorization|api[_-]?key/iu.test(key)) {
      output[key] = '[redacted]';
    } else {
      output[key] = redact(item);
    }
  }
  return output;
}

function collectValues(value, keyPattern, collected = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectValues(item, keyPattern, collected);
    return collected;
  }
  if (!value || typeof value !== 'object') return collected;
  for (const [key, item] of Object.entries(value)) {
    if (keyPattern.test(key) && (typeof item === 'string' || typeof item === 'number')) {
      collected.push(String(item));
    }
    collectValues(item, keyPattern, collected);
  }
  return collected;
}

function firstTextByKey(value, keyPattern) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = firstTextByKey(item, keyPattern);
      if (match) return match;
    }
    return '';
  }
  if (!value || typeof value !== 'object') return '';
  for (const [key, item] of Object.entries(value)) {
    if (keyPattern.test(key) && typeof item === 'string' && item.trim()) return item.trim();
  }
  for (const item of Object.values(value)) {
    const match = firstTextByKey(item, keyPattern);
    if (match) return match;
  }
  return '';
}

function responseReply(body) {
  const direct = firstTextByKey(body, /^(reply|answer|response_text|output_text)$/iu);
  if (direct) return direct;
  if (typeof body?.output === 'string') return body.output;
  if (typeof body?.response === 'string') return body.response;
  return '';
}

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(updated_at|last_seen_at|last_message_at|modified_at)$/iu.test(key)) continue;
    output[key] = stripVolatile(item);
  }
  return output;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

async function brainRequest(path, options = {}) {
  const response = await fetch(`${brainBaseUrl}${path}`, {
    ...options,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${brainApiToken}`,
      'content-type': 'application/json',
      'x-api-key': brainApiToken,
      'x-brain-api-key': brainApiToken,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return {
    status: response.status,
    body,
    traceHeader: response.headers.get('x-trace-id') || response.headers.get('trace-id') || '',
  };
}

async function brainHealth() {
  const attempts = [];
  for (const path of ['/healthz', '/health']) {
    const result = await brainRequest(path, { method: 'GET' });
    attempts.push({ path, status: result.status, body: redact(result.body) });
    if (result.status >= 200 && result.status < 300) {
      return { ok: true, path, status: result.status, body: redact(result.body), attempts };
    }
  }
  return { ok: false, attempts };
}

function messagePayload(text, index) {
  return {
    tenant_key: tenantKey,
    channel,
    external_user_id: externalUserId,
    external_thread_id: externalThreadId,
    external_message_id: `${runId}-message-${index + 1}`,
    text,
    metadata: {
      source,
      e2e_run_id: runId,
      synthetic_test: true,
    },
  };
}

async function sendTurn(text, index) {
  const payload = messagePayload(text, index);
  const startedAt = Date.now();
  const result = await brainRequest('/v1/messages', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const traceIds = new Set(
    collectValues(result.body, /^(trace_?id|langfuse_?trace_?id)$/iu),
  );
  if (result.traceHeader) traceIds.add(result.traceHeader);
  return {
    index: index + 1,
    input: text,
    payload,
    status: result.status,
    latency_ms: Date.now() - startedAt,
    reply: responseReply(result.body),
    trace_ids: [...traceIds],
    body: redact(result.body),
  };
}

async function agentSnapshot(client) {
  const tablesResult = await client.query(
    `select table_name
       from information_schema.tables
      where table_schema = 'agent'
        and table_type = 'BASE TABLE'
      order by table_name`,
  );
  const snapshot = {};
  for (const { table_name: tableName } of tablesResult.rows) {
    const qualified = `${quoteIdentifier('agent')}.${quoteIdentifier(tableName)}`;
    const result = await client.query(
      `select to_jsonb(row_data) as row
         from ${qualified} as row_data
        where to_jsonb(row_data)::text like $1
        order by to_jsonb(row_data)::text`,
      [`%${runId}%`],
    );
    if (result.rows.length > 0) {
      snapshot[tableName] = result.rows.map(({ row }) => stripVolatile(row));
    }
  }
  return snapshot;
}

function snapshotRowCount(snapshot) {
  return Object.values(snapshot).reduce((total, tableRows) => total + tableRows.length, 0);
}

function stableSnapshotIdentity(snapshot) {
  return Object.fromEntries(
    Object.entries(snapshot).map(([tableName, rows]) => [
      tableName,
      {
        count: rows.length,
        ids: rows.map((row, index) => String(
          row.id
          ?? row.message_id
          ?? row.external_message_id
          ?? row.dedupe_key
          ?? row.trace_id
          ?? `row-${index}`
        )).sort(),
      },
    ]),
  );
}

function questionClauses(text) {
  return normalizeText(text).match(/[^?]*\?/gu) || [];
}

async function fetchLangfuseEvidence(traceIds) {
  if (!langfuseConfigured()) {
    return {
      configured: false,
      traces: [],
      observations: [],
      errors: [],
    };
  }

  const evidence = {
    configured: true,
    traces: [],
    observations: [],
    errors: [],
  };

  for (let attempt = 1; attempt <= 12; attempt += 1) {
    evidence.traces = [];
    evidence.observations = [];
    evidence.errors = [];

    for (const traceId of traceIds) {
      try {
        const trace = await langfuseRequest(`traces/${encodeURIComponent(traceId)}`);
        evidence.traces.push(redact(trace));
      } catch (error) {
        evidence.errors.push({ trace_id: traceId, resource: 'trace', message: error.message });
      }

      try {
        const payload = await langfuseRequest('observations', {
          query: { traceId, limit: 100 },
        });
        evidence.observations.push(...langfuseRows(payload).map(redact));
      } catch (error) {
        evidence.errors.push({ trace_id: traceId, resource: 'observations', message: error.message });
      }
    }

    if (evidence.traces.length === traceIds.length && evidence.observations.length > 0) break;
    if (attempt < 12) await sleep(2_000);
  }

  return evidence;
}

function includesAll(haystack, needles) {
  const normalized = haystack.toLowerCase();
  return needles.every((needle) => normalized.includes(String(needle).toLowerCase()));
}

function optionalExpectation(value, assertion) {
  return value ? Boolean(assertion) : true;
}

const client = new Client({ connectionString: databaseUrl });
const report = {
  run_id: runId,
  started_at: new Date().toISOString(),
  scenario: 'fresh simple landing-page buyer',
  identities: {
    channel,
    external_user_id: externalUserId,
    external_thread_id: externalThreadId,
  },
  health: null,
  turns: [],
  replay: null,
  persistence: {},
  langfuse: {},
  checks: {},
  passed: false,
};

try {
  report.health = await brainHealth();

  await client.connect();
  report.persistence.database = redact(
    (await client.query(
      `select current_database() as database_name,
              current_user as database_user,
              current_schema() as current_schema`,
    )).rows[0],
  );
  report.persistence.before = await agentSnapshot(client);

  for (let index = 0; index < turns.length; index += 1) {
    report.turns.push(await sendTurn(turns[index], index));
  }

  report.persistence.after = await agentSnapshot(client);

  const replayStartedAt = Date.now();
  const replayResult = await brainRequest('/v1/messages', {
    method: 'POST',
    body: JSON.stringify(report.turns.at(-1).payload),
  });
  report.replay = {
    status: replayResult.status,
    latency_ms: Date.now() - replayStartedAt,
    reply: responseReply(replayResult.body),
    body: redact(replayResult.body),
  };
  report.persistence.after_replay = await agentSnapshot(client);

  const traceIds = [...new Set(report.turns.flatMap((turn) => turn.trace_ids))];
  report.langfuse = {
    trace_ids: traceIds,
    ...(await fetchLangfuseEvidence(traceIds)),
  };

  const replies = report.turns.map((turn) => normalizeText(turn.reply));
  const allReplies = replies.join('\n');
  const finalReply = replies.at(-1) || '';
  const afterTurnTwoQuestions = questionClauses(replies[2]).join(' ');
  const afterTurnThreeQuestions = questionClauses(replies[3]).join(' ');
  const responseEvidence = JSON.stringify(report.turns.map((turn) => turn.body));
  const observabilityEvidence = JSON.stringify({
    traces: report.langfuse.traces,
    observations: report.langfuse.observations,
  });
  const combinedEvidence = `${responseEvidence}\n${observabilityEvidence}`;
  const models = [...new Set(collectValues(report.turns.map((turn) => turn.body), /^model$/iu))];
  const providers = [...new Set(
    collectValues(report.turns.map((turn) => turn.body), /^provider$/iu)
      .map((value) => normalizeText(value).toLowerCase())
      .filter((value) => value && value !== 'langfuse'),
  )];
const normalizedExpectedPrice = expectedPrice.replace(/,/gu, '').trim();
const normalizedPriceEvidence = (text) => String(text || '').replace(/,/gu, '');
const escapedExpectedPrice = normalizedExpectedPrice.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const pricePattern = expectedPrice
  ? new RegExp(`(?:US\\$|USD\\s*|\\$)\\s*${escapedExpectedPrice}(?:\\.00)?(?!\\d|\\.\\d)`, 'iu')
  : /(?:US\$|USD\s*|\$)\s*\d[\d,]*(?:\.\d{2})?/iu;
  const depositPattern = expectedDepositPercent
    ? new RegExp(`${expectedDepositPercent.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*%`, 'iu')
    : /\b(?:deposit|prepayment|upfront)\b/iu;
  const internalArtifactPattern = /\b(?:scope lock|execution artifact|implementation baseline|interface contract|execution interface contract|payload schema|acceptance baseline|routing contract|implementation-ready v1|version-?1 help\+sell flow|v1 bot launch packet|conversation regression pack|build-ready onboarding packet|conversation safety\/delivery gate|operational handoff payload|decision state)\b/iu;
  const repeatedDiscoveryPattern = /\b(?:what is the (?:main )?goal|do you (?:already )?have (?:a )?(?:domain|hosting|logo|copy)|when do you want (?:it|this) launched)\b/iu;
  const ragPattern = /\b(?:rag|retriev(?:e|al|ed)|knowledge(?:\s+base)?|matched_documents?|document_count|context_chunks?)\b/iu;
  const toolPattern = /\b(?:commercial[_ -]?action|present_checkout|payment[_ -]?(?:action|tool)|tool(?:_name| call| result))\b/iu;
  const repeatedSuppliedFactPattern = /\b(?:what|which|when|do you|have you|could you|can you).*(?:goal|consultation|booking|logo|copy|content|three[- ]week|timeline|domain|hosting)\b/iu;
  const repeatedDomainHostingPattern = /\b(?:what|which|do you|have you|could you|can you).*(?:domain|hosting)\b/iu;
  const explicitFallbacks = collectValues(
    report.turns.map((turn) => turn.body),
    /^(fallback_used|used_fallback|fallback_route)$/iu,
  );
  const repeatedSuppliedQuestions = (
    repeatedSuppliedFactPattern.test(afterTurnTwoQuestions)
    || repeatedSuppliedFactPattern.test(afterTurnThreeQuestions)
    || repeatedDomainHostingPattern.test(afterTurnThreeQuestions)
  );
  const persistedEvidence = stableJson(report.persistence.after);
  const stableAfter = stableJson(stableSnapshotIdentity(report.persistence.after));
  const stableAfterReplay = stableJson(stableSnapshotIdentity(report.persistence.after_replay));
  const explicitEscalationValues = collectValues(
    [report.turns.map((turn) => turn.body), report.persistence.after],
    /^(should_escalate|escalated|escalation_required|escalated_at|handoff_required)$/iu,
  );
  const explicitActions = collectValues(
    report.turns.map((turn) => turn.body),
    /^(action|decision|route_action)$/iu,
  );
  const escalationActive = (
    explicitEscalationValues.some((value) => {
      const normalized = normalizeText(value).toLowerCase();
      return normalized && !/^(false|0|no|null|none)$/u.test(normalized);
    })
    || explicitActions.some((value) => /^(?:escalate|handoff|human_handoff)$/iu.test(normalizeText(value)))
  );

  report.checks = {
    brain_health: report.health.ok,
    fresh_identity_before_test: snapshotRowCount(report.persistence.before) === 0,
    all_turns_2xx: report.turns.every((turn) => turn.status >= 200 && turn.status < 300),
    all_replies_nonempty: replies.every(Boolean),
    english_continuity: !/[\u0400-\u04ff]/u.test(allReplies),
    at_most_one_question_per_reply: replies.every((reply) => (reply.match(/\?/gu) || []).length <= 1),
    no_internal_workflow_artifacts: !internalArtifactPattern.test(allReplies),
    no_repeated_discovery_after_supplied: !repeatedSuppliedQuestions,
    memory_continuity: (
      /\b(?:logo|copy|content)\b/iu.test(persistedEvidence)
      && (() => {
        const evidence = `${persistedEvidence}\n${allReplies}`;
        const expectedDate = new Date();
        expectedDate.setUTCDate(expectedDate.getUTCDate() + 21);
        const month = expectedDate.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
        const day = expectedDate.getUTCDate();
        const year = expectedDate.getUTCFullYear();
        const isoDate = expectedDate.toISOString().slice(0, 10);
        const resolvedDate = new RegExp(`\\b(?:${month}\\s+${day}(?:st|nd|rd|th)?(?:,)?\\s+${year}|${isoDate})\\b`, 'iu');
        return /\b(?:three weeks|3 weeks|three-week|3-week)\b/iu.test(evidence) || resolvedDate.test(evidence);
      })()
      && /\b(?:domain|hosting)\b/iu.test(persistedEvidence)
      && !repeatedSuppliedQuestions
    ),
    exact_price_supplied:
      pricePattern.test(normalizedPriceEvidence(replies[2]))
      || pricePattern.test(normalizedPriceEvidence(finalReply)),
    deposit_acknowledged: depositPattern.test(`${replies[2] || ''}\n${finalReply}`),
    payment_instructions_actionable: (
      /\b(?:pay|payment|checkout|deposit|prepayment|invoice)\b/iu.test(finalReply)
      && (
        /https?:\/\/\S+/iu.test(finalReply)
        || /\b(?:card|paypal|crypto|bank transfer|invoice)\b/iu.test(finalReply)
      )
    ),
    expected_payment_url: optionalExpectation(expectedPaymentUrl, finalReply.includes(expectedPaymentUrl)),
      commercial_tool_evidence: report.turns.some((turn) => (
        turn?.body?.commercial_action?.valid === true
      && turn.body.commercial_action.status === 'ready'
        && turn.body.commercial_action.selection?.action_id === 'present_checkout'
        && Boolean(turn.body.commercial_action.execution)
      )),
    semantic_state_ready_to_pay: /\b(?:clear[_ -]?to[_ -]?pay|ready[_ -]?to[_ -]?pay|await[_ -]?(?:payment|deposit)(?:[_ -]?(?:and|or)[_ -]?human[_ -]?contact)?|customer completes payment|approved\s+\d+\s*%\s+deposit|provided checkout instructions|present[_ -]?checkout)\b/iu.test(persistedEvidence),
    route_recorded: models.length > 0 && providers.length > 0,
    expected_model: optionalExpectation(expectedModel, models.includes(expectedModel)),
    expected_provider: optionalExpectation(expectedProvider, providers.includes(expectedProvider)),
    no_model_fallback: explicitFallbacks.every((value) => !/^(1|true|yes)$/iu.test(value)),
    idempotent_replay_status: report.replay.status >= 200 && report.replay.status < 300,
    idempotent_replay_reply: normalizeText(report.replay.reply) === finalReply,
    idempotent_persistence: stableAfter === stableAfterReplay,
    postgres_persistence: snapshotRowCount(report.persistence.after) > 0,
    langfuse_trace_ids_returned: report.langfuse.trace_ids.length === report.turns.length,
    langfuse_traces_present: !requireLangfuse || report.langfuse.traces.length === report.langfuse.trace_ids.length,
    langfuse_observations_present: !requireLangfuse || report.langfuse.observations.length > 0,
    rag_evidence_present: ragPattern.test(combinedEvidence),
    no_escalation: !escalationActive,
  };

  report.route = {
    models,
    providers,
    explicit_fallback_values: explicitFallbacks,
  };
  report.persistence.row_counts = {
    before: snapshotRowCount(report.persistence.before),
    after: snapshotRowCount(report.persistence.after),
    after_replay: snapshotRowCount(report.persistence.after_replay),
  };
  report.langfuse.summary = {
    trace_count: report.langfuse.traces.length,
    observation_count: report.langfuse.observations.length,
    rag_observation_count: report.langfuse.observations.filter((observation) => ragPattern.test(JSON.stringify(observation))).length,
    tool_observation_count: report.langfuse.observations.filter((observation) => toolPattern.test(JSON.stringify(observation))).length,
    errors: report.langfuse.errors,
  };
  report.passed = Object.values(report.checks).every(Boolean);
} catch (error) {
  report.error = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  report.passed = false;
} finally {
  report.finished_at = new Date().toISOString();
  await client.end().catch(() => {});
  writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  chmodSync(artifactPath, 0o600);
}

const failedChecks = Object.entries(report.checks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);

console.log(JSON.stringify({
  run_id: report.run_id,
  passed: report.passed,
  failed_checks: failedChecks,
  artifact: artifactPath,
  route: report.route,
  persistence: report.persistence.row_counts,
  langfuse: report.langfuse.summary,
  turns: report.turns.map((turn) => ({
    index: turn.index,
    status: turn.status,
    latency_ms: turn.latency_ms,
    trace_ids: turn.trace_ids,
    reply: turn.reply,
  })),
  replay: report.replay && {
    status: report.replay.status,
    latency_ms: report.replay.latency_ms,
    same_reply: normalizeText(report.replay.reply) === normalizeText(report.turns.at(-1)?.reply),
  },
  error: report.error,
}, null, 2));

process.exitCode = report.passed ? 0 : 1;
