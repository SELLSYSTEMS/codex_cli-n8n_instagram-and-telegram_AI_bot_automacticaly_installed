import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const RUBRIC_VERSION = 'conversation-quality-v1';
const DEFAULT_MODEL = 'deepseek-v4-pro';
const DEFAULT_PASS_SCORE = 0.75;

loadEnv(path.join(ROOT, '.env'));

const RUBRIC = Object.freeze({
  relevance: 'Directly addresses the user message and the current conversational goal.',
  groundedness: 'Uses supplied knowledge and retrieved context faithfully, without inventing unsupported facts.',
  helpfulness: 'Makes useful progress with clear, proportionate guidance or a good next question.',
  continuity: 'Uses prior conversation state correctly and does not restart, contradict, or forget established facts.',
  commercial_judgment: 'Advances a commercial conversation naturally without pressure, canned selling, or premature payment requests.',
  action_correctness: 'Chooses an appropriate next action and does not claim that an action occurred unless evidence supports it.',
  escalation_appropriateness: 'Escalates only when justified and respects an existing escalation state.',
  language_continuity: 'Responds in the user-selected or clearly used language; when language is genuinely ambiguous, defaults to English.',
});

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function clamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function truncate(value, limit = 18000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[truncated ${text.length - limit} characters]`;
}

function stableUuid(value) {
  const hex = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function hashFraction(value) {
  const head = crypto.createHash('sha256').update(String(value)).digest().readUInt32BE(0);
  return head / 0xffffffff;
}

export function shouldSample(traceId, rate = Number(process.env.LANGFUSE_LLM_JUDGE_SAMPLE_RATE || 0.1)) {
  return hashFraction(traceId) < Math.max(0, Math.min(1, Number(rate)));
}

function langfuseBase() {
  return (process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || 'http://127.0.0.1:8110')
    .replace(/\/+$/, '');
}

async function langfuseRequest(route, options = {}) {
  const authorization = Buffer.from(
    `${required('LANGFUSE_PUBLIC_KEY')}:${required('LANGFUSE_SECRET_KEY')}`,
  ).toString('base64');
  const response = await fetch(`${langfuseBase()}${route}`, {
    ...options,
    headers: {
      authorization: `Basic ${authorization}`,
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  const payload = text ? safeJson(text) : null;
  if (!response.ok) {
    const error = new Error(`Langfuse ${options.method || 'GET'} ${route} failed: HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload || text;
    throw error;
  }
  return payload;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function rows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function parseJudgeJson(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== 'object') throw new Error('Judge returned a non-object response');
  if (!parsed.dimensions || typeof parsed.dimensions !== 'object') {
    throw new Error('Judge response has no dimensions object');
  }

  const dimensions = {};
  for (const key of Object.keys(RUBRIC)) {
    const candidate = parsed.dimensions[key] || {};
    const applicable = candidate.applicable !== false;
    dimensions[key] = {
      applicable,
      score: applicable ? clamp(candidate.score) : null,
      reason: truncate(candidate.reason || 'No reason supplied', 800),
      evidence: truncate(candidate.evidence || 'No evidence supplied', 800),
    };
  }

  return {
    rubric_version: RUBRIC_VERSION,
    verdict: ['pass', 'review', 'fail'].includes(parsed.verdict) ? parsed.verdict : 'review',
    overall_score: clamp(parsed.overall_score),
    dimensions,
    critical_failures: Array.isArray(parsed.critical_failures)
      ? parsed.critical_failures.slice(0, 8).map((failure) => ({
          code: truncate(failure?.code || 'unspecified', 100),
          reason: truncate(failure?.reason || 'No reason supplied', 600),
          evidence: truncate(failure?.evidence || 'No evidence supplied', 600),
        }))
      : [],
    summary: truncate(parsed.summary || 'No summary supplied', 1000),
  };
}

