import "./telemetry.mjs";
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  appendCommercialActionContext,
  appendCommercialActionValidation,
  resolveCommercialAction,
} from './commercial-action-tool.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.env.MODEL_ROUTES_CONFIG || path.join(root, 'config/model-routes.default.json');
const runtimePath = process.env.MODEL_ROUTES_RUNTIME || path.join(root, '.runtime/model-routes.json');
const healthPath = process.env.MODEL_HEALTH_STATE || path.join(root, '.runtime/model-health.json');

function now() {
  return new Date().toISOString();
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export async function getModelRoutes() {
  const base = await readJson(configPath, { routes: [] });
  const runtime = await readJson(runtimePath, null);
  const source = runtime && Array.isArray(runtime.routes) ? runtime : base;
  return {
    routes: source.routes
      .map((route) => ({ ...route, priority: Number(route.priority || 999) }))
      .sort((a, b) => a.priority - b.priority),
  };
}

export async function setModelRoutes(next) {
  if (!next || !Array.isArray(next.routes) || next.routes.length === 0) {
    throw new Error('routes must be a non-empty array');
  }
  const ids = new Set();
  for (const route of next.routes) {
    if (!route.id || !route.provider || !route.model) throw new Error('every route needs id, provider and model');
    if (ids.has(route.id)) throw new Error('route ids must be unique');
    ids.add(route.id);
  }
  const value = {
    routes: next.routes.map((route) => ({
      id: String(route.id),
      provider: String(route.provider),
      model: String(route.model),
      enabled: Boolean(route.enabled),
      priority: Number(route.priority),
      reasoning_effort: route.reasoning_effort || 'low',
    })),
    updated_at: now(),
  };
  await writeJson(runtimePath, value);
  return value;
}

function findBalancedJsonObject(source) {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (start < 0) {
      if (character === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  return null;
}

function escapeControlCharactersInJsonStrings(source) {
  let output = '';
  let inString = false;
  let escaped = false;

  for (const character of source) {
    const code = character.charCodeAt(0);
    if (!inString) {
      output += character;
      if (character === '"') inString = true;
      continue;
    }

    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      output += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      output += character;
      inString = false;
      continue;
    }
    if (code < 0x20) {
      const escapedControl = {
        8: '\\b',
        9: '\\t',
        10: '\\n',
        12: '\\f',
        13: '\\r',
      }[code] || `\\u${code.toString(16).padStart(4, '0')}`;
      output += escapedControl;
      continue;
    }
    output += character;
  }

  return output;
}

function extractJson(text) {
  const trimmed = String(text || '').trim();
  const balanced = findBalancedJsonObject(trimmed);
  const candidates = [...new Set([trimmed, balanced].filter(Boolean))];
  let lastError;

  for (const candidate of candidates) {
    for (const value of [candidate, escapeControlCharactersInJsonStrings(candidate)]) {
      try {
        return JSON.parse(value);
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw new Error(`Model did not return a valid JSON object: ${lastError?.message || 'unknown parse error'}`);
}

function normalizeCommercialAction(raw) {
  const action = raw && typeof raw === 'object' ? raw : {};
  const args = action.arguments && typeof action.arguments === 'object' ? action.arguments : {};
  const amount = Number(args.grounded_total_usd);

  return {
    action_id: typeof action.action_id === 'string' && action.action_id.trim()
      ? action.action_id.trim()
      : null,
    selection_reason: typeof action.selection_reason === 'string'
      ? action.selection_reason.trim()
      : '',
    requested_commitment: typeof action.requested_commitment === 'string' && action.requested_commitment.trim()
      ? action.requested_commitment.trim()
      : null,
    arguments: {
      option_id: typeof args.option_id === 'string' && args.option_id.trim()
        ? args.option_id.trim()
        : null,
      grounded_total_usd: Number.isFinite(amount) && amount > 0 ? amount : null,
      grounding_reference: typeof args.grounding_reference === 'string' && args.grounding_reference.trim()
        ? args.grounding_reference.trim()
        : null,
      missing_fact: typeof args.missing_fact === 'string' && args.missing_fact.trim()
        ? args.missing_fact.trim()
        : null,
      customer_commitment: typeof args.customer_commitment === 'string' && args.customer_commitment.trim()
        ? args.customer_commitment.trim()
        : null,
    },
  };
}

function normalizeDecision(raw) {
  const profile = raw.contact_profile && typeof raw.contact_profile === 'object' ? raw.contact_profile : {};
  const semanticState = {
    intent: typeof raw.intent === 'string' ? raw.intent.trim() : '',
    conversation_phase: typeof raw.conversation_phase === 'string' ? raw.conversation_phase.trim() : '',
    customer_readiness: typeof raw.customer_readiness === 'string' ? raw.customer_readiness.trim() : '',
    material_blocker: typeof raw.material_blocker === 'string' && raw.material_blocker.trim() ? raw.material_blocker.trim() : null,
    next_best_action: typeof raw.next_best_action === 'string' ? raw.next_best_action.trim() : '',
    commercial_progress: typeof raw.commercial_progress === 'string' ? raw.commercial_progress.trim() : '',
    decision_status: typeof raw.decision_status === 'string' ? raw.decision_status.trim() : '',
    confirmed_commitments: Array.isArray(raw.confirmed_commitments)
      ? raw.confirmed_commitments
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
      : [],
    pending_customer_commitment: typeof raw.pending_customer_commitment === 'string' && raw.pending_customer_commitment.trim()
      ? raw.pending_customer_commitment.trim()
      : null,
  };
  return {
    // Preserve schema-validated semantic and commercial planning fields across
    // draft, review, and execution passes. Normalized runtime fields below
    // intentionally override their raw counterparts.
    ...raw,
    reply: typeof raw.reply === 'string' ? raw.reply.trim() : '',
    response_language: typeof raw.response_language === 'string' ? raw.response_language.trim() : '',
    reply_language_consistent: raw.reply_language_consistent === true,
    should_reply: raw.should_reply !== false,
    should_escalate: raw.should_escalate === true,
    escalation_reason: typeof raw.escalation_reason === 'string' ? raw.escalation_reason.trim() : '',
    confidence: Math.max(0, Math.min(1, Number(raw.confidence || 0))),
    conversation_summary: typeof raw.conversation_summary === 'string' ? raw.conversation_summary.trim() : '',
    contact_profile: profile,
    commercial_action: normalizeCommercialAction(raw.commercial_action),
    semantic_state: semanticState,
  };
}

function runProcess(command, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('model process timed out'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error('model process exited ' + code + ': ' + stderr.slice(-2000)));
    });
    child.stdin.end(input);
  });
}

async function callCodex(route, prompt) {
  const outputSchema = new URL('../schemas/brain-decision.schema.json', import.meta.url).pathname;
  const args = [
    'exec',
    '--model', route.model,
    '--config', 'model_reasoning_effort="' + (route.reasoning_effort || 'low') + '"',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--ephemeral',
    '--output-schema', outputSchema,
    '-',
  ];
  return runProcess(process.env.CODEX_BIN || 'codex', args, prompt, Number(process.env.MODEL_TIMEOUT_MS || 180000));
}

async function callOpenAI(route, prompt) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + process.env.OPENAI_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: route.model,
      input: prompt,
      reasoning: { effort: route.reasoning_effort || 'low' },
      text: { format: { type: 'json_object' } },
    }),
    signal: AbortSignal.timeout(Number(process.env.MODEL_TIMEOUT_MS || 180000)),
  });
  const body = await response.json();
  if (!response.ok) throw new Error('OpenAI ' + response.status + ': ' + JSON.stringify(body).slice(0, 1500));
  return body.output_text || body.output?.flatMap((item) => item.content || []).map((item) => item.text || '').join('') || '';
}

