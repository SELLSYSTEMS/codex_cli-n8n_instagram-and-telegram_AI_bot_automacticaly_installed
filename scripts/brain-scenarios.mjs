import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { loadEnv, requiredEnv, brainHeaders, jsonRequest, assert } from './runtime-env.mjs';

loadEnv();
requiredEnv(['BRAIN_API_URL', 'BRAIN_API_TOKEN', 'BRAIN_ADMIN_TOKEN', 'BRAIN_TENANT_KEY']);
const base = process.env.BRAIN_API_URL.replace(/\/$/, '');
const fileOptionIndex = process.argv.indexOf('--file');
const requestedScenarioFile = fileOptionIndex >= 0 ? process.argv[fileOptionIndex + 1] : null;
const caseOptionIndex = process.argv.indexOf('--case');
const requestedCaseId = caseOptionIndex >= 0 ? process.argv[caseOptionIndex + 1] : null;

if (fileOptionIndex >= 0 && (!requestedScenarioFile || requestedScenarioFile.startsWith('--'))) {
  throw new Error('--file requires a scenario JSON path');
}

if (caseOptionIndex >= 0 && (!requestedCaseId || requestedCaseId.startsWith('--'))) {
  throw new Error('--case requires an exact scenario id');
}

const scenarioFile = requestedScenarioFile ?? 'tests/scenarios/generic-conversation-cases.json';
const allScenarios = JSON.parse(await fs.readFile(scenarioFile, 'utf8'));

if (!Array.isArray(allScenarios) || allScenarios.length === 0) {
  throw new Error(`Scenario file must contain a non-empty JSON array: ${scenarioFile}`);
}

const scenarios = requestedCaseId
  ? allScenarios.filter((scenario) => scenario.id === requestedCaseId)
  : allScenarios;

if (requestedCaseId && scenarios.length === 0) {
  throw new Error(`Unknown scenario id: ${requestedCaseId}`);
}
const runId = crypto.randomUUID();
const transcripts = [];

for (const scenario of scenarios) {
  const userId = 'scenario-' + runId + '-' + scenario.id;
  const turns = [];
  for (let index = 0; index < scenario.messages.length; index += 1) {
    const input = scenario.messages[index];
    const result = await jsonRequest(base + '/v1/messages', {
      method: 'POST', headers: brainHeaders(), body: JSON.stringify({
        tenant_key: process.env.BRAIN_TENANT_KEY,
        channel: 'scenario_test',
        external_user_id: userId,
        external_thread_id: userId,
        external_message_id: scenario.id + '-' + runId + '-' + index,
        text: input,
        display_name: scenario.persona,
        metadata: { test: true, scenario: scenario.id },
      }),
    });
    assert(result.should_reply === true, scenario.id + ' turn ' + (index + 1) + ' unexpectedly suppressed');
    assert(typeof result.reply === 'string' && result.reply.trim().length >= 10, scenario.id + ' returned an empty reply');
    assert(result.reply.length <= 2500, scenario.id + ' returned an excessively long reply');
    turns.push({
      user: input,
      assistant: result.reply,
      commercial_action: result.commercial_action ?? result.commercialAction ?? null,
    });
  }
  transcripts.push({
    id: scenario.id,
    persona: scenario.persona,
    expectation: scenario.expectation,
    required_final_commercial_action: scenario.required_final_commercial_action ?? null,
    turns,
  });
}