function judgePrompt(subject) {
  return [
    'You are an independent quality evaluator for a production conversational AI.',
    'Evaluate only the evidence provided. Do not infer hidden facts or reward verbosity.',
    'Do not prefer a particular writing style, dialect, accent, response length, or sales tactic.',
    'Judge whether the response fits this specific user, conversation stage, available context, and action state.',
    'Mark a dimension not applicable when the evidence needed to judge it is absent.',
    'A commercially good response is helpful first: it discovers needs when needed, answers known questions, and proposes commitment only when the user is ready.',
    'Do not penalize a response merely because it did not sell, escalate, or ask a question when that action was not appropriate.',
    'Treat an unsupported factual claim, fabricated action, context loss, unexplained language switch, or unjustified escalation as serious.',
    '',
    `Rubric version: ${RUBRIC_VERSION}`,
    'Dimensions:',
    ...Object.entries(RUBRIC).map(([name, description]) => `- ${name}: ${description}`),
    '',
    'Return strict JSON only with this shape:',
    JSON.stringify({
      rubric_version: RUBRIC_VERSION,
      verdict: 'pass | review | fail',
      overall_score: 'number from 0 to 1',
      dimensions: Object.fromEntries(
        Object.keys(RUBRIC).map((name) => [
          name,
          {
            applicable: 'boolean',
            score: 'number from 0 to 1, or null when not applicable',
            reason: 'brief reason',
            evidence: 'specific evidence from the evaluated material',
          },
        ]),
      ),
      critical_failures: [{ code: 'short_code', reason: 'brief reason', evidence: 'specific evidence' }],
      summary: 'concise overall assessment',
    }),
    '',
    'Material to evaluate:',
    truncate(subject),
  ].join('\n');
}

function deepSeekEndpoint() {
  const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  return `${base}/chat/completions`;
}

export async function judgeConversation(subject, options = {}) {
  const model = options.model || process.env.LANGFUSE_LLM_JUDGE_MODEL || DEFAULT_MODEL;
  const startedAt = Date.now();
  const response = await fetch(deepSeekEndpoint(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${required('DEEPSEEK_API_KEY')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Evaluate conversational quality impartially. Return valid JSON only.',
        },
        { role: 'user', content: judgePrompt(subject) },
      ],
    }),
  });
  const payload = safeJson(await response.text());
  if (!response.ok) {
    throw new Error(`DeepSeek judge failed: HTTP ${response.status} ${truncate(payload, 1000)}`);
  }
  const evaluation = parseJudgeJson(payload?.choices?.[0]?.message?.content);
  return {
    evaluation,
    model,
    latency_ms: Date.now() - startedAt,
    usage: payload?.usage || null,
  };
}

function observationTime(observation) {
  return Date.parse(observation?.startTime || observation?.timestamp || 0) || 0;
}

function buildTraceSubject(trace, observations) {
  const agentCandidates = observations
    .filter((observation) => observation?.name === 'brain.agent')
    .sort((a, b) => observationTime(a) - observationTime(b));
  const agent = agentCandidates.at(-1);
  if (!agent?.id) {
    throw new Error(`Trace ${trace.id} has no brain.agent observation; refusing deprecated trace-only evaluation`);
  }

  const related = observations
    .filter((observation) => observation.id !== agent.id)
    .filter((observation) => {
      const name = String(observation.name || '').toLowerCase();
      return (
        name.includes('memory') ||
        name.includes('rag') ||
        name.includes('retriev') ||
        name.includes('tool') ||
        name.includes('action') ||
        name.includes('model')
      );
    })
    .map((observation) => ({
      name: observation.name,
      type: observation.type,
      input: observation.input,
      output: observation.output,
      metadata: observation.metadata,
    }));

  return {
    agent,
    material: {
      trace_input: trace.input,
      trace_output: trace.output,
      agent_input: agent.input,
      agent_output: agent.output,
      trace_metadata: trace.metadata,
      agent_metadata: agent.metadata,
      supporting_observations: related,
    },
  };
}

async function fetchTrace(traceId) {
  return langfuseRequest(`/api/public/traces/${encodeURIComponent(traceId)}`);
}

async function fetchObservations(traceId) {
  const payload = await langfuseRequest(
    `/api/public/observations?traceId=${encodeURIComponent(traceId)}&limit=100`,
  );
  return rows(payload);
}

async function existingJudgeScore(traceId) {
  try {
    const payload = await langfuseRequest(
      `/api/public/scores?traceId=${encodeURIComponent(traceId)}&limit=100`,
    );
    return rows(payload).find(
      (score) =>
        score.name === 'judge_overall_quality' &&
        score.metadata?.rubric_version === RUBRIC_VERSION,
    );
  } catch (error) {
    if ([400, 404].includes(error.status)) return null;
    throw error;
  }
}