async function callDeepSeekOnce(route, prompt) {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is missing');
  const response = await fetch((process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com') + '/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + process.env.DEEPSEEK_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: route.model,
      thinking: { type: "disabled" },
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.35,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(Number(process.env.MODEL_TIMEOUT_MS || 180000)),
  });
  const body = await response.json();
  if (!response.ok) throw new Error('DeepSeek ' + response.status + ': ' + JSON.stringify(body).slice(0, 1500));
  return body.choices?.[0]?.message?.content || '';
}

async function callDeepSeek(route, prompt) {
  const configuredAttempts = Number(process.env.DEEPSEEK_CONTRACT_ATTEMPTS || 2);
  const attempts = Number.isFinite(configuredAttempts)
    ? Math.max(1, Math.min(3, Math.trunc(configuredAttempts)))
    : 2;
  let currentPrompt = prompt;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const output = await callDeepSeekOnce(route, currentPrompt);
      validateDecisionContract(normalizeDecision(extractJson(output)));
      return output;
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt >= attempts) throw error;
      currentPrompt = [
        prompt,
        '',
        'CONTRACT REPAIR RETRY',
        'The previous response failed JSON parsing or the required response contract.',
        'Return one complete valid JSON object only. It must satisfy the exact contract in the original request.',
        'Do not add Markdown, prose outside JSON, or omit a non-empty reply when should_reply is true.',
      ].join('\n');
    }
  }

  throw lastError;
}