const escalationUser = 'escalation-' + runId;
const escalation = await jsonRequest(base + '/v1/messages', {
  method: 'POST', headers: brainHeaders(), body: JSON.stringify({
    tenant_key: process.env.BRAIN_TENANT_KEY, channel: 'scenario_test', external_user_id: escalationUser,
    external_thread_id: escalationUser, external_message_id: 'escalate-' + runId,
    text: 'Stop the automated conversation. I explicitly need a human operator because this concerns a legal contract dispute.',
    display_name: 'Escalation test', metadata: { test: true },
  }),
});
assert(escalation.escalated === true || escalation.action === 'escalate', 'Explicit exceptional escalation was not recorded');
const suppressed = await jsonRequest(base + '/v1/messages', {
  method: 'POST', headers: brainHeaders(), body: JSON.stringify({
    tenant_key: process.env.BRAIN_TENANT_KEY, channel: 'scenario_test', external_user_id: escalationUser,
    external_thread_id: escalationUser, external_message_id: 'suppressed-' + runId,
    text: 'Are you still there?', display_name: 'Escalation test', metadata: { test: true },
  }),
});
assert(suppressed.should_reply === false, 'Escalated conversation did not remain silent');
await jsonRequest(base + '/v1/admin/escalations/reset', {
  method: 'POST', headers: brainHeaders(true), body: JSON.stringify({ tenant_key: process.env.BRAIN_TENANT_KEY, channel: 'scenario_test', external_user_id: escalationUser }),
});
const resumed = await jsonRequest(base + '/v1/messages', {
  method: 'POST', headers: brainHeaders(), body: JSON.stringify({
    tenant_key: process.env.BRAIN_TENANT_KEY, channel: 'scenario_test', external_user_id: escalationUser,
    external_thread_id: escalationUser, external_message_id: 'resumed-' + runId,
    text: 'The operator reset the handoff. Please confirm we can continue.', display_name: 'Escalation test', metadata: { test: true },
  }),
});
assert(resumed.should_reply === true, 'Conversation did not resume after escalation reset');

function runCodexJudge(prompt, outputPath, route) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', [
      'exec',
      '--model', route.model,
      '--config', `model_reasoning_effort="${route.reasoning_effort ?? route.reasoning ?? 'low'}"`,
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--ephemeral',
      '--output-schema', 'schemas/scenario-evaluation.schema.json',
      '--output-last-message', outputPath,
      '-',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error('Scenario judge failed: ' + stderr.slice(-1200))));
    child.stdin.end(prompt);
  });
}

function routeValue(route, directKey, envKey, fallback = null) {
  const direct = route?.[directKey];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const envName = route?.[envKey];
  if (typeof envName === 'string' && process.env[envName]?.trim()) return process.env[envName].trim();
  return fallback;
}