async function createScore({ traceId, observationId, name, value, dataType, comment, metadata }) {
  const id = stableUuid(`${traceId}:${observationId}:${name}:${RUBRIC_VERSION}`);
  try {
    return await langfuseRequest('/api/public/scores', {
      method: 'POST',
      body: JSON.stringify({
        id,
        traceId,
        observationId,
        name,
        value,
        dataType,
        comment: truncate(comment, 1800),
        metadata,
      }),
    });
  } catch (error) {
    if (error.status === 409) return { id, duplicate: true };
    throw error;
  }
}

async function publishEvaluation(traceId, observationId, result) {
  const metadata = {
    rubric_version: RUBRIC_VERSION,
    evaluator: 'deepseek-llm-as-a-judge',
    evaluator_model: result.model,
    evaluation_source: 'application',
    latency_ms: result.latency_ms,
    usage: result.usage,
    verdict: result.evaluation.verdict,
    critical_failure_count: result.evaluation.critical_failures.length,
  };
  const passScore = Number(process.env.LANGFUSE_LLM_JUDGE_MIN_SCORE || DEFAULT_PASS_SCORE);
  const passed =
    result.evaluation.overall_score >= passScore &&
    result.evaluation.critical_failures.length === 0 &&
    result.evaluation.verdict !== 'fail';

  const writes = [
    createScore({
      traceId,
      observationId,
      name: 'judge_overall_quality',
      value: result.evaluation.overall_score,
      dataType: 'NUMERIC',
      comment: JSON.stringify({
        summary: result.evaluation.summary,
        critical_failures: result.evaluation.critical_failures,
      }),
      metadata,
    }),
    createScore({
      traceId,
      observationId,
      name: 'judge_pass',
      value: passed ? 1 : 0,
      dataType: 'NUMERIC',
      comment: result.evaluation.summary,
      metadata: {
        ...metadata,
        threshold: passScore,
        semantic_type: 'boolean',
        pass_value: 1,
        fail_value: 0,
      },
    }),
  ];

  for (const [name, dimension] of Object.entries(result.evaluation.dimensions)) {
    if (!dimension.applicable) continue;
    writes.push(
      createScore({
        traceId,
        observationId,
        name: `judge_${name}`,
        value: dimension.score,
        dataType: 'NUMERIC',
        comment: JSON.stringify({ reason: dimension.reason, evidence: dimension.evidence }),
        metadata,
      }),
    );
  }
  await Promise.all(writes);
  return { passed, score_count: writes.length };
}

export async function evaluateTrace(traceId, options = {}) {
  const force = Boolean(options.force);
  const sampleRate = options.sampleRate ?? Number(process.env.LANGFUSE_LLM_JUDGE_SAMPLE_RATE || 0.1);
  if (!force && !shouldSample(traceId, sampleRate)) {
    return { trace_id: traceId, status: 'not_sampled', sample_rate: sampleRate };
  }
  if (!force && (await existingJudgeScore(traceId))) {
    return { trace_id: traceId, status: 'already_evaluated' };
  }

  const [trace, observations] = await Promise.all([fetchTrace(traceId), fetchObservations(traceId)]);
  const { agent, material } = buildTraceSubject(trace, observations);
  const result = await judgeConversation(material, options);
  const publication = await publishEvaluation(traceId, agent.id, result);
  return {
    trace_id: traceId,
    observation_id: agent.id,
    status: 'evaluated',
    overall_score: result.evaluation.overall_score,
    verdict: result.evaluation.verdict,
    critical_failures: result.evaluation.critical_failures,
    passed: publication.passed,
    score_count: publication.score_count,
    evaluator_model: result.model,
    latency_ms: result.latency_ms,
    usage: result.usage,
  };
}

export async function listRecentBrainTraces(limit = 25) {
  const requested = Math.max(1, Math.min(25, Number(limit)));
  const fetchLimit = Math.min(100, Math.max(20, requested * 4));
  const payload = await langfuseRequest(
    `/api/public/traces?limit=${fetchLimit}&page=1&orderBy=timestamp.desc`,
  );
  return rows(payload)
    .filter((trace) => trace?.name === 'brain.message' && trace?.id)
    .slice(0, requested);
}

export { RUBRIC, RUBRIC_VERSION };