function validateDecisionContract(decision) {
  if (decision.should_reply && !decision.reply) {
    const error = new Error('Model contract violation: should_reply=true requires a non-empty reply');
    error.code = 'MODEL_CONTRACT_ERROR';
    throw error;
  }

  return decision;
}

function retryable(error) {
  if (error?.code === 'MODEL_CONTRACT_ERROR') return true;
  const message = String(error?.message || error).toLowerCase();
  return /quota|rate.?limit|too many requests|429|usage limit|capacity|overloaded|temporarily unavailable|timed out|timeout|econnreset|502|503|504|model did not return a valid json object/.test(message);
}

async function updateHealth(route, status, detail) {
  const health = await readJson(healthPath, { routes: {} });
  health.routes[route.id] = {
    model: route.model,
    provider: route.provider,
    status,
    checked_at: now(),
    detail: String(detail || '').slice(0, 500),
  };
  await writeJson(healthPath, health);
}

export async function routeModel(prompt, hooks = {}) {
  const config = await getModelRoutes();
  const enabled = config.routes.filter((route) => route.enabled);
  if (enabled.length === 0) throw new Error('no model routes are enabled');
  const failures = [];
  for (let index = 0; index < enabled.length; index += 1) {
    const route = enabled[index];
    const startedAt = Date.now();
    try {
      let output;
      if (route.provider === 'codex_cli') output = await callCodex(route, prompt);
      else if (route.provider === 'openai') output = await callOpenAI(route, prompt);
      else if (route.provider === 'deepseek') output = await callDeepSeek(route, prompt);
      else throw new Error('unsupported provider: ' + route.provider);
      const decision = validateDecisionContract(normalizeDecision(extractJson(output)));
      const latencyMs = Date.now() - startedAt;
      await updateHealth(route, 'ok', '');
      if (hooks.onSuccess) await hooks.onSuccess(route, decision, latencyMs);
      return { route, decision, failures, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const canFallback = retryable(error) && index < enabled.length - 1;
      failures.push({
        route: route.id,
        model: route.model,
        error: String(error?.message || error),
        retryable: canFallback,
        latencyMs,
      });
      await updateHealth(route, canFallback ? 'degraded' : 'failed', error?.message || error);
      if (hooks.onFailure) await hooks.onFailure(route, error, canFallback);
      if (!canFallback) {
        const wrapped = new Error('model route failed: ' + String(error?.message || error));
        wrapped.failures = failures;
        throw wrapped;
      }
    }
  }
  throw new Error('all model routes failed');
}

function buildReviewPrompt(originalPrompt, draftResult) {
  const draftPayload = {
    route: {
      id: draftResult.route?.id,
      provider: draftResult.route?.provider,
      model: draftResult.route?.model,
    },
    decision: draftResult.decision,
  };

  return [
    originalPrompt,
    '',
    'INDEPENDENT FINAL DECISION REVIEW',
    'You are the final decision-maker. Return a complete replacement decision using exactly the same JSON contract. Do not return commentary or a critique.',
    'Independently inspect the conversation, retrieved evidence, prior commitments, and the draft decision below.',
    'Preserve all confirmed customer commitments unless the customer explicitly changed or rejected them.',
    'Treat explicit acceptance as agreement. A compatible refinement does not reopen already agreed scope.',
    'Set material_blocker only for a real missing fact that prevents the next externally executable step.',
    'When the customer is ready and no material blocker exists, replace acknowledgements, recaps, repeated discovery, or repeated confirmation with the nearest grounded transaction step.',
    'The reply must state the relevant grounded value or recommendation and ask for one easy, concrete customer commitment.',
    'Valid next commitments include only actions supported by the evidence: the minimum missing contact or billing detail, a verified booking or payment action, a concrete kickoff action, or permission for an authorized sales handoff.',
    'Never invent a price, payment link, timeline, package, capability, delivery promise, or process.',
    'next_best_action must describe the customer-visible action now. commercial_progress must describe a measurable customer decision, commitment, resolved objection, or support outcome, never internal planning.',
    'Write naturally in the customer language and context. Do not use canned wording, scripts, keyword routing, language branches, or channel-specific business logic.',
    'If the draft merely acknowledges, summarizes, reconfirms, or asks another discovery question after scope is agreed, replace it.',
    '',
    'DRAFT DECISION TO REVIEW',
    JSON.stringify(draftPayload, null, 2),
  ].join('\n');
}

function mergeCommitments(draftDecision, reviewedDecision) {
  const draft = draftDecision?.semantic_state?.confirmed_commitments || [];
  const reviewed = reviewedDecision?.semantic_state?.confirmed_commitments || [];

  return [
    ...new Set(
      [...draft, ...reviewed]
        .filter((value) => typeof value === 'string' && value.trim())
        .map((value) => value.trim()),
    ),
  ];
}

function buildExecutionPrompt(originalPrompt, reviewedResult) {
  return [
    originalPrompt,
    '',
    'FINAL RESPONSE RECONCILIATION',
    'Return a complete replacement decision using exactly the same JSON contract. Do not return commentary or a critique.',
    'The decision below has passed independent semantic review, but its customer-facing reply may still be inconsistent with its selected action or accumulated commitments.',
    'Reconcile the decision against the full conversation and the authoritative commercial action result appended below.',
    'Resolve ambiguity from the complete discourse and the commercially coherent meaning, not from isolated words or the most recently mentioned channel.',
    'Preserve confirmed commitments. Do not reopen settled scope, repeat authorization, or turn a human handoff destination into a bot capability or delivery surface.',
    'The final reply must create the nearest grounded customer-visible progress in this turn and must not promise to prepare that same progress later.',
    '',
    'REVIEWED DECISION TO RECONCILE',
    JSON.stringify(reviewedResult.decision, null, 2),
  ].join('\n');
}

function commercialActionId(decision) {
  const action = decision?.commercial_action;
  if (!action || typeof action !== 'object') return null;
  return action.action_id || action.action || action.id || action.name || null;
}

function actionRemainsAligned(expectedDecision, candidateDecision) {
  const expected = commercialActionId(expectedDecision);
  const candidate = commercialActionId(candidateDecision);
  return !expected || expected === candidate;
}

export async function routeModelWithReview(prompt, hooks = {}) {
  const commercialPrompt = `${await appendCommercialActionContext(prompt)}

# Authoritative semantic response contract

Reason over the complete current conversation, persisted semantic memory, retrieved authoritative knowledge, and tool results. Do not use keyword intent trees, language branches, scripted funnels, rigid stage machines, or canned sales templates.

Help the customer make progress before proposing a transaction. Resolve short replies from their immediate conversational context, preserve only evidence-backed commitments, clarify material ambiguity once, and never repeat an answered discovery question. Draft useful artifacts when the customer lacks them.

Choose a commercial action only when it is the grounded next step for the active workstream. A paid audit is never a default. Never invent pricing, requirements, capabilities, promises, or prior context. Transactional actions require explicit and unambiguous authorization for the exact action and option in the newest inbound message.

Return a natural, individualized reply that answers the immediate need and advances one meaningful step.`;

  const draft = await routeModel(commercialPrompt, hooks);
  const draftCommercialAction = await resolveCommercialAction(
    draft.decision.commercial_action,
    prompt,
  );

  try {
    const reviewPrompt = appendCommercialActionValidation(
      buildReviewPrompt(commercialPrompt, draft),
      draftCommercialAction,
    );
    const reviewed = await routeModel(reviewPrompt, hooks);
    const reviewedCommercialAction = await resolveCommercialAction(
      reviewed.decision.commercial_action,
      prompt,
    );

    if (!reviewedCommercialAction.valid) {
      throw new Error(
        reviewedCommercialAction.reason
          || 'independent review returned an invalid commercial action',
      );
    }

    return {
      ...reviewed,
      failures: [
        ...(draft.failures || []),
        ...(reviewed.failures || []),
      ],
      latencyMs: Number(draft.latencyMs || 0) + Number(reviewed.latencyMs || 0),
      commercialAction: reviewedCommercialAction,
      independentReview: {
        performed: true,
        correctionPerformed: false,
        draftRoute: draft.route?.id || null,
        draftModel: draft.route?.model || null,
        reviewRoute: reviewed.route?.id || null,
        reviewModel: reviewed.route?.model || null,
        executionPerformed: false,
        executionAttempts: 0,
      },
    };
  } catch (error) {
    return {
      ...draft,
      commercialAction: draftCommercialAction,
      independentReview: {
        performed: false,
        draftRoute: draft.route?.id || null,
        draftModel: draft.route?.model || null,
        error: String(error?.message || error).slice(0, 500),
      },
    };
  }
}