function openAiCompatibleCredentials(route) {
  if (route.provider === 'deepseek') {
    return {
      apiKey: routeValue(route, 'api_key', 'api_key_env', process.env.DEEPSEEK_API_KEY),
      baseUrl: routeValue(route, 'base_url', 'base_url_env', process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'),
    };
  }
  if (route.provider === 'openai') {
    return {
      apiKey: routeValue(route, 'api_key', 'api_key_env', process.env.OPENAI_API_KEY),
      baseUrl: routeValue(route, 'base_url', 'base_url_env', process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
    };
  }
  return { apiKey: null, baseUrl: null };
}

function extractJudgeJson(content) {
  const trimmed = String(content ?? '').trim();
  if (!trimmed) throw new Error('Scenario judge returned empty content');
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const parsed = JSON.parse(unfenced);
  if (!Number.isFinite(parsed.average_score) || !Array.isArray(parsed.critical_failures) || !Array.isArray(parsed.scenario_scores)) {
    throw new Error('Scenario judge returned an invalid evaluation contract');
  }
  return parsed;
}

async function runOpenAiCompatibleJudge(prompt, outputPath, route) {
  const { apiKey, baseUrl } = openAiCompatibleCredentials(route);
  if (!apiKey || !baseUrl) {
    throw new Error(`Scenario judge credentials are unavailable for ${route.provider}`);
  }
  const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(route.timeout_ms ?? 120000));
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: route.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Evaluate strictly and return only the requested JSON object.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
  } finally {
    clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Scenario judge HTTP ${response.status}: ${JSON.stringify(payload).slice(-1200)}`);
  }
  const judged = extractJudgeJson(payload?.choices?.[0]?.message?.content);
  await fs.writeFile(outputPath, JSON.stringify(judged), { mode: 0o600 });
  return { stdout: '', stderr: '' };
}

async function runJudge(prompt, outputPath) {
  const { getModelRoutes } = await import('./model-router.mjs');
  const { routes } = await getModelRoutes();
  const candidates = routes
    .filter((route) => route.enabled && ['codex_cli', 'deepseek', 'openai'].includes(route.provider))
    .sort((left, right) => left.priority - right.priority);

  if (candidates.length === 0) {
    throw new Error('Scenario judge has no enabled model routes');
  }

  const attempts = [];

  for (const route of candidates) {
    await fs.rm(outputPath, { force: true });
    try {
      const result = route.provider === 'codex_cli'
        ? await runCodexJudge(prompt, outputPath, route)
        : await runOpenAiCompatibleJudge(prompt, outputPath, route);
      console.log(`Scenario judge model: ${route.model} (${route.id})`);
      return {
        ...result,
        route: { id: route.id, provider: route.provider, model: route.model },
        attempts,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ id: route.id, provider: route.provider, model: route.model, error: message.slice(-300) });
    }
  }

  throw new Error(`Scenario judge exhausted enabled routes: ${JSON.stringify(attempts)}`);
}

const judgePrompt = [
  'You are a strict evaluator of a production conversational business agent.',
  'Evaluate the JSON transcripts below. Do not reward canned scripts. Require natural language matching, memory across turns, relevant discovery, technical accuracy, grounded claims, objection handling, and concrete next steps.',
  'Judge commercial timing semantically. Before the buyer has supplied enough relevant context and shown commitment, the agent should diagnose and help rather than force checkout. Once the buyer explicitly accepts a grounded offer and asks to start or pay, the agent should stop unnecessary discovery and provide an executable next step.',
  'A good sales response is individualized and advances the specific conversation by one appropriate step; it is neither passive nor pushy. Materially similar canned responses across different personas are a failure.',
  'Premature payment pressure, failure to act on explicit purchase readiness, premature escalation, invented facts, repeated generic templates, loss of context, or wrong-language replies are critical failures.',
  'Return only JSON with this shape: {"average_score": number from 0 to 10, "critical_failures": [], "scenario_scores": [{"id":"...","score":number,"note":"..."}]}.',
  JSON.stringify(transcripts),
].join('\n\n');
await fs.mkdir('.runtime/test-results', { recursive: true });
const judgeOutputPath = `.runtime/test-results/.judge-${process.pid}-${Date.now()}.json`;
let judged;
try {
  await runJudge(judgePrompt, judgeOutputPath);
  const rawJudge = await fs.readFile(judgeOutputPath, 'utf8');
  judged = JSON.parse(rawJudge);
} finally {
  await fs.rm(judgeOutputPath, { force: true });
}
const reportPath = '.runtime/test-results/scenarios-' + runId + '.json';
const contractFailures = transcripts.flatMap((item) => {
  if (!item.required_final_commercial_action) return [];
  const finalAction = item.turns.at(-1)?.commercial_action;
  const resolvedActionId = finalAction?.selection?.action_id
    ?? finalAction?.action_id
    ?? null;
  if (resolvedActionId === item.required_final_commercial_action) return [];
  return [{
    id: item.id,
    issue: `Required final commercial action ${item.required_final_commercial_action}, received ${resolvedActionId || 'null'}.`,
  }];
});
const criticalFailures = [
  ...(Array.isArray(judged.critical_failures) ? judged.critical_failures : []),
  ...contractFailures,
];
const passed = judged.average_score >= 8
  && criticalFailures.length === 0;

await fs.mkdir('.runtime/test-results', { recursive: true });
await fs.writeFile(reportPath, JSON.stringify({
  run_id: runId,
  scenario_file: scenarioFile,
  transcripts,
  judged,
  contract_failures: contractFailures,
  escalation: 'passed',
  quality_gate: passed ? 'passed' : 'failed',
}, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({
  scenarios: scenarios.length,
  turns: transcripts.reduce((sum, item) => sum + item.turns.length, 0),
  average_score: judged.average_score,
  critical_failures: criticalFailures,
  escalation_marker: 'passed',
  quality_gate: passed ? 'passed' : 'failed',
  report: reportPath,
}, null, 2));

assert(judged.average_score >= 8, 'Scenario quality average is below 8/10: ' + judged.average_score);
assert(criticalFailures.length === 0, 'Scenario judge found critical failures: ' + JSON.stringify(criticalFailures));
