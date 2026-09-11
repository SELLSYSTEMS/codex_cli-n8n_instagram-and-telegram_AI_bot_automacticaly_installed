import "./telemetry.mjs";
import fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import {
  appendCommercialActionContext,
  appendCommercialActionExecution,
  appendCommercialActionValidation,
  resolveCommercialAction,
} from './commercial-action-tool.mjs';
import { deriveSemanticState } from './semantic-state.mjs';
import { runModelProcess } from './model-process-runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.env.MODEL_ROUTES_CONFIG || path.join(root, 'config/model-routes.default.json');
const runtimePath = process.env.MODEL_ROUTES_RUNTIME || path.join(root, '.runtime/model-routes.json');
const healthPath = process.env.MODEL_HEALTH_STATE || path.join(root, '.runtime/model-health.json');

function now() {
  return new Date().toISOString();
}

function normalizeCommercialActionContract(raw, passes) {
  const fail = (message) => {
    throw new Error(`Invalid commercial_action_contract: ${message}`);
  };

  if ((raw === undefined || raw === null) && passes) {
    return {
      required_action_id: null,
      forbidden_action_ids: [],
    };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('expected an object');
  }

  const allowedKeys = new Set(['required_action_id', 'forbidden_action_ids']);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) fail(`unexpected property "${key}"`);
  }

  const requiredActionId = raw.required_action_id;
  if (
    requiredActionId !== null
    && (typeof requiredActionId !== 'string' || requiredActionId.trim() === '')
  ) {
    fail('required_action_id must be null or a non-empty string');
  }

  if (!Array.isArray(raw.forbidden_action_ids)) {
    fail('forbidden_action_ids must be an array');
  }

  const forbiddenActionIds = raw.forbidden_action_ids.map((value) => {
    if (typeof value !== 'string' || value.trim() === '') {
      fail('forbidden_action_ids must contain only non-empty strings');
    }
    return value.trim();
  });

  if (new Set(forbiddenActionIds).size !== forbiddenActionIds.length) {
    fail('forbidden_action_ids must be unique');
  }

  const normalizedRequiredActionId = requiredActionId === null
    ? null
    : requiredActionId.trim();

  if (
    normalizedRequiredActionId
    && forbiddenActionIds.includes(normalizedRequiredActionId)
  ) {
    fail('required_action_id cannot also be forbidden');
  }

  if (
    passes
    && (normalizedRequiredActionId !== null || forbiddenActionIds.length > 0)
  ) {
    fail('a passing assessment must not require or forbid actions');
  }

  return {
    required_action_id: normalizedRequiredActionId,
    forbidden_action_ids: forbiddenActionIds,
  };
}

function strengthenCommercialActionContract(
  assessment,
  decision,
  previousContract = null,
) {
  const normalizedContract = normalizeCommercialActionContract(
    assessment?.commercial_action_contract,
    assessment?.passes,
  );

  if (assessment?.passes) {
    return normalizedContract;
  }

  const previousRequiredActionId =
    typeof previousContract?.required_action_id === 'string'
      ? previousContract.required_action_id.trim() || null
      : null;
  const requiredActionId =
    previousRequiredActionId || normalizedContract.required_action_id;
  const previousForbiddenActionIds = Array.isArray(
    previousContract?.forbidden_action_ids,
  )
    ? previousContract.forbidden_action_ids
    : [];
  const forbiddenActionIds = new Set([
    ...previousForbiddenActionIds,
    ...normalizedContract.forbidden_action_ids,
  ]);
  const selectedActionId = selectedCommercialActionId(decision);
  const selectedActionWasRejected =
    Array.isArray(assessment?.violations)
    && assessment.violations.some(
      (violation) =>
        violation
        && typeof violation === 'object'
        && String(violation.rule_id || '').trim()
          === 'commercial_action_eligibility',
    );

  if (
    selectedActionWasRejected
    && selectedActionId
    && selectedActionId !== requiredActionId
  ) {
    forbiddenActionIds.add(selectedActionId);
  }
  if (requiredActionId) {
    forbiddenActionIds.delete(requiredActionId);
  }

  return {
    required_action_id: requiredActionId,
    forbidden_action_ids: [...forbiddenActionIds],
  };
}

function validateConformanceAssessment(raw) {
  const normalized = validateConformanceAssessmentBase(raw);
  const commercialActionContract = normalizeCommercialActionContract(
    raw?.commercial_action_contract,
    normalized.passes,
  );
  const actionEligibilityRejected =
    !normalized.passes
    && normalized.violations.some(
      (violation) => violation.rule_id === 'commercial_action_eligibility',
    );

  if (actionEligibilityRejected && !commercialActionContract.required_action_id) {
    for (const violation of normalized.violations) {
      if (violation.rule_id !== 'commercial_action_eligibility') continue;
      violation.rule_id = 'commercial_action_contract';
      violation.detail = `${
        violation.detail || 'The selected commercial action is not eligible.'
      } Select no commercial action for this turn.`;
    }
  }

  if (
    commercialActionContract.required_action_id
    && commercialActionContract.forbidden_action_ids.includes(
      commercialActionContract.required_action_id,
    )
  ) {
    const error = new Error(
      'Semantic conformance contract violation: required_action_id cannot also '
      + 'be present in forbidden_action_ids.',
    );
    error.code = 'MODEL_CONTRACT_ERROR';
    throw error;
  }

  return {
    ...normalized,
    commercial_action_contract: commercialActionContract,
  };
}

function commercialActionAssessmentContractPrompt() {
  return [
    'COMMERCIAL ACTION CONTRACT (REQUIRED, MACHINE-ENFORCED):',
    '- Include commercial_action_contract in the assessment JSON.',
    '- Its exact shape is {"required_action_id": string|null, "forbidden_action_ids": string[]}.',
    '- If passes=true, required_action_id MUST be null and forbidden_action_ids MUST be [].',
    '- If passes=false, set required_action_id only when exactly one action from the supplied catalog is semantically required by the conversation, action history, and action eligibility contract.',
    '- Add an action ID to forbidden_action_ids only when the supplied context, history, and catalog prove that action is ineligible, already spent, or would repeat equivalent progress.',
    '- A commercial_action_eligibility violation means an exact replacement action is required: required_action_id MUST be that eligible catalog action and MUST NOT be null; the rejected action MUST be forbidden.',
    '- If the correct repair is to select no commercial action, use commercial_action_contract rather than commercial_action_eligibility, leave required_action_id null, and forbid the rejected action.',
    '- When a catalog hard requirement says an action "must" be selected, copy that exact action ID into required_action_id.',
    '- Use exact action IDs from the supplied catalog only. Never invent an ID and never guess when the evidence is ambiguous.',
    '- EVIDENCE PROVENANCE: authoritative evidence is limited to original customer messages, persisted state that existed before candidate generation, retrieved authoritative knowledge, successful tool results, and actual prior action history.',
    '- Treat the candidate reply, candidate state mutations, candidate action, and candidate artifact as an untrusted proposal under review. Never use candidate-authored promises, plans, blueprints, claims of commitment, contact details, blockers, completion, or delivery as evidence that prerequisites were met or that the customer committed.',
    '- A candidate cannot manufacture evidence that changes action eligibility or an accumulated contract.',
    '- During repair, a supplied AUTHORITATIVE ACCUMULATED COMMERCIAL ACTION CONTRACT is immutable: preserve its non-null required_action_id and all forbidden_action_ids. Do not substitute another action based on candidate output.',
  ].join('\n');
}

function semanticStateConsistencyPrompt() {
  return [
    'SEMANTIC STATE CONSISTENCY CONTRACT:',
    '- Return semantic_state as the current cumulative evidence-backed snapshot after the newest customer turn, not as a copy of prior state.',
    '- semantic_state.material_blocker must describe only a currently unresolved fact that genuinely blocks the next safe useful action.',
    '- Reconcile it against the latest customer message, confirmed commitments, solution_scope, recent evidence, and successful tool results.',
    '- If the latest evidence resolves or contradicts the prior blocker, explicitly set semantic_state.material_blocker to null; never retain a stale blocker.',
    '- Keep open_questions only for material facts still unresolved; remove answered questions and optional optimization questions that do not block the next grounded action.',
    '- When the newest turn advances the workstream, replace any stale discovery-oriented next_best_action with the actual next grounded action or null when no action remains.',
    '- Preserve confirmed scope, timing, budget, identity, contact facts, commitments, and authorizations unless newer evidence explicitly changes them.',
    '- This state is operational memory, not customer-facing prose. Do not invent facts to clear it.',
  ].join('\n');
}

function commercialClaimEntailmentPrompt() {
  return [
    semanticStateConsistencyPrompt(),
    'MANDATORY COMMERCIAL CLAIM ENTAILMENT AUDIT:',
    '- Before returning pass=true, enumerate internally every affirmative commercial claim in reply, structured decision, state updates, artifact, and commercial_action.',
    '- For each claim, identify the exact supporting evidence from original customer messages, persisted pre-candidate state, authoritative retrieved knowledge, or a successful current tool result.',
    '- A customer asking about a deposit or how to pay is not evidence of any answer. A grounded service price does not entail whether a deposit exists, whether full or partial payment is due, when an invoice or checkout is issued, which payment method applies, or any refund/cancellation term.',
    '- If any commercial claim lacks direct entailment, return pass=false with rule_id "commercial_claim_entailment". Do not let fluent wording, common industry practice, prior assistant text, or candidate-authored state count as support.',
    '- During correction, remove unsupported terms. State only that the exact term is not yet confirmed and give one grounded reversible next step. Do not replace one unsupported term with another.',
  ].join('\n');
}

function buildConformanceAssessmentPrompt(...args) {
  return buildConformanceAssessmentPromptBase(...args)
    + '\n\n'
    + commercialActionAssessmentContractPrompt()
    + '\n\n'
    + commercialClaimEntailmentPrompt();
}

function buildConformanceAssessmentRepairPrompt(...args) {
  return buildConformanceAssessmentRepairPromptBase(...args)
    + '\n\n'
    + commercialActionAssessmentContractPrompt()
    + '\n\n'
    + commercialClaimEntailmentPrompt();
}

function buildConformanceCorrectionPrompt(...args) {
  const basePrompt = buildConformanceCorrectionPromptBase(...args)
    + '\n\n'
    + commercialClaimEntailmentPrompt();
  const assessment = args.find(
    (arg) => arg
      && typeof arg === 'object'
      && !Array.isArray(arg)
      && arg.commercial_action_contract,
  );
  const directive = assessment?.commercial_action_contract;

  if (!directive) return basePrompt;

  const lines = [
    '',
    'MACHINE-ENFORCED COMMERCIAL ACTION DIRECTIVE:',
    '- This directive supersedes any earlier statement that a selected commercial action is immutable.',
  ];

  if (directive.required_action_id) {
    lines.push(
      '- commercial_action MUST be a non-null object conforming to the Brain Decision schema.',
      '- commercial_action.action_id MUST equal "'
        + directive.required_action_id
        + '".',
      '- This replacement is binding. Do not preserve, paraphrase, or reselect the rejected action.',
      '- Rebuild the action from the supplied catalog contract, including its evidence boundary, arguments, completion standard, and execution contract.',
    );
  }

  if (directive.forbidden_action_ids.length > 0) {
    lines.push(
      '- commercial_action.action_id MUST NOT be any of: '
        + directive.forbidden_action_ids.map((id) => `"${id}"`).join(', ')
        + '.',
    );
  }

  if (
    !directive.required_action_id
    && directive.forbidden_action_ids.length > 0
  ) {
    lines.push(
      '- If no distinct, independently eligible commercial action is justified, set commercial_action to null.',
      '- Do not select a renamed, equivalent, repeated, or weaker action merely to avoid null.',
    );
  }

  lines.push(
    '- Rebuild commercial_action arguments, assistant reply, state updates, and commitments so they are mutually consistent with this directive.',
    '- A correction that keeps a forbidden action or omits a required replacement is invalid even if its prose changes.',
    '- Preserve grounded facts and completed progress. Do not reopen discovery or invent access, provisioning, payment, or external side effects.',
  );

  return basePrompt + '\n' + lines.join('\n');
}

function commercialActionSelectionAllowedByContract(selection, contract) {
  const selectedId = (
    selection
    && typeof selection === 'object'
    && !Array.isArray(selection)
    && typeof selection.action_id === 'string'
  )
    ? selection.action_id
    : null;
  const requiredId = contract?.required_action_id || null;
  const forbiddenIds = Array.isArray(contract?.forbidden_action_ids)
    ? contract.forbidden_action_ids
    : [];

  if (requiredId && selectedId !== requiredId) return false;
  if (selectedId && forbiddenIds.includes(selectedId)) return false;
  return true;
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

const circuitStatePath =
  process.env.MODEL_CIRCUIT_STATE_PATH || path.join(path.dirname(runtimePath), 'model-circuit-state.json');
const circuitFailureThreshold = Math.max(1, Number(process.env.MODEL_CIRCUIT_FAILURE_THRESHOLD || 3));
const circuitCooldownMs = Math.max(1000, Number(process.env.MODEL_CIRCUIT_COOLDOWN_MS || 60000));
let circuitMutation = Promise.resolve();

function normalizedCircuitEntry(entry = {}) {
  return {
    state: ['closed', 'open', 'half_open'].includes(entry.state) ? entry.state : 'closed',
    consecutive_failures: Math.max(0, Number(entry.consecutive_failures || 0)),
    opened_at: entry.opened_at || null,
    retry_after: entry.retry_after || null,
    probe_started_at: entry.probe_started_at || null,
    last_error: String(entry.last_error || '').slice(0, 500),
    updated_at: entry.updated_at || null,
  };
}

function publicCircuitEntry(entry = {}) {
  return {
    ...normalizedCircuitEntry(entry),
    failure_threshold: circuitFailureThreshold,
    cooldown_ms: circuitCooldownMs,
  };
}

async function mutateCircuitState(mutator) {
  const operation = circuitMutation.then(async () => {
    const state = await readJson(circuitStatePath, { routes: {} });
    if (!state.routes || typeof state.routes !== 'object') state.routes = {};
    const mutation = mutator(state) || {};
    if (mutation.changed) await writeJson(circuitStatePath, state);
    return mutation.result;
  });
  circuitMutation = operation.catch(() => {});
  return operation;
}

async function acquireCircuit(route) {
  return mutateCircuitState((state) => {
    const entry = normalizedCircuitEntry(state.routes[route.id]);
    const currentMs = Date.now();
    const retryAfterMs = entry.retry_after ? Date.parse(entry.retry_after) : 0;
    const probeStartedMs = entry.probe_started_at ? Date.parse(entry.probe_started_at) : 0;

    if (entry.state === 'open' && retryAfterMs > currentMs) {
      return { result: { allowed: false, entry: publicCircuitEntry(entry) } };
    }

    if (entry.state === 'half_open' && probeStartedMs + circuitCooldownMs > currentMs) {
      return { result: { allowed: false, entry: publicCircuitEntry(entry) } };
    }

    if (entry.state === 'open' || entry.state === 'half_open') {
      const updated = {
        ...entry,
        state: 'half_open',
        probe_started_at: now(),
        updated_at: now(),
      };
      state.routes[route.id] = updated;
      return { changed: true, result: { allowed: true, entry: publicCircuitEntry(updated) } };
    }

    return { result: { allowed: true, entry: publicCircuitEntry(entry) } };
  });
}

async function recordCircuitSuccess(route) {
  return mutateCircuitState((state) => {
    const updated = {
      state: 'closed',
      consecutive_failures: 0,
      opened_at: null,
      retry_after: null,
      probe_started_at: null,
      last_error: '',
      updated_at: now(),
    };
    state.routes[route.id] = updated;
    return { changed: true, result: publicCircuitEntry(updated) };
  });
}

async function recordCircuitFailure(route, error) {
  return mutateCircuitState((state) => {
    const previous = normalizedCircuitEntry(state.routes[route.id]);
    const failures = previous.consecutive_failures + 1;
    const openImmediately = isAuthenticationError(error) || previous.state === 'half_open';
    const shouldOpen = openImmediately || failures >= circuitFailureThreshold;
    const currentMs = Date.now();
    const updated = {
      state: shouldOpen ? 'open' : 'closed',
      consecutive_failures: failures,
      opened_at: shouldOpen ? new Date(currentMs).toISOString() : null,
      retry_after: shouldOpen ? new Date(currentMs + circuitCooldownMs).toISOString() : null,
      probe_started_at: null,
      last_error: String(error?.message || error).slice(0, 500),
      updated_at: new Date(currentMs).toISOString(),
    };
    state.routes[route.id] = updated;
    return { changed: true, result: publicCircuitEntry(updated) };
  });
}

export async function getModelRoutes() {
  const [base, runtime, circuitState] = await Promise.all([
    readJson(configPath, { routes: [] }),
    readJson(runtimePath, null),
    readJson(circuitStatePath, { routes: {} }),
  ]);
  const source = runtime && Array.isArray(runtime.routes) ? runtime : base;
  return {
    routes: source.routes
      .map((route) => ({
        ...route,
        priority: Number(route.priority || 999),
        circuit_breaker: publicCircuitEntry(circuitState.routes?.[route.id]),
      }))
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
      ...(route.supports_reasoning === undefined
        ? {}
        : { supports_reasoning: Boolean(route.supports_reasoning) }),
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

export function normalizeCommercialAction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const action = raw;
  const payload = action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload)
    ? action.payload
    : {};
  const nestedArgs = action.arguments && typeof action.arguments === 'object' && !Array.isArray(action.arguments)
    ? action.arguments
    : payload;
  const sources = [action, nestedArgs, payload];
  const firstValue = (...keys) => {
    for (const source of sources) {
      for (const key of keys) {
        if (source[key] !== undefined && source[key] !== null) return source[key];
      }
    }
    return null;
  };
  const firstText = (...keys) => {
    for (const source of sources) {
      for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    }
    return null;
  };
  const amount = Number(firstValue(
    'grounded_total_usd',
    'grounded_total',
    'total_grounded_amount',
    'total_usd',
  ));

  return {
    action_id: firstText('action_id', 'type'),
    selection_reason: firstText('selection_reason') || '',
    requested_commitment: firstText('requested_commitment'),
    arguments: {
      option_id: firstText('option_id', 'payment_option_id'),
      grounded_total_usd: Number.isFinite(amount) && amount > 0 ? amount : null,
      grounding_reference: firstText('grounding_reference'),
      missing_fact: firstText('missing_fact'),
      customer_commitment: firstText('customer_commitment'),
      authorization_is_explicit: firstValue('authorization_is_explicit') === true,
      authorization_is_unambiguous: firstValue('authorization_is_unambiguous') === true,
      authorization_evidence: firstText('authorization_evidence', 'authorization_phrase'),
      authorization_scope: firstText('authorization_scope'),
    },
  };
}

function normalizeDecision(raw) {
  const profile = mergeContactProfiles(raw);
  const semanticState = deriveSemanticState(raw);
  const candidateAction =
    typeof raw.action === 'string' && ['reply', 'silent', 'escalate'].includes(raw.action)
      ? raw.action
      : null;
  const shouldEscalate = raw.should_escalate === true || candidateAction === 'escalate';
  const shouldReply = shouldEscalate || (
    candidateAction === 'silent' ? false : raw.should_reply !== false
  );
  const escalationReason =
    typeof raw.escalation_reason === 'string' && raw.escalation_reason.trim()
      ? raw.escalation_reason.trim()
      : shouldEscalate
        ? 'model_requested_handoff'
        : null;
  return {
    // Preserve schema-validated semantic and commercial planning fields across
    // draft, review, and execution passes. Normalized runtime fields below
    // intentionally override their raw counterparts.
    ...raw,
    reply: typeof raw.reply === 'string' ? raw.reply.trim() : '',
    response_language: typeof raw.response_language === 'string' ? raw.response_language.trim() : '',
    reply_language_consistent: raw.reply_language_consistent === true,
    action: shouldEscalate ? 'escalate' : shouldReply ? 'reply' : 'silent',
    should_reply: shouldReply,
    should_escalate: shouldEscalate,
    escalation_reason: escalationReason,
    confidence: Math.max(0, Math.min(1, Number(raw.confidence || 0))),
    conversation_summary: typeof raw.conversation_summary === 'string' ? raw.conversation_summary.trim() : '',
    contact_profile: profile,
    contact_profile_patch: profile,
    commercial_action: normalizeCommercialAction(raw.commercial_action),
    semantic_state: semanticState,
  };
}

const modelTurnBudget = new AsyncLocalStorage();

function effectiveModelTimeout(defaultMs) {
  const configured = Number(process.env.MODEL_TIMEOUT_MS || defaultMs);
  const requested = Number.isFinite(configured) && configured > 0 ? configured : defaultMs;
  const deadline = modelTurnBudget.getStore()?.deadline;
  if (!deadline) return requested;

  const remaining = deadline - Date.now();
  if (remaining <= 1000) {
    const error = new Error('Model turn budget exceeded');
    error.code = 'MODEL_TURN_BUDGET_EXCEEDED';
    throw error;
  }

  return Math.max(1000, Math.min(requested, remaining));
}

async function runProcess(command, args, input, timeoutMs) {
  const result = await runModelProcess({
    command,
    args,
    input,
    cwd: root,
    env: process.env,
    timeoutMs,
    graceMs: Number(process.env.MODEL_PROCESS_GRACE_MS || 1500),
    maxStdoutBytes: Number(process.env.MODEL_PROCESS_MAX_STDOUT_BYTES || 1_048_576),
    maxStderrBytes: Number(process.env.MODEL_PROCESS_MAX_STDERR_BYTES || 131_072),
  });
  return typeof result === 'string' ? result : result.stdout;
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
  return runProcess(process.env.CODEX_BIN || 'codex', args, prompt, effectiveModelTimeout(180000));
}

import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

const brainDecisionSchema = JSON.parse(
  readFileSync(new URL('../schemas/brain-decision.schema.json', import.meta.url), 'utf8'),
);
const validateBrainDecision = new Ajv2020({ allErrors: true, strict: false }).compile(brainDecisionSchema);

export function reconcileCommercialTransition(rawDecision) {
  const selectedAction = rawDecision?.commercial_action?.action_id || null;
  return {
    ...rawDecision,
    commercial_next_step: {
      ...rawDecision.commercial_next_step,
      action_required: selectedAction !== null,
      action_id: selectedAction,
    },
  };
}

export function assertCommercialTransitionConsistency(rawDecision) {
  const nextStep = rawDecision?.commercial_next_step || {};
  const selectedAction = rawDecision?.commercial_action?.action_id || null;
  const actionRequired = nextStep.action_required;
  const declaredAction = nextStep.action_id ?? null;
  const consistent = actionRequired === true
    ? Boolean(selectedAction && declaredAction && selectedAction === declaredAction)
    : actionRequired === false
      ? selectedAction === null && declaredAction === null
      : false;

  if (!consistent) {
    const error = new Error('Model commercial transition contract is inconsistent');
    error.code = 'model_contract_invalid';
    error.details = [{
      path: '/commercial_next_step',
      message: 'action_required, action_id, and commercial_action.action_id must agree',
    }];
    throw error;
  }
  return rawDecision;
}

export function assertRawDecisionContract(rawDecision) {
  if (validateBrainDecision(rawDecision)) {
    // Preserve the model's declared commercial transition until the bounded
    // structural-review pass has inspected it. Reconciliation here used to
    // erase contradictions (for example proposal_ready with no selected
    // action), which prevented the corrective pass from ever seeing them.
    return rawDecision;
  }

  const details = (validateBrainDecision.errors || [])
      .slice(0, 64)
    .map((error) => `${error.instancePath || '/'} ${error.keyword} ${error.message || 'invalid'}`)
    .join('; ');
  const error = new Error(`model_contract_invalid:${details || 'schema validation failed'}`);
  error.code = 'model_contract_invalid';
  throw error;
}

export function buildOpenAIResponseRequest(route, prompt) {
  const body = {
    model: route.model,
    input: prompt,
    text: {
      format: {
        type: 'json_schema',
        name: 'brain_decision',
        schema: brainDecisionSchema,
        strict: true,
      },
    },
  };

  if (route.supports_reasoning === true) {
    body.reasoning = { effort: route.reasoning_effort || 'low' };
  }

  return body;
}

async function callOpenAI(route, prompt) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + process.env.OPENAI_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildOpenAIResponseRequest(route, prompt)),
      signal: AbortSignal.timeout(effectiveModelTimeout(180000)),
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error('OpenAI ' + response.status + ': ' + JSON.stringify(body).slice(0, 1500));
    error.status = response.status;
    error.provider = 'openai';
    error.code = body?.error?.code || `HTTP_${response.status}`;
    throw error;
  }
  return body.output_text || body.output?.flatMap((item) => item.content || []).map((item) => item.text || '').join('') || '';
}

async function callDeepSeekOnce(route, prompt, { repair = false } = {}) {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is missing');
  const requestBody = {
    model: route.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: Number(
      repair
        ? (process.env.DEEPSEEK_REPAIR_MAX_TOKENS || process.env.DEEPSEEK_MAX_TOKENS || 8192)
        : (process.env.DEEPSEEK_MAX_TOKENS || 8192),
    ),
    response_format: { type: 'json_object' },
  };
  if (!repair) {
    requestBody.thinking = { type: 'enabled' };
    requestBody.reasoning_effort = String(route.reasoning_effort || 'high').toLowerCase() === 'max'
      ? 'max'
      : 'high';
  }
  const response = await fetch((process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com') + '/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + process.env.DEEPSEEK_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(effectiveModelTimeout(
        Number(process.env.DEEPSEEK_TIMEOUT_MS || 105000),
      )),
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error('DeepSeek ' + response.status + ': ' + JSON.stringify(body).slice(0, 1500));
    error.status = response.status;
    error.provider = 'deepseek';
    error.code = body?.error?.code || `HTTP_${response.status}`;
    throw error;
  }
  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  const finishReason = String(choice?.finish_reason || '');
  if (finishReason === 'length') {
    const error = new Error('DeepSeek contract output was truncated at the token limit');
    error.code = 'MODEL_CONTRACT_ERROR';
    throw error;
  }
  if (typeof content !== 'string' || !content.trim()) {
    const error = new Error(`DeepSeek returned empty contract output (finish_reason=${finishReason || 'unknown'})`);
    error.code = 'MODEL_CONTRACT_ERROR';
    throw error;
  }
  return content;
}

async function callDeepSeek(route, prompt) {
  prompt = `${prompt}

Durable contact-memory extraction contract:
- Treat explicit identity, organization, and follow-up details in the latest customer message as durable facts, not merely conversational content.
- Always include every newly stated or corrected durable fact in the decision's contact_profile_patch, even when the customer-facing reply also acknowledges it.
- Use canonical keys whenever applicable: name, business_name, email, phone, preferred_channel, preferred_contact_time, and timezone.
- A stated contact window, availability, or timezone is a durable contact fact and must not be omitted.
- Emit only facts explicitly provided by the customer or safely normalized from those facts. The object is a patch: include new or corrected facts and do not erase previously known facts.
- Continue to obey the existing decision JSON schema and all grounding, safety, and commercial-action requirements.`;

  const configuredAttempts = Number(process.env.DEEPSEEK_CONTRACT_ATTEMPTS || 2);
  const attempts = Number.isFinite(configuredAttempts)
    ? Math.max(1, Math.min(3, Math.trunc(configuredAttempts)))
    : 1;
  let currentPrompt = prompt;
  let lastError;
  let previousOutput = '';
  let previousDecision = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const output = await callDeepSeekOnce(route, currentPrompt, {
        repair: attempt > 1 && Boolean(previousOutput),
      });
      previousOutput = output;
      previousDecision = extractJson(output);
      const validatedDecision = assertRawDecisionContract(previousDecision);
      validateDecisionContract(normalizeDecision(validatedDecision));
      return output;
    } catch (error) {
      lastError = error;
      const contractRepairable = (
        error?.code === 'model_contract_invalid'
        || error?.code === 'MODEL_CONTRACT_ERROR'
      );
      if ((!contractRepairable && !retryable(error)) || attempt >= attempts) throw error;
      const previousResponse = (
        previousDecision
          ? JSON.stringify(previousDecision)
          : String(previousOutput || '').trim()
      ).slice(0, 9000);
      currentPrompt = previousResponse
        ? [
          prompt,
          '',
          'CONTRACT REPAIR RETRY',
          `Validation error: ${String(error?.message || error)}`,
          'Your previous response was:',
          previousResponse,
          '',
          'Return one corrected, complete JSON object only. It must satisfy the exact contract in the original request.',
          'Do not add Markdown or prose outside JSON.',
          'When should_reply is true, reply must be the actual substantive customer-facing answer for this turn, not a placeholder, status note, or empty value.',
          'Use should_reply=false only when the original system context explicitly requires silence.',
          'Preserve grounded facts and conversation state from the original request. Do not invent facts or actions.',
        ].join('\n')
        : prompt;
    }
  }

  throw lastError;
}

export function hasSubstantiveReply(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  const lexicalContent = text
    .replace(/[\s.,!?;:…"'`*_#~()[\]{}<>/\\|+=-]+/gu, '')
    .trim();
  return lexicalContent.length >= 2;
}

export function validateDecisionContract(decision) {
  if (decision.should_reply && !hasSubstantiveReply(decision.reply)) {
    const error = new Error('Model contract violation: should_reply=true requires a substantive reply');
    error.code = 'MODEL_CONTRACT_ERROR';
    throw error;
  }

  return decision;
}

export function isQuotaExhaustionError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? 0);
  if (status === 429) return true;
  const message = String(error?.message || error).toLowerCase();
  return /quota|usage limit|rate.?limit|too many requests|insufficient_quota|resource_exhausted|0 (?:weighted )?tokens? left|limit resets?/.test(message);
}

function isAuthenticationError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? 0);
  if (status === 401 || status === 403) return true;
  const message = String(error?.message || error).toLowerCase();
  return /(?:401|403)|invalid (?:api )?key|invalid authentication|authentication failed|unauthorized|forbidden/.test(message);
}

function retryable(error) {
  if (error?.code === 'MODEL_CONTRACT_ERROR') return true;
  const message = String(error?.message || error).toLowerCase();
  return /quota|rate.?limit|too many requests|429|usage limit|capacity|overloaded|temporarily unavailable|timed out|timeout|econnreset|fetch failed|network|socket|502|503|504|model did not return a valid json object/.test(message);
}

function recoverableRouteError(error) {
  return retryable(error) || isAuthenticationError(error);
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
    const circuit = await acquireCircuit(route);
    if (!circuit.allowed) {
      const error = new Error(`model circuit is open for ${route.id} until ${circuit.entry.retry_after || 'a probe is available'}`);
      error.code = 'MODEL_CIRCUIT_OPEN';
      failures.push({
        route: route.id,
        model: route.model,
        error: error.message,
        retryable: true,
        fallback: index < enabled.length - 1,
        latencyMs: 0,
      });
      await updateHealth(route, 'circuit_open', error.message);
      if (hooks.onFailure) await hooks.onFailure(route, error, index < enabled.length - 1);
      continue;
    }
    const startedAt = Date.now();
    try {
      let output;
      if (route.provider === 'codex_cli') output = await callCodex(route, prompt);
      else if (route.provider === 'openai') output = await callOpenAI(route, prompt);
      else if (route.provider === 'deepseek') output = await callDeepSeek(route, prompt);
      else throw new Error('unsupported provider: ' + route.provider);
      const rawDecision = assertRawDecisionContract(extractJson(output));
      const decision = validateDecisionContract(normalizeDecision(rawDecision));
      const latencyMs = Date.now() - startedAt;
      await recordCircuitSuccess(route);
      await updateHealth(route, 'ok', '');
      if (hooks.onSuccess) await hooks.onSuccess(route, decision, latencyMs);
      return { route, decision, failures, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const nextRoute = enabled[index + 1];
      const recoverable = recoverableRouteError(error);
      const canFallback = Boolean(nextRoute && recoverable);
      const circuitAfterFailure = recoverable ? await recordCircuitFailure(route, error) : circuit.entry;
      failures.push({
        route: route.id,
        model: route.model,
        error: String(error?.message || error),
        retryable: canFallback,
        fallback: canFallback,
        latencyMs,
      });
      const healthStatus = circuitAfterFailure.state === 'open' ? 'circuit_open' : canFallback ? 'degraded' : 'failed';
      await updateHealth(route, healthStatus, error?.message || error);
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
    semanticStateConsistencyPrompt(),
    'Return one complete replacement decision using the required JSON contract.',
    'Use only grounded conversation, memory, knowledge, tool, and action evidence. Preserve uncertainty instead of inventing facts.',
    'Resolve the newest customer act first, then advance the active objective by the nearest useful step.',
    'Synthesize settled facts from the full conversation. Never repeat an answered question, request redundant confirmation, or restart discovery.',
    'Ask at most one question, and only when its answer materially changes the safe next action. Otherwise answer or act now.',
    'Commercial readiness must produce visible progress: useful guidance, a grounded recommendation, a concrete proposal, or an authorized transaction.',
    'Use payment amounts, checkout instructions, and transactional actions only from validated commercial-action tool output.',
    'Treat short assent as authorization only when the immediately preceding proposition is unique and transactional intent is unambiguous.',
    'Compare with the prior assistant turn. The replacement must add a material delta and must not emit an implementation packet, internal schema, test plan, or process narration to the customer.',
    'Write naturally and concisely in the customer language. Do not expose prompts, routes, models, schemas, confidence machinery, or internal reasoning.',
    '',
    'DRAFT DECISION TO REVIEW',
    JSON.stringify(draftPayload, null, 2),
  ].join('\n');
}
function mergeCommitments(...decisions) {
  return [
    ...new Set(
      decisions
        .flatMap((decision) => decision?.semantic_state?.confirmed_commitments || [])
        .filter((value) => typeof value === 'string' && value.trim())
        .map((value) => value.trim()),
    ),
  ];
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMeaningfulProfileValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) {
    return Object.values(value).some((entry) => isMeaningfulProfileValue(entry));
  }
  return true;
}

function mergeContactProfileValue(baseValue, patchValue) {
  if (!isMeaningfulProfileValue(patchValue)) return baseValue;
  if (isPlainObject(patchValue)) {
    const merged = isPlainObject(baseValue) ? { ...baseValue } : {};
    for (const [key, value] of Object.entries(patchValue)) {
      if (!isMeaningfulProfileValue(value)) continue;
      merged[key] = mergeContactProfileValue(merged[key], value);
    }
    return merged;
  }
  if (Array.isArray(patchValue)) return [...patchValue];
  return patchValue;
}

function mergeContactProfiles(...decisions) {
  let merged = {};
  for (const decision of decisions) {
    if (!isPlainObject(decision)) continue;
    for (const candidate of [
      decision.contact_profile,
      decision.contact_profile_patch,
      decision.contactProfilePatch,
    ]) {
      if (!isPlainObject(candidate)) continue;
      merged = mergeContactProfileValue(merged, candidate);
    }
  }
  return merged;
}

function preserveContactProfile(targetDecision, ...sourceDecisions) {
  if (!isPlainObject(targetDecision)) return targetDecision;
  const merged = mergeContactProfiles(
    ...sourceDecisions,
    targetDecision,
  );
  targetDecision.contact_profile = merged;
  targetDecision.contact_profile_patch = merged;
  return targetDecision;
}

const SEMANTIC_CONFORMANCE_RULES = Object.freeze({
  newest_act_fidelity:
    'The reply is faithful to the newest user message, current workstream, conversation evidence, retrieved knowledge, and confirmed commitments. It materially incorporates each new fact into the result or next question rather than merely mentioning it while repeating the prior result or question.',
  newest_act_priority:
    'Resolve the newest conversational act before readiness or sales logic. First identify its semantic speech act from the whole utterance and conversation context; do not infer a price request merely because payment, cost, or money is mentioned. Answer an explicit informational question immediately with the narrowest grounded answer or truthful limitation available, then ask at most one high-information question when needed. Apply pricing guidance only when the customer is actually requesting a price, cost, quote, fee, amount, or range: for underspecified pricing, provide at most the single narrowest relevant verified catalog or example anchor, label it non-personalized, and ask exactly one material scope question. Reflective questions about trust, process, sequencing, risk, or what happens before payment require a direct process or risk answer, not an unsolicited price.',
  direct_input_request:
    'When the customer asks what information or inputs are needed to scope, start, or proceed, answer with a concise prioritized input brief before asking anything; distinguish needed-now inputs from details that can wait, integrate known facts, and ask at most one question that materially changes the immediate result.',
  newest_act_independence:
    'Handle a materially distinct newest request independently before using earlier context; earlier unanswered workstreams cannot be a prerequisite or sole frame unless the customer explicitly creates that dependency.',
  informational_price_not_authorization:
    'Price and payment-arrangement questions require an informational response grounded in verified evidence and never authorize a transaction. Answering price and executing checkout are separate. When exact personalized price is ungrounded, provide only one narrowest verified catalog or example anchor explicitly labeled as non-personalized, or a transparent limitation when no relevant anchor exists; never present multiple distant catalog points, and identify one material missing scope dimension in exactly one question.',
  ambiguous_assent:
    'Preserve ambiguity when short assent could refer to multiple propositions; ask one precise referent question and infer no authorization.',
  visible_progress:
    'Create the visible progress required by the nearest eligible action rather than merely acknowledging, summarizing, paraphrasing, or restarting discovery. When supported scope is sufficient, build the most useful bounded artifact from supported facts and preserve unknowns as clearly labeled open inputs. When one unresolved material fact prevents any honest artifact or execution step, one grounded highest-information clarification question is valid progress. Never force an artifact whose usefulness depends on invented scope.',
  committed_progression:
    'After unambiguous commitment to an identified service, advance to the nearest eligible executable action rather than returning to collateral, audit, or discovery without a genuine blocker.',
  commercial_action_eligibility:
    'Honor commercial-action eligibility, ineligibility, repeat policy, completion standard, and execution contract exactly. Eligibility must be supported by customer facts, authoritative tenant knowledge, verified customer-provenance memory, or successful current tool results. Generic assent cannot establish omitted material scope from assistant-authored questions, examples, options, or summaries. If the selected action requires a uniquely relevant artifact but confirmed scope is insufficient, reject that action and select the nearest eligible clarification action or null.',
  pending_execution_input:
    'When one indispensable customer-controlled fact genuinely blocks execution, preserve that exact blocker and explain the concrete action it unlocks.',
  resolved_fact_non_repetition:
    'Do not ask again for a fact or decision already supplied or resolved by customer evidence.',
  evidence_grounding:
    'Use only facts supported by the original customer message, retrieved knowledge, conversation memory, or completed tool results. Never invent capabilities, integration support, prices, timelines, scope, authorization, promises, commitments, or completed actions. When information is absent, omit it or preserve it as an explicit open input; never repair one unsupported claim by substituting another.',
  commercial_claim_entailment:
    'Every affirmative commercial claim in the customer-visible reply or structured decision, including whether a deposit is required or not, whether payment is full or partial, payment timing or method, invoice or checkout timing, discounts, refunds, cancellations, exact amount, currency, or schedule, must be directly entailed by applicable authoritative retrieved knowledge or a successful current commercial tool result. A customer question, generic service price, common practice, candidate output, or prior assistant assertion is not evidence. If exact terms are absent, state that they are unconfirmed, keep commercial_action null unless independently eligible, and offer one grounded reversible next step.',
  numeric_grounding:
    'Use only grounded prices, amounts, currencies, payment terms, timelines, and guarantees that apply to the active scope.',
  no_unverified_side_effects:
    'Claim external side effects only when an authoritative validated tool result proves they occurred.',
  single_clear_next_action:
    'Recommend at most one clear context-appropriate next action; do not present competing calls to action.',
  escalation_consistency:
    'Honor escalation state and silence/reset contracts exactly.',
  final_delivery_exactness:
    'When an action result is authoritative, preserve its validated state transition and required customer-visible outcome without semantic regression.',
  reply_native_artifact:
    'Fulfill the selected eligible action directly in the customer reply. For artifact or answer actions, provide the actual useful artifact or answer rather than meta-instructions, a future-answer promise, or internal reasoning. For an eligible clarification action, the direct grounded clarification question is the required reply-native deliverable; do not invent an artifact to satisfy this rule.',
  commercial_action_contract:
    'Honor the authoritative required and forbidden commercial-action IDs exactly before execution.',
});

const SEMANTIC_ASSESSOR_RULE_CATALOG = Object.entries(
  SEMANTIC_CONFORMANCE_RULES,
)
  .map(([ruleId, rule]) => `- ${ruleId}: ${rule}`)
  .join('\n');

function canonicalConformanceRuleId(violation) {
  const explicit =
    typeof violation?.rule_id === 'string' ? violation.rule_id.trim() : '';
  if (
    Object.prototype.hasOwnProperty.call(
      SEMANTIC_CONFORMANCE_RULES,
      explicit,
    )
  ) {
    return explicit;
  }

  const legacy =
    typeof violation?.principle === 'string'
      ? violation.principle.trim()
      : '';
  if (
    Object.prototype.hasOwnProperty.call(
      SEMANTIC_CONFORMANCE_RULES,
      legacy,
    )
  ) {
    return legacy;
  }

  return '';
}

function validateConformanceAssessmentBase(raw) {
  const fail = (message) => {
    const error = new Error(`Semantic conformance contract violation: ${message}`);
    error.code = 'MODEL_CONTRACT_ERROR';
    throw error;
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('expected an object');
  }
  if (typeof raw.passes !== 'boolean') {
    fail('passes must be boolean');
  }
  if (typeof raw.replacement_required !== 'boolean') {
    fail('replacement_required must be boolean');
  }
  if (!Array.isArray(raw.violations)) {
    fail('violations must be an array');
  }

  const violations = raw.violations.map((violation, index) => {
    if (!violation || typeof violation !== 'object' || Array.isArray(violation)) {
      fail(`violations[${index}] must be an object`);
    }

    const ruleId = canonicalConformanceRuleId(violation);
    const evidence =
      typeof violation.evidence === 'string' ? violation.evidence.trim() : '';
    const diagnosticGuidance =
      typeof violation.required_change === 'string'
        ? violation.required_change.trim()
        : '';

    if (!ruleId) {
      fail(
        `violations[${index}].rule_id must be one of ${Object.keys(
          SEMANTIC_CONFORMANCE_RULES,
        ).join(', ')}`,
      );
    }
    if (!evidence || !diagnosticGuidance) {
      fail(`violations[${index}] requires evidence and required_change`);
    }

    return {
      rule_id: ruleId,
      principle: SEMANTIC_CONFORMANCE_RULES[ruleId],
      evidence,
      required_change: SEMANTIC_CONFORMANCE_RULES[ruleId],
    };
  });

  if (raw.passes && (raw.replacement_required || violations.length > 0)) {
    fail('a passing assessment cannot require replacement or contain violations');
  }
  if (!raw.passes && (!raw.replacement_required || violations.length === 0)) {
    fail('a failing assessment must require replacement and contain violations');
  }

  return {
    passes: raw.passes,
    replacement_required: raw.replacement_required,
    violations,
  };
}

function selectedCommercialActionId(decision) {
  const action = decision?.commercial_action;
  const rawActionId = action?.action_id ?? action?.id;
  return typeof rawActionId === 'string' && rawActionId.trim()
    ? rawActionId.trim()
    : null;
}

function emptyCommercialActionArguments() {
  return {
    option_id: null,
    offer_id: null,
    grounded_total_usd: null,
    grounding_reference: null,
    missing_fact: null,
    customer_commitment: null,
    authorization_is_explicit: false,
    authorization_is_unambiguous: false,
    authorization_evidence: null,
    authorization_scope: null,
  };
}

function flatCommercialActionArguments(action) {
  const flat = {
    option_id: action.option_id,
    grounded_total_usd:
      action.grounded_total_usd !== undefined
        ? action.grounded_total_usd
        : action.grounded_total,
    grounding_reference: action.grounding_reference,
    missing_fact: action.missing_fact,
    customer_commitment: action.customer_commitment,
    authorization_is_explicit: action.authorization_is_explicit,
    authorization_is_unambiguous: action.authorization_is_unambiguous,
    authorization_evidence: action.authorization_evidence,
    authorization_scope: action.authorization_scope,
  };

  return Object.fromEntries(
    Object.entries(flat).filter(([, value]) => value !== undefined),
  );
}

export function canonicalCommercialAction(
  action,
  requiredActionId,
  decision,
) {
  const canonical =
    action && typeof action === 'object'
      ? structuredClone(action)
      : {};

  delete canonical.id;
  canonical.action_id = requiredActionId;
  canonical.selection_reason =
    typeof canonical.selection_reason === 'string' &&
    canonical.selection_reason.trim()
      ? canonical.selection_reason.trim()
      : `Required by the authoritative semantic commercial-action assessment: ${requiredActionId}.`;
  canonical.requested_commitment =
    typeof canonical.requested_commitment === 'string'
      ? canonical.requested_commitment.trim() || null
      : null;
  const flatArguments = flatCommercialActionArguments(canonical);
  const nestedArguments =
    canonical.arguments && typeof canonical.arguments === 'object'
      ? canonical.arguments
      : {};
  canonical.arguments = {
    ...emptyCommercialActionArguments(),
    ...flatArguments,
    ...nestedArguments,
  };
  for (const key of [
    'option_id',
    'grounded_total_usd',
    'grounded_total',
    'grounding_reference',
    'missing_fact',
    'customer_commitment',
    'authorization_is_explicit',
    'authorization_is_unambiguous',
    'authorization_evidence',
    'authorization_scope',
    'deposit_amount',
    'currency',
  ]) {
    delete canonical[key];
  }

  if (
    ['request_execution_input', 'request_required_fact'].includes(
      requiredActionId,
    ) &&
    typeof decision?.reply === 'string' &&
    decision.reply.trim()
  ) {
    const semanticRequest = decision.reply.trim();
    canonical.requested_commitment =
      canonical.requested_commitment || semanticRequest;
    canonical.arguments.missing_fact =
      canonical.arguments.missing_fact || semanticRequest;
  }

  return canonical;
}

function enforceCommercialActionContract(
  decision,
  contract,
  sourceDecisions = [],
) {
  if (
    !decision ||
    typeof decision !== 'object' ||
    !contract ||
    typeof contract !== 'object'
  ) {
    return decision;
  }

  const requiredActionId =
    typeof contract.required_action_id === 'string'
      ? contract.required_action_id.trim()
      : null;
  const forbiddenActionIds = Array.isArray(contract.forbidden_action_ids)
    ? contract.forbidden_action_ids
    : [];

  if (requiredActionId) {
    const sourceDecision = [
      ...sourceDecisions.slice().reverse(),
      decision,
    ].find(
      (candidate) =>
        selectedCommercialActionId(candidate) === requiredActionId,
    );
    decision.commercial_action = canonicalCommercialAction(
      sourceDecision?.commercial_action ?? null,
      requiredActionId,
      decision,
    );
  } else {
    const selectedActionId = selectedCommercialActionId(decision);
    if (selectedActionId && forbiddenActionIds.includes(selectedActionId)) {
      decision.commercial_action = null;
    }
  }

  return decision;
}

function findCommercialActionContractViolation(decision, contract) {
  if (!contract || typeof contract !== 'object') {
    return null;
  }

  const selectedActionId = selectedCommercialActionId(decision);
  const requiredActionId =
    typeof contract.required_action_id === 'string'
      ? contract.required_action_id.trim()
      : null;
  const forbiddenActionIds = Array.isArray(contract.forbidden_action_ids)
    ? contract.forbidden_action_ids
    : [];

  if (requiredActionId && selectedActionId !== requiredActionId) {
    return {
      rule_id: 'commercial_action_contract',
      principle: 'commercial_action_contract',
      evidence: `The corrected decision selected ${
        selectedActionId || 'no commercial action'
      }, but the authoritative semantic assessment requires ${requiredActionId}.`,
      required_change: `Select exactly ${requiredActionId} before any commercial tool execution.`,
    };
  }

  if (selectedActionId && forbiddenActionIds.includes(selectedActionId)) {
    return {
      rule_id: 'commercial_action_contract',
      principle: 'commercial_action_contract',
      evidence: `The corrected decision selected forbidden commercial action ${selectedActionId}.`,
      required_change:
        requiredActionId
          ? `Select exactly ${requiredActionId} before any commercial tool execution.`
          : 'Remove the forbidden commercial action before any commercial tool execution.',
    };
  }

  return null;
}

const configuredConformanceCorrections = Number(
  process.env.MODEL_RUNTIME_MAX_CORRECTIONS || 1,
);
const MAX_CONFORMANCE_CORRECTIONS = Number.isFinite(configuredConformanceCorrections)
  ? Math.max(0, Math.min(3, Math.trunc(configuredConformanceCorrections)))
  : 1;
const MAX_CONFORMANCE_ASSESSMENT_ATTEMPTS = 4;

function mergeConformanceViolations(...collections) {
  const seen = new Set();
  const merged = [];

  for (const violation of collections.flat()) {
    const key = JSON.stringify([
      violation?.rule_id || violation?.principle || "",
      violation?.evidence || "",
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(violation);
  }

  return merged;
}

function buildRejectedResultLedger(decisions = []) {
  const seen = new Set();
  const entries = [];

  for (const decision of decisions) {
    if (!decision) continue;
    const reply = String(decision.reply || "").trim();
    const signature = reply.toLocaleLowerCase().replace(/\s+/g, " ");
    if (!reply || seen.has(signature)) continue;
    seen.add(signature);
    entries.push({
      reply,
      active_goal: decision.semantic_state?.active_goal ?? null,
      next_best_action: decision.semantic_state?.next_best_action ?? null,
      unresolved_items: decision.semantic_state?.unresolved_items ?? [],
      pending_customer_commitment:
        decision.semantic_state?.pending_customer_commitment ??
        decision.pending_customer_commitment ??
        null,
      commercial_action_id: decision.commercial_action?.id ?? null,
      commercial_action_status: decision.commercial_action?.status ?? null,
    });
  }

  return entries.slice(-5).map((entry, index) => ({
    rejected_attempt: index + 1,
    ...entry,
  }));
}

function buildConformanceAssessmentPromptBase(originalPrompt, candidateDecision) {
  return `${originalPrompt}

INDEPENDENT SEMANTIC RELEASE GATE
You are not continuing the conversation. Independently decide whether the candidate Brain Decision is safe and useful to release.
Reason from meaning and evidence. Do not use keyword matching, language-specific branches, canned dialogue, or rigid sales templates.

CANONICAL RULE-ID CONTRACT
For each violation, select exactly one rule_id from this catalog:
${SEMANTIC_ASSESSOR_RULE_CATALOG}
Do not invent rule IDs or encode a new policy in principle or required_change. The rule_id identifies the binding policy; evidence must describe only the candidate-specific observed failure. required_change is diagnostic compatibility text and cannot modify, narrow, expand, or reverse the canonical rule.

Candidate Brain Decision:
${JSON.stringify(candidateDecision)}

Pass only when all principles hold:
- The reply is faithful to the newest user message, current workstream, conversation evidence, retrieved knowledge, and confirmed commitments.
- It resolves the newest conversational act before general readiness logic: a direct informational question is answered directly and is not replaced by an adjacent offer, audit, package, estimate, or call to action.
- A materially distinct newest request is handled independently before earlier context is used: the reply provides a direct response plus useful request-specific orientation or progress; it does not make earlier context a prerequisite or sole frame, and it does not merely paraphrase the request before asking a scope question.
- It treats a price or payment-arrangements question as informational rather than transactional authorization, and states only grounded terms relevant to the active scope.
- If short assent follows multiple propositions or options, it preserves ambiguity and asks one precise referent question without inferring authorization, presenting checkout, or substituting a new offer.
- The reply creates visible progress rather than merely acknowledging, summarizing, or restarting discovery.
- If the newest customer act asks what information, inputs, materials, or decisions are needed to scope, start, or proceed, directly deliver a concise prioritized input brief before asking anything. Preserve known facts, distinguish minimum inputs needed now from details that can wait, name the immediate result those inputs unlock, and ask at most one question whose answer materially changes that result.
- An unambiguous commitment to proceed with an identified service plus a request for the next step selects and presents the nearest eligible executable action. Another brief, FAQ, workflow, protocol, audit, plan, recap, or discovery loop fails unless explicitly requested or uniquely required to resolve a genuine execution blocker.
- Catalog eligibility, ineligibility, repeat_policy, and completion_standard are binding. Retaining an action that is spent or unavailable because of prior delivered artifacts or state fails; the decision must reselect an eligible action and rebuild its arguments, reply, and state delta.
   - A pending request_execution_input remains eligible while its exact indispensable blocker is unanswered. Keep its action and arguments stable; repeat_policy changes the presentation, not the selected action.
   - It does not repeat an answered or resolved discovery question. An unanswered material question remains open. When the newest inbound provides no relevant fact that resolves a pending execution blocker, the reply may restate that same blocker naturally while acknowledging the newest act, but must not mechanically repeat identical wording or invent progress.
   - When the binding action is request_execution_input and customer_input_allowed=true, the single question connects the newest customer act to the unchanged blocker and explains its concrete decision consequence. When grounded alternatives are known, it states how materially different answers select materially different immediate execution paths; otherwise it states precisely why execution cannot proceed without the fact. A generic promise to begin or configure later is insufficient.
   - When the binding action is request_required_fact and customer_input_allowed=true, one question is valid only if it integrates the newest material customer fact, narrows the uncertainty, explains why the answer changes the immediate result, and is the sole genuine blocker.
   - When the binding action is deliver_input_brief and customer_input_allowed=true, the reply directly answers what inputs are needed before asking anything, preserves known facts, separates minimum inputs needed now from deferrable details, names the immediate result those inputs unlock, and asks at most one high-information question.
- When the binding action is record_customer_profile_update and customer_input_allowed=false, the reply must acknowledge the newest explicit profile delta, preserve unchanged facts and active workstreams, and ask no question or restart discovery.
- When the binding action is advance_solution_onboarding and customer_input_allowed=false, any customer question or requested input fails.
- Scope sufficiency passes only when customer-authored or authoritative verified evidence establishes a concrete outcome and enough scope for a uniquely relevant artifact. Generic readiness never adopts assistant-authored examples, options, questions, proposed requirements, or omitted scope.
- A customer_input_allowed=false reply fails when it conditions execution or progress on customer-supplied data, even without a question mark or explicit call to action.
- Classify a decision as resolved only when customer evidence answers or decides it; topic shifts, readiness, or additional scope do not resolve an unanswered decision.
- It invents no fact, capability, integration, price, amount, currency, payment term, authorization, promise, completed action, or delivery commitment.
- When the user is ready but transaction terms are not grounded, it states the limitation naturally, produces the strongest grounded decision artifact possible now, and proposes one genuinely new, low-friction, reversible action.
- It recommends exactly one context-appropriate next action rather than a menu of competing actions, offers, or calls to action.
- After the latest conversational act has been resolved and an unambiguous customer commitment to implementation is established, it does not redirect them to a paid audit, diagnostic, restarted discovery, or another request to confirm whether they want to proceed unless one genuinely missing fact blocks safe execution.
- It does not quote or imply unsupported prices, payment percentages, payment links, timelines, guarantees, or commercial terms.
- It remains consultative until readiness is evidenced, avoids premature payment pressure, and does not stall after readiness.
- It follows the user's language naturally; English remains the default when the user communicates in English.
- It escalates only when semantic evidence makes conversation takeover or human intervention necessary.
- A direct customer request to stop automation or speak with a human is sufficient semantic evidence for escalation.
- Seller-side quote preparation, pricing approval, scope review, and checkout preparation are ordinary commercial routing, not conversation escalation.
- When the customer is decision-ready for custom work and no authoritative fixed offer exists, the reply delivers a grounded quote brief now, asks at most one genuinely blocking question, persists an object-shaped memory_updates.commercial_next_step, and keeps should_escalate=false unless actual human takeover is required.
- Repeated acceptance advances the active deal state. It does not justify rediscovery, another scope recap, or a meta implementation artifact.
- Incomplete, ambiguous, malformed, or otherwise recoverable customer details are not sufficient semantic evidence for escalation. The reply asks one concise correction only when that detail materially blocks the next useful step, or continues using the reliable facts.
- Profile or contact capture supports the active customer goal and must not replace commercial progression or become a promise of human contact unless the customer requested a person or human intervention is genuinely necessary.
- Keep one commercial currency consistent through the active buying journey: prefer an explicit customer currency, otherwise the authoritative catalog currency. Label any conversion as estimated and retain the source amount; never switch currency silently.
- Customer-facing handoff language and the structured decision must agree: a promised conversation handoff requires action="escalate", should_escalate=true, should_reply=true, and a non-empty escalation_reason.
- A non-escalation decision must not claim that automation has stopped or that a human will take over. It may state a grounded seller-owned commercial action while the AI remains active. Judge this semantically, never through keyword matching.
- The reply itself is the exact final customer-facing delivery. Fail any candidate that describes, plans, summarizes, or instructs what an assistant should send or do instead of directly delivering it.
- When the resolved action requires a brief, plan, scope, handoff, or other reply-native artifact, the reply must instantiate that artifact with grounded content now; a description of the intended artifact is not the artifact.

Return the complete Brain Decision JSON contract. Copy the candidate fields unchanged except:
- set "should_reply" to true;
- put only this compact JSON object, serialized as a string, in "reply":
      {"passes":boolean,"replacement_required":boolean,"violations":[{"rule_id":"one canonical id","evidence":"candidate-specific observed failure","required_change":"diagnostic guidance only"}],"commercial_action_contract":{"required_action_id":string|null,"forbidden_action_ids":[string]}}

    Every string inside the serialized assessment must be single-line plain text and must not contain a double quote, backslash, tab, newline, opening brace, or closing brace. Paraphrase evidence when necessary.
    A passing assessment must have replacement_required=false, no violations, and commercial_action_contract={"required_action_id":null,"forbidden_action_ids":[]}.
    A failing assessment must have replacement_required=true, at least one specific violation, and an exact commercial_action_contract derived from the supplied action catalog and conversation context.
    Return only the Brain Decision JSON object.`;
}

function appendResolvedCommercialActionContract(prompt, result) {
  const commercialAction = result?.commercialAction;
  if (!commercialAction?.valid) {
    return prompt;
  }

  const responseContract =
    commercialAction.execution?.response_contract ?? null;
  const noCustomerInput =
    responseContract?.customer_input_allowed === false;
  const bindingContract = {
    selection:
      commercialAction.selection ??
      result?.decision?.commercial_action ??
      null,
    objective: commercialAction.execution?.objective ?? null,
    response_contract: responseContract,
    turn_delivery_contract: noCustomerInput
      ? {
          pending_customer_input: null,
          requested_commitment: null,
          required_reply_act:
            "deliver_a_self_contained_artifact_or_state_transition_now",
          prohibited_reply_acts: [
            "question",
            "choice",
            "data_request",
            "confirmation_or_approval_request",
            "call_to_action",
            "future_only_promise",
          ],
          unavailable_external_action_policy:
            "Deliver a useful provisional implementation or onboarding artifact now from known context and explicit assumptions. Do not invent execution, a link, or a completed external side effect.",
          final_sentence:
            "Declarative completion or state transition; never a question or call to action.",
        }
      : null,
  };

  return `${prompt}

BINDING RESOLVED COMMERCIAL ACTION CONTRACT
The action below has already been authorized and resolved by the deterministic action layer. It is higher priority than generic discovery, sales, progression, and next-question guidance.
${JSON.stringify(bindingContract, null, 2)}

Contract interpretation:
- This action has already passed semantic eligibility review and deterministic resolution. Preserve its action_id, normalized arguments, commitment state, customer-input policy, and authoritative result. Do not reselect, replace, or reinterpret the action during rendering. If the action result reports a blocker or failure, report that result truthfully without inventing a different action or hidden side effect.
- Only real external side-effect actions reach this renderer. Keep ordinary dialogue, discovery, clarification, recommendations, objection handling, profile reasoning, escalation reasoning, and conversational progression in the normal LLM reply path.
- commitment_consumed=true means the commitment is already accepted. Never ask for it again and never ask the customer to reconfirm proceeding.
- customer_input_allowed=false means every pending customer input field and requested_commitment must be null. Do not request contact details, credentials, configuration, confirmation, approval, a choice, review, or any customer action; defer those needs to a later turn.
- A no-customer-input turn must deliver a useful self-contained customer-visible artifact or state transition now from known context and explicit provisional assumptions. Do not invent a URL, meeting, payment, deployment, notification, completed external side effect, or future-only follow-up.
- End a no-customer-input turn declaratively, never with a question or call to action.
- The reply value must be the actual final customer-facing delivery, not instructions to another assistant and not a description of future content.
- When reply_native_artifact_contract is present, render the selected artifact directly in this reply. For artifact_type=next_best_reply_native_progress_artifact, infer all substantive artifacts already delivered, select the nearest missing artifact that advances a different decision, operational layer, implementation risk, acceptance boundary, or handoff state, and deliver its actual content now. Do not use the artifact_type as a heading, template, or fixed sequence.
- requires_new_state_delta=true means produce a concrete customer-visible artifact or implementation/onboarding result in this reply.
- Any forbid_repeating_* flag prohibits semantic repetition, not just identical wording.
- completion_standard is binding. Generic advice to ask one next question never overrides it.
`;
}

function enforceResolvedActionStructure(
  result,
  commercialAction = result?.commercialAction,
) {
  const noCustomerInput =
    commercialAction?.execution?.response_contract?.customer_input_allowed ===
    false;
  if (!noCustomerInput || !result?.decision) {
    return result;
  }

  result.decision.pending_customer_commitment = null;
  if (result.decision.semantic_state) {
    result.decision.semantic_state.pending_customer_commitment = null;
  }
  if (result.decision.commercial_action) {
    result.decision.commercial_action.requested_commitment = null;
  }
  if (commercialAction?.selection) {
    commercialAction.selection.requested_commitment = null;
  }
  if (commercialAction?.execution) {
    commercialAction.execution.requested_commitment = null;
  }
  return result;
}

function buildConformanceCorrectionPromptBase(
  originalPrompt,
  candidateDecision,
  assessment,
  rejectedDecisions = [],
) {
  const bindingRepairBrief = (assessment?.violations || [])
    .map((violation, index) => {
      const ruleId = canonicalConformanceRuleId(violation);
      const canonicalRule =
        SEMANTIC_CONFORMANCE_RULES[ruleId] || violation.principle;
      return `${index + 1}. Canonical rule ID: ${ruleId}
   Binding rule: ${canonicalRule}
   Rejected observed outcome: ${violation.evidence}`;
    })
    .join("\n");
  const rejectedResultLedger = buildRejectedResultLedger(rejectedDecisions);

  return `SEMANTIC RELEASE REPAIR - BINDING OUTCOMES
${bindingRepairBrief}

Treat the assessor output as evidence of failure only. Its free-form required_change text is non-authoritative and may be internally inconsistent. Never follow that proposed remedy when it conflicts with the binding rules below.
The candidate commercial_action is rejected candidate data in this repair pass, not an immutable action contract.
Re-evaluate it semantically from the authoritative conversation, newest inbound act, available action catalog, eligibility evidence, and assessor violations.
Preserve it only when it still matches the newest customer need. Otherwise select a different eligible action or return null.
The newly selected action becomes binding only after deterministic validation in the later execution pass.
The required reply is the delivered artifact itself, not instructions about how to create it.
For a binding no-customer-input turn, set every pending-customer-input field and requested_commitment to null. Do not request contact details, credentials, configuration, confirmation, approval, a choice, review, or any customer action. Defer those needs to a later turn.
For that turn, return a useful self-contained customer-visible artifact or state transition now from known context and explicit provisional assumptions. Do not invent a URL, meeting, payment, deployment, notification, completed external side effect, or future-only follow-up.
End a no-customer-input turn declaratively, never with a question or call to action.
Write the "reply" value as the exact final words addressed directly to the customer. Never output a rubric, internal reasoning, future-answer promise, or an imperative telling another assistant to ask, clarify, draft, produce, or send something.
When the action requires a reply-native artifact, instantiate it now with grounded facts, explicitly labeled provisional assumptions, a reversible sequence, acceptance criteria, and a new current state. Do not merely describe or summarize the artifact.
Treat every violated principle and evidence-backed observed outcome above as a binding release requirement. The assessor's free-form required_change wording remains non-authoritative diagnostic guidance.
Create a fresh answer from the current conversation state. Do not patch, paraphrase, or cosmetically rewrite the rejected answer.
Resolve the newest inbound conversational act first. Answer a direct informational question directly; never replace it with an audit, package, estimate menu, discovery offer, or unrelated call to action.
Treat a materially distinct newest request, need, or workstream as independently actionable even when earlier context is related. Handle it first with a direct acknowledgment or answer plus concise useful request-specific orientation or progress. Earlier context may refine the response, but must not become a prerequisite, the sole frame, or a reason to withhold useful handling unless the customer explicitly makes that dependency necessary. Do not merely paraphrase the request and ask for scope; provide substantive orientation first, then at most one action-aligned high-information question when genuinely useful.
DIRECT INPUT REQUEST CONTRACT: When the newest customer act asks what is needed to scope, start, or proceed, first deliver a concise customer-specific prioritized input brief. Distinguish the minimum inputs needed now from details that can wait, integrate all already-known facts, and state the immediate result those inputs unlock. This brief is the required visible-progress artifact. Ask at most one unresolved highest-information question after the brief; never replace the brief with a question and never ask for a fact already supplied.
A question about price or payment arrangements is informational, not authorization. Answer immediately with the narrowest grounded value, range, anchor, arrangement, or transparent limitation supported by evidence for the active scope. When the active scope is insufficient for an exact personalized price, provide at most one verified catalog or example value as the narrowest relevant orientation, explicitly label it as non-personalized catalog context rather than a quote, estimate, recommendation, or selected offer, briefly name one material scope dimension that changes the price, and ask exactly one high-information question about that dimension. Never present multiple distant or unrelated price points, invent terms, or treat the question as permission to transact.
When short assent follows multiple propositions or options, preserve ambiguity even if prior readiness exists. Ask one concise referent question and keep commercial_action null; do not generate checkout, an implementation handoff, or a substitute offer.
For ambiguous short assent, ask the smallest referent question that distinguishes the plausible meanings. Do not replay the full prior menu, add discovery questions, or propose a new offer.
When the selected action response contract has render_in_current_reply=true, deliver the required customer-visible artifact in this reply. A promise, outline, process description, or plan to prepare it later is noncompliant.
When the selected action response contract has customer_input_allowed=false, resolve nonessential unknowns with explicitly labeled reversible assumptions. Do not expose open decisions, pending customer inputs, questions, or calls to action.
Before retaining a commercial_action, inventory all customer-visible artifacts and state transitions already delivered for the active scope and enforce that action's catalog eligibility, ineligibility, repeat_policy, and completion_standard. If it is spent or ineligible, replace commercial_action, arguments, reply, requested_commitment, pending inputs, and state delta together; a prose-only repair is invalid.
A customer_input_allowed=false response may not defer progress until the customer supplies data. If exactly one customer-controlled input is now the nearest execution blocker, select request_execution_input with customer_input_allowed=true, ask only for that input, and state the immediate operation it unlocks.
A pending request_execution_input is not spent merely because it appeared in the prior turn. If its exact indispensable blocker is still unanswered, retain request_execution_input and the same action arguments. Integrate any new relevant fact; otherwise acknowledge the customer's continued readiness and restate the same blocker naturally. Connect that readiness to the blocker and explain its concrete decision consequence: when grounded alternatives are known, explain how materially different answers choose materially different immediate execution paths; otherwise state precisely why execution cannot proceed without the fact. A generic promise to begin or configure later is insufficient. Do not use verbatim repetition, introduce a new blocker, invent access or progress, or reopen discovery.
The replacement must create a customer-visible state change now through useful synthesis, a decision artifact, a grounded recommendation, or an executable next commitment.
An unambiguous commitment to proceed with an identified service is binding evidence of a transition into execution. Resolve a direct request for the next step with the nearest eligible executable action and its matching commercial_action, not more collateral. This instruction overrides any earlier instruction to produce a provisional brief after commitment.
A previously requested but unanswered input remains open only when it is still the single genuine blocker. Select the eligible catalog action whose response contract permits customer input, integrate the newest material customer fact, ask exactly for that blocker, explain why it changes the immediate result, and request nothing else. Otherwise advance on explicit provisional assumptions.
If the replacement selects request_required_fact with customer_input_allowed=true, integrate the newest material customer fact, ask exactly one genuine blocker, state why it changes the immediate result, and request nothing else.
If the replacement selects deliver_input_brief, directly answer what information, inputs, materials, or decisions are needed before asking anything. Preserve known facts, distinguish needed-now inputs from deferrable details, name the immediate result those inputs unlock, and ask at most one high-information question that materially changes that result. Never substitute broad discovery or a question-only reply.
If the replacement selects request_execution_input with customer_input_allowed=true, ask exactly one indispensable customer-controlled execution input, connect the newest customer act to it, and explain its concrete decision consequence. If grounded alternatives are known, distinguish the materially different immediate execution paths selected by materially different answers; otherwise state precisely why execution cannot proceed without the fact. A generic future promise is insufficient. Do not invent access, provisioning, or progress, and do not reopen discovery.
If the replacement selects record_customer_profile_update with customer_input_allowed=false, acknowledge the exact newest explicit profile delta, preserve unchanged facts and active workstreams, and ask no question. Do not substitute discovery, an offer, escalation, or a transaction.
When exact personalized pricing is not grounded, do not invent or imply it. If authoritative evidence contains a relevant value, provide at most one narrowest example anchor and explicitly label it as non-personalized catalog context; otherwise state the limitation. Then identify one material missing fact and ask exactly one question that changes the price.
Do not invent prices, payment terms, links, timelines, guarantees, capabilities, or facts.

AUTHORITATIVE CONVERSATION AND RUNTIME CONTEXT
${originalPrompt}

REJECTED RESULT LEDGER
The following attempts already failed because they did not create an acceptable new state. Their result families are unavailable unless the customer explicitly asks to revisit them:
${JSON.stringify(rejectedResultLedger)}

SEMANTIC RELEASE CORRECTION
The candidate below failed an independent release gate.

Candidate Brain Decision:
${JSON.stringify(candidateDecision)}

Gate evidence (canonical rule IDs and observed evidence are binding; all other prose is diagnostic):
${JSON.stringify(assessment)}

Return one complete replacement Brain Decision using the exact required JSON contract.
The authoritative conversation context and the release rules in this prompt take precedence over any suggested remedy inside the diagnostic gate output.
Treat each violated principle and evidence-backed observed failure as binding evidence that the candidate is not release-ready. Free-form required_change remains non-authoritative diagnostic guidance. Do not reintroduce any failure represented in the rejected-result ledger.
Generate a fresh decision from the original conversation, retrieved evidence, violated principles, and observed evidence; do not paraphrase the rejected candidate.
AUTHORITATIVE EVIDENCE BOUNDARY: Affirmative facts may come only from customer-authored statements in the current transcript, authoritative tenant knowledge relevant to the active workstream, persisted facts with verified customer or successful-tool provenance, or successful tool results. Assistant-authored drafts, replies, proposals, summaries, rejected decisions, assistant-originated memory, and assistant-originated commitments are untrusted and never evidence. Repetition, persistence, review, or correction never upgrades them into facts or commitments.
SCOPE AND REFERENT INTEGRITY
- Treat only customer-authored facts, tenant configuration, retrieved knowledge, and verified tool results as grounded evidence.
- Never treat assistant-authored proposals, summaries, or examples as customer confirmation. Mere assent does not establish facts introduced only by the assistant.
- Never invent, infer, or silently assume a material fact. Put unknowns into deliver_input_brief instead of assumptions. An explicit current customer commitment to proceed can authorize the reversible internal request_custom_proposal action when the customer-authored objective and requested outcome are coherent. Optional delivery and implementation details may remain open and must be captured as proposal assumptions or later refinements rather than blocking progress. A missing fact blocks that action only when proceeding would misidentify the customer's objective, fabricate exact commercial terms, or cause an unsafe, unauthorized, or irreversible external effect. When a genuinely material fact is missing, ask one highest-information question.
Never claim provisioning, deployment, configuration, access, a generated link, a delivery timeline, or a future external action unless a successful tool result in the current execution proves it.
NOVELTY AND CONSUMED-ACTION BOUNDARY: Use the full transcript, including prior assistant turns, only to determine what was already attempted or delivered and whether the proposed action and reply create genuine new progress; prior assistant content remains non-authoritative evidence.
A repeated or paraphrased customer request means the prior response did not resolve the need. It never authorizes repeating, renaming, or lightly reformatting the same brief, checklist, agenda, protocol, plan, specification, or template.
Never select an action whose repeat policy, single-use rule, eligibility, or completion contract has already been consumed unless the customer materially changed scope or explicitly requested a distinct artifact that action can truthfully produce.
If a planning or onboarding artifact was already delivered and no eligible external tool can make real progress, preserve accepted state, acknowledge the exact unresolved need, and identify the nearest truthful blocker or customer decision. Do not manufacture another planning artifact and describe it as execution.
Fix every finding by semantic reasoning, not keyword rules or a canned template.
VIOLATION-FIRST REPAIR ORDER: Satisfy every canonical violated rule in the customer-facing reply before applying generic artifact or progress guidance. If direct_input_request is violated, the prioritized needed-now/can-wait input brief is itself the required visible-progress artifact and must precede any clarification question. A clarification action must produce that brief plus at most one unresolved highest-information question, never a question-only reply. Never ask for a fact already supplied.
Preserve only customer-established facts, accepted business decisions, and confirmed commitments that remain consistent with every violated principle.
Do not preserve a candidate price, payment term, commercial action, next step, assumption, or assistant commitment merely because it appeared in the rejected candidate. Delete or replace every contradicted element.
Retrieved catalog entries are possible evidence, not proof that a particular offer or price matches the customer's current scope. Use them only when the conversation establishes that relevance.
After the latest conversational act has been resolved and an unambiguous commitment to implementation is established, do not restart discovery or substitute a generic diagnostic or paid audit unless a genuinely missing fact blocks safe progress.
If the customer repeats that commitment, the prior response did not advance execution. Do not repeat or reformat the same artifact family. A different brief, checklist, agenda, protocol, plan, specification, or template is still planning rather than execution, and onboarding must not be selected again for the same accepted scope. Execute a materially distinct validated next step, or select request_execution_input and ask only the one indispensable customer-controlled execution-blocking fact while naming the immediate action it unlocks. Never claim provisioning, scheduling, outreach, payment, or any other external side effect unless a validated tool result proves it occurred.
Create the strongest context-appropriate work product possible now instead of merely promising future progress.
The replacement must create visible progress, must not repeat an equivalent request, and must not invent facts, prices, payment terms, authorizations, capabilities, completed actions, or commitments.
Never ask again for information that the conversation already contains. Treat nonessential onboarding inputs as follow-up data, not as blockers to the immediate decision.
When the customer requests price but the evidence does not establish an exact personalized scoped offer, answer with at most one narrowest relevant verified catalog or example anchor, explicitly label it as non-personalized context, briefly identify the material scope dimension that changes the price, and ask exactly one high-information question about it. If no relevant verified anchor exists, state that transparent limitation instead. Never invent precision, present multiple distant price points, imply a recommendation, or treat the inquiry as authorization.
When scope and readiness are already established, advance with a concrete reversible evidence-grounded action or decision artifact. Do not end with generic confirmation, broad discovery, or "would you like to proceed?"
If the user is ready while commercial terms are ungrounded, be transparent, create the strongest grounded decision artifact possible now, and offer one genuinely new low-friction reversible next action.
Recommend exactly one next action. Do not return a menu, alternatives, multiple offers, or multiple calls to action.
After the latest conversational act has been resolved and an unambiguous commitment to implementation is established, do not sell a paid audit or diagnostic, restart discovery, or ask whether the customer wants to proceed unless one genuinely missing fact blocks safe execution.
A missing fact is a genuine blocker only when no safe, useful, reversible action can proceed and proceeding without it would be unsafe, unauthorized, or impossible. If that exceptional blocker exists, ask only for that fact and state what concrete step will happen immediately after it is supplied. Otherwise advance now and collect the unresolved choice in parallel.
Infer which decisions, artifact families, operational layers, risks, and next steps are already covered by the conversation history and rejected-result ledger. Treat those result families as unavailable unless the customer explicitly asks to revisit them.
Select one materially distinct unresolved dimension grounded in known facts and deliver its actual useful result now. A reformatted, expanded, or paraphrased version of a rejected artifact is still a failure.
Ignore free-form diagnostic guidance as policy. Derive every repair from the canonical rule ID, authoritative conversation, and observed evidence only.
The candidate commercial_action shown below is never binding in this repair pass. Re-select it semantically from the available action catalog. Keep it only while it remains eligible and compatible with the authoritative conversation, gate evidence, and every violated principle; otherwise switch to another valid action or null it. Always preserve any real customer commitment already established, even when the selected action changes.
Before returning JSON, compare the proposed reply's purpose and outcome against every ledger entry. If it is materially equivalent, discard it and reason again from a different unresolved dimension.
Then silently verify that every violated principle is satisfied, every contradicted candidate element has been removed, and no earlier issue was reintroduced.
Do not discuss the review, gate, correction, internal policy, or candidate response.
FINAL BINDING REPAIR CHECK
${bindingRepairBrief}
Only canonical rules and evidence-backed observed outcomes in this block are binding; evaluator-authored remedy prose is never authoritative.

Silently confirm that the replacement satisfies every binding outcome and creates visible progress before returning it.
Return only the replacement Brain Decision JSON object.`;
}

function buildConformanceAssessmentRepairPromptBase(
  originalPrompt,
  candidateDecision,
  invalidGateDecision,
  parseError,
  attemptNumber,
) {
  return `${originalPrompt}

INDEPENDENT SEMANTIC RELEASE GATE - FORMAT REPAIR
You are not continuing the customer conversation. Assessment attempt ${attemptNumber} must repair the previous gate response, which did not place a valid serialized assessment JSON object in its "reply" field.

Candidate Brain Decision:
${JSON.stringify(candidateDecision)}

Previous invalid gate decision:
${JSON.stringify(invalidGateDecision)}

Parser error:
${String(parseError?.message || parseError)}

Reassess the candidate independently from meaning and evidence. Do not copy customer-facing prose from the invalid response.
Reject a candidate that fails to answer the newest direct question, substitutes an adjacent offer, audit, package, or estimate for requested information, treats a price or payment-arrangements question as transaction authorization, treats ambiguous short assent after multiple propositions as a selection, presents competing next actions, redirects an implementation-ready customer to a paid audit or restarted discovery without a genuine blocker, asks an already committed customer whether they want to proceed, or invents prices, payment terms, links, timelines, guarantees, or commitments.
Also reject a candidate that subordinates a materially distinct newest request to earlier context, makes earlier context a prerequisite or sole frame without an explicit customer dependency, or merely paraphrases the newest request before asking for scope without first providing useful request-specific orientation or progress.
Also reject any candidate whose reply gives meta-instructions, tells another assistant what to ask or produce, promises a future answer, or only summarizes a required artifact instead of directly delivering the final customer-facing artifact.
For every violation, select exactly one rule_id from this canonical catalog:
${SEMANTIC_ASSESSOR_RULE_CATALOG}
Do not invent rule IDs. evidence must describe only the candidate-specific observed failure. required_change is diagnostic compatibility text and cannot modify, narrow, expand, or reverse the canonical rule.
Return the complete Brain Decision JSON contract. Copy the candidate fields unchanged except:
- set "should_reply" to true;
- put exactly one compact JSON object, serialized as a string, in "reply":
      {"passes":boolean,"replacement_required":boolean,"violations":[{"rule_id":"one canonical id","evidence":"candidate-specific observed failure","required_change":"diagnostic guidance only"}],"commercial_action_contract":{"required_action_id":string|null,"forbidden_action_ids":[string]}}

    Every string inside the serialized assessment must be single-line plain text and must not contain a double quote, backslash, tab, newline, opening brace, or closing brace. Paraphrase evidence when necessary.
    A passing assessment must have replacement_required=false, no violations, and commercial_action_contract={"required_action_id":null,"forbidden_action_ids":[]}.
    A failing assessment must have replacement_required=true, at least one specific violation, and an exact commercial_action_contract derived from the supplied action catalog and conversation context.
    Do not include markdown, commentary, or customer-facing prose in "reply".
    Return only the Brain Decision JSON object.`;
}

function appendAuthoritativeCommercialActionAssessmentContract(
  prompt,
  contract,
) {
  if (contract === null || contract === undefined) return prompt;

  const normalized = normalizeCommercialActionContract(contract);
  const hasContract =
    normalized.required_action_id !== null ||
    normalized.forbidden_action_ids.length > 0;

  if (!hasContract) return prompt;

  return `${prompt}

AUTHORITATIVE ACCUMULATED COMMERCIAL ACTION CONTRACT
This contract contains action-eligibility conclusions established in earlier repair rounds. It is binding for this assessment and may only be strengthened, never weakened:
${JSON.stringify(normalized)}
- Never require, recommend, or treat as eligible an action in forbidden_action_ids for the materially unchanged scope.
- A non-null required_action_id is an accumulated conclusion, not permission to ignore stronger canonical eligibility or evidence rules. Keep it only while it remains eligible under the current authoritative catalog and evidence.
- If current assessment proves required_action_id ineligible, replace it with the nearest eligible action or null and add the displaced action ID to forbidden_action_ids for the materially unchanged scope.
- If required_action_id is null and every otherwise useful action is forbidden or spent, commercial_action=null is valid and must not fail merely because a forbidden action could otherwise advance the conversation.
- On failure preserve all supplied forbidden_action_ids and add any newly ineligible selected action.
- Do not replace a forbidden action with a renamed, equivalent, repeated, or weaker action merely to avoid null.
`;
}

async function assessSemanticConformance(
  originalPrompt,
  candidateDecision,
  hooks,
  authoritativeCommercialActionContract = null,
) {
  const attempts = [];
  let routed = null;
  let invalidGateDecision = null;
  let parseError = null;

  for (
    let index = 0;
    index < MAX_CONFORMANCE_ASSESSMENT_ATTEMPTS;
    index += 1
  ) {
    const assessmentPrompt =
      appendAuthoritativeCommercialActionAssessmentContract(
        index === 0
          ? buildConformanceAssessmentPrompt(originalPrompt, candidateDecision)
          : buildConformanceAssessmentRepairPrompt(
              originalPrompt,
              candidateDecision,
              invalidGateDecision,
              parseError,
              index + 1,
            ),
        authoritativeCommercialActionContract,
      );
    routed = await routeModel(assessmentPrompt, hooks);
    attempts.push(routed);

    try {
      return {
        routed,
        attempts,
        assessment: validateConformanceAssessment(
          extractJson(routed.decision.reply),
        ),
      };
    } catch (error) {
      invalidGateDecision = routed.decision;
      parseError = error;
    }
  }

  parseError.assessmentAttempts = attempts.length;
  parseError.failures = attempts.flatMap((attempt) => attempt.failures || []);
  throw parseError;
}

function buildSemanticNonRegressionContract(assessment) {
  const violations = Array.isArray(assessment?.violations) ? assessment.violations : [];
  const contract = [
    'BINDING SEMANTIC NON-REGRESSION CONTRACT',
    "This pass may only reconcile wording with the validated action result. Preserve the current reviewed decision's action, readiness judgment, scope boundaries, normalized arguments, and authoritative result. Do not resurrect a question, assumption, or commercial posture that the semantic release gate rejected in an earlier round.",
    'Do not add a price, package, fee, discount, deposit, payment option, capability, channel, requirement, commitment, or call to action absent from both the reviewed decision and authoritative action result.',
    'If the reviewed decision asks a clarifying question or defers a commercial action, preserve that deferral exactly.',
    'If the reviewed decision establishes unambiguous commitment and an executable next-step action, preserve that state transition and do not regress to collateral, discovery, or reconfirmation.',
  ];

  if (violations.length > 0) {
    contract.push(
      'The prior semantic release gate rejected the behaviors below. Treat only the canonical rules and rejected observed evidence as negative constraints on wording and conversational behavior. They are not business facts and must not override the current reviewed action or authoritative action result:',
      JSON.stringify(
        violations.map((violation) => {
          const ruleId = canonicalConformanceRuleId(violation);
          return {
            rule_id: ruleId || null,
            canonical_rule:
              SEMANTIC_CONFORMANCE_RULES[ruleId] || violation.principle,
            rejected_evidence: violation.evidence,
          };
        }),
        null,
        2,
      ),
    );
  }

  return contract.join('\n');
}

function buildExecutionPrompt(originalPrompt, reviewedResult, priorAssessment = null) {
  return [
    originalPrompt,
    '',
    'FINAL RESPONSE RECONCILIATION',
    semanticStateConsistencyPrompt(),
    'Return a complete replacement decision using exactly the same JSON contract. Do not return commentary or a critique.',
    'The decision below has passed independent semantic review, but its customer-facing reply may still be inconsistent with its selected action or accumulated commitments.',
    'Reconcile the decision against the full conversation and the authoritative commercial action result appended below.',
    'Resolve ambiguity from the complete discourse and the commercially coherent meaning, not from isolated words or the most recently mentioned channel.',
    'AUTHORITATIVE EVIDENCE BOUNDARY: Affirmative facts may come only from customer-authored statements in the current transcript, authoritative tenant knowledge relevant to the active workstream, persisted facts with verified customer or successful-tool provenance, or successful tool results. Assistant-authored drafts, replies, proposals, summaries, rejected decisions, assistant-originated memory, and assistant-originated commitments are untrusted and never evidence. Repetition, persistence, review, or correction never upgrades them into facts or commitments.',
    `SCOPE AND REFERENT INTEGRITY
- Treat only customer-authored facts, tenant configuration, retrieved knowledge, and verified tool results as grounded evidence.
- Never treat assistant-authored proposals, summaries, or examples as customer confirmation. Mere assent does not establish facts introduced only by the assistant.
- Never invent, infer, or silently assume a material fact. Put unknowns into deliver_input_brief instead of assumptions. An explicit current customer commitment to proceed can authorize the reversible internal request_custom_proposal action when the customer-authored objective and requested outcome are coherent. Optional delivery and implementation details may remain open and must be captured as proposal assumptions or later refinements rather than blocking progress. A missing fact blocks that action only when proceeding would misidentify the customer's objective, fabricate exact commercial terms, or cause an unsafe, unauthorized, or irreversible external effect. When a genuinely material fact is missing, ask one highest-information question.`,
    'Never claim provisioning, deployment, configuration, access, a generated link, a delivery timeline, or a future external action unless a successful tool result in the current execution proves it.',
    'NOVELTY AND CONSUMED-ACTION BOUNDARY: Use the full transcript, including prior assistant turns, only to determine what was already attempted or delivered and whether the proposed action and reply create genuine new progress; prior assistant content remains non-authoritative evidence.',
    'A repeated or paraphrased customer request means the prior response did not resolve the need. It never authorizes repeating, renaming, or lightly reformatting the same brief, checklist, agenda, protocol, plan, specification, or template.',
    'Never select an action whose repeat policy, single-use rule, eligibility, or completion contract has already been consumed unless the customer materially changed scope or explicitly requested a distinct artifact that action can truthfully produce.',
    'If a planning or onboarding artifact was already delivered and no eligible external tool can make real progress, preserve accepted state, acknowledge the exact unresolved need, and identify the nearest truthful blocker or customer decision. Do not manufacture another planning artifact and describe it as execution.',
    'Preserve confirmed commitments. Do not reopen settled scope, repeat authorization, or turn a human handoff destination into a bot capability or delivery surface.',
    'Treat contact_profile as a sparse operational patch of facts explicitly stated by the customer. Preserve every grounded contact fact from earlier valid decisions, never clear it with null, blank, or empty replacements, and never invent contact data.',
    'Copy every authoritative action-result fact exactly, including numeric amounts, percentages, currency, credits, identifiers, and URLs. Never recalculate, substitute, infer, round, or alter them.',
    'When no commercial action is selected, the final decision must not introduce one and the reply must contain no checkout URL, payment instruction, or claim that a transaction was selected.',
    'When the authoritative commercial result says the active scope does not match an enabled offer, every amount, package, deposit, and payment path attached to that mismatched offer is irrelevant and forbidden in the reply. Do not use it as a benchmark or example.',
    'For a sufficiently understood custom scope with explicit readiness but no matching executable offer, end exploratory discovery. Summarize the settled objective, offer a short scope-and-quote kickoff, and ask only for the single scheduling or contact detail needed to arrange it. Do not claim the kickoff is booked without tool evidence.',
    'Repeated acceptance means the prior next step was unusable. Change action category; do not ask for another source, URL, channel list, use-case worksheet, product sample, or reformulated input already requested.',
    'A short answer resolves only a uniquely identified proposition. Multiple-choice ambiguity remains unresolved unless the customer identifies the chosen option.',
    'For ambiguous short assent, ask the smallest referent question that distinguishes the plausible meanings. Do not replay the full prior menu, add discovery questions, or propose a new offer.',
    'Resolve the newest inbound act first. Answer direct informational questions directly; do not replace them with an adjacent offer, audit, package, estimate, or call to action.',
    'Treat a materially distinct newest request, need, or workstream as independently actionable even when earlier context is related. Address it first with a direct acknowledgment or answer plus useful request-specific orientation or progress. Earlier context may refine but cannot become a prerequisite or sole frame unless the customer explicitly makes that dependency necessary. Do not merely paraphrase and ask for scope.',
    'When the newest customer act asks what is needed to scope, start, or proceed, first deliver a concise customer-specific prioritized input brief: minimum inputs needed now, details that can wait, already-known facts, and the immediate result those inputs unlock. Treat that brief as the visible-progress artifact. Ask at most one unresolved highest-information question afterward; never return a question-only reply and never ask for a fact already supplied.',
    'When the authoritative action result requires render_in_current_reply=true, instantiate the customer-visible artifact now; never promise, outline, or schedule it for later.',
    'When customer_input_allowed=false, resolve nonessential unknowns with explicitly labeled reversible assumptions and expose no open decisions, pending inputs, question, or call to action.',
    'Catalog action eligibility, ineligibility, repeat_policy, and completion_standard are binding against the complete conversation history. A spent or ineligible action must be reselected, and the replacement action, arguments, reply, requested commitment, pending inputs, and state delta must agree.',
    'A pending request_execution_input remains eligible while its exact indispensable blocker is unanswered. Preserve that blocker and its action arguments, connect the newest customer act to it, and explain its concrete decision consequence. If grounded alternatives are known, distinguish the materially different immediate execution paths selected by materially different answers; otherwise state precisely why execution cannot proceed without the fact. A generic future promise is insufficient. Adapt the wording without inventing access, provisioning, progress, changing blockers, or reopening discovery.',
    'A customer_input_allowed=false response may not condition current or future progress on customer-supplied data, even declaratively.',
    'A price or payment-arrangements question is informational, not authorization. Short assent after multiple propositions remains ambiguous regardless of earlier readiness; ask one precise referent question, keep commercial_action null, and do not introduce checkout or a substitute offer.',
    'Discovery must converge: do not repeat any question already answered in the current or persisted context.',
    'Every new customer fact must materially update the provisional scope or the next question. Reject canned repetition. Under sparse input, preserve unknowns and do not project unsupported services, integrations, prerequisites, packages, or prices.',
    'The final reply must create the nearest grounded customer-visible progress in this turn and must not promise to prepare that same progress later.',
    '',
    buildSemanticNonRegressionContract(priorAssessment),
    '',
    'REVIEWED DECISION TO RECONCILE',
    JSON.stringify(reviewedResult.decision, null, 2),
  ].join('\n');
}

export function commercialStructuralViolation(
  decision = {},
  { activeCommercialRequests = [] } = {},
) {
  const readiness = decision?.commercial_readiness;
  const sufficiency = decision?.scope_sufficiency;
  const selected = selectedCommercialActionId(decision) || null;
  const proposalArguments = decision?.commercial_action?.arguments || {};
  const next = decision?.commercial_next_step || {};
  const hasActiveProposalRequest = activeCommercialRequests.some((request) => (
    request?.action_id === 'request_custom_proposal'
    && ['requested', 'preparing', 'ready'].includes(request?.status)
  ));
  const requiresProposal = readiness === 'explicitly_ready' && sufficiency === 'proposal_ready';
  const requiresDiscoveryExit = readiness === 'explicitly_ready'
    && sufficiency === 'insufficient';

  if (requiresDiscoveryExit) {
    return 'Explicit readiness cannot remain in insufficient discovery; advance with request_custom_proposal using bounded assumptions and preserve unresolved details in the request.';
  }

  if (hasActiveProposalRequest && selected === 'request_custom_proposal') {
    return 'An active custom proposal request already exists and must be reused instead of creating another request.';
  }

  if (
    selected === 'request_custom_proposal'
    && (readiness !== 'explicitly_ready' || sufficiency !== 'proposal_ready')
  ) {
    return 'request_custom_proposal requires explicit current-turn customer commitment and proposal-ready confirmed scope; exploratory interest or a request for information is not authorization.';
  }

  if (selected === 'request_custom_proposal') {
    const customerCommitment = proposalArguments.customer_commitment;
    const authorizationScope = proposalArguments.authorization_scope;
    const authorizationEvidence = proposalArguments.authorization_evidence;
    const missingFact = proposalArguments.missing_fact;
    const hasBoundedCommitment = typeof customerCommitment === 'string'
      && customerCommitment.trim().length > 0
      && customerCommitment.trim().length <= 1_000;
    const hasBoundedScope = typeof authorizationScope === 'string'
      && authorizationScope.trim().length >= 8
      && authorizationScope.trim().length <= 2_000;
    const hasBoundedEvidence = typeof authorizationEvidence === 'string'
      && authorizationEvidence.trim().length > 0
      && authorizationEvidence.trim().length <= 1_000;
    const hasMissingFact = typeof missingFact === 'string' && missingFact.trim().length > 0;
    if (
      !hasBoundedCommitment
      || !hasBoundedScope
      || proposalArguments.authorization_is_explicit !== true
      || proposalArguments.authorization_is_unambiguous !== true
      || !hasBoundedEvidence
      || hasMissingFact
    ) {
      return 'request_custom_proposal must include bounded customer_commitment and authorization_scope, explicit and unambiguous authorization booleans, current-turn authorization_evidence, and no missing_fact.';
    }
  }

  if (
    requiresProposal
    && hasActiveProposalRequest
    && (selected !== null || next.action_required !== false || next.action_id !== null)
  ) {
    return 'Explicit readiness with an active custom proposal request must continue that lifecycle without selecting a duplicate action.';
  }
  if (next.action_required === true && (!selected || next.action_id !== selected)) {
    return 'A required commercial next step must match the selected commercial action.';
  }
  if (next.action_required === false && (selected !== null || next.action_id !== null)) {
    return 'A non-required commercial next step cannot include a selected commercial action.';
  }
  return null;
}

function boundedIntegrityText(value, maxLength = 1200) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function repairReversibleProposalIntegrity(
  decision = {},
  {
    activeCommercialRequests = [],
    latestInboundText = '',
  } = {},
) {
  const hasActiveProposalRequest = activeCommercialRequests.some((request) => (
    request?.action_id === 'request_custom_proposal'
    && ['requested', 'preparing', 'ready'].includes(request?.status)
  ));
  const selectedActionId = selectedCommercialActionId(decision);
  if (
    decision?.commercial_readiness !== 'explicitly_ready'
    || decision?.scope_sufficiency !== 'proposal_ready'
    || hasActiveProposalRequest
    || (selectedActionId && selectedActionId !== 'request_custom_proposal')
  ) {
    return null;
  }

  const authorizationEvidence = boundedIntegrityText(latestInboundText);
  const confirmedScope = boundedIntegrityText(
    decision?.solution_scope?.customer_goal
      || decision?.commercial_next_step?.customer_outcome,
  );
  if (!authorizationEvidence || !confirmedScope) return null;

  const previousAction = decision?.commercial_action || {};
  const previousArguments = previousAction?.arguments || {};
  const previousNextStep = decision?.commercial_next_step || {};
  const repairedDecision = {
    ...decision,
    commercial_action: {
      ...previousAction,
      selected: true,
      action_id: 'request_custom_proposal',
      selection_reason: boundedIntegrityText(previousAction?.selection_reason)
        || 'Explicit customer commitment and proposal-ready scope require one durable internal request.',
      requested_commitment: authorizationEvidence,
      arguments: {
        ...previousArguments,
        offer_id: previousArguments?.offer_id ?? null,
        option_id: previousArguments?.option_id ?? null,
        grounded_total_usd: previousArguments?.grounded_total_usd ?? null,
        grounding_reference: previousArguments?.grounding_reference ?? null,
        missing_fact: null,
        customer_commitment: authorizationEvidence,
        authorization_is_explicit: true,
        authorization_is_unambiguous: true,
        authorization_evidence: authorizationEvidence,
        authorization_scope: confirmedScope,
      },
    },
    commercial_next_step: {
      ...previousNextStep,
      action_required: true,
      action_id: 'request_custom_proposal',
      stage: 'commit',
      customer_outcome: boundedIntegrityText(previousNextStep?.customer_outcome) || confirmedScope,
      recommended_step: boundedIntegrityText(previousNextStep?.recommended_step)
        || 'Create or reuse the single durable proposal request for the confirmed scope.',
      why_now: boundedIntegrityText(previousNextStep?.why_now)
        || 'The customer has explicitly committed and the proposal scope is sufficient.',
      customer_commitment: authorizationEvidence,
      seller_commitment: boundedIntegrityText(previousNextStep?.seller_commitment)
        || 'Prepare the grounded proposal without requesting another confirmation.',
      payment_request: previousNextStep?.payment_request || {
        percentage: null,
        amount: null,
        currency: null,
        credits: null,
        url: null,
        instructions: null,
      },
      grounding_refs: Array.isArray(previousNextStep?.grounding_refs)
        ? previousNextStep.grounding_refs
        : [],
    },
  };

  return commercialStructuralViolation(repairedDecision, { activeCommercialRequests })
    ? null
    : repairedDecision;
}

async function routeModelWithReviewCore(prompt, hooks = {}) {
  const commercialPrompt = `${await appendCommercialActionContext(prompt)}

# Authoritative semantic response contract

${semanticStateConsistencyPrompt()}

Use commercial_action only for a real enabled side effect from the authoritative catalog, including the reversible durable internal request_custom_proposal action. Ordinary dialogue, discovery, clarification, recommendations, objection handling, sales progression, profile reasoning, and escalation reasoning must return the canonical not-selected object with selected=false and action_id=null. For request_custom_proposal, an explicit newest-message commitment to proceed with a coherent customer-grounded objective is authorization; option_id may be null when the catalog allows it, and optional delivery details may remain open. Include authorization_is_explicit, authorization_is_unambiguous, authorization_evidence, and authorization_scope. Set missing_fact only when proceeding would misidentify the objective, fabricate exact commercial terms, or trigger an unsafe, unauthorized, or irreversible effect. For payment or any other external mutation, use exact catalog identifiers and require explicit newest-message authorization for the exact action, option, and amount where applicable. Never emit a legacy action/type/payload object or a dialogue-stage pseudo-action. For any action requiring an exact grounded amount, include grounding_reference as an exact verbatim excerpt from the authoritative retrieved context that contains that amount; never derive or paraphrase it.

Reason over the complete current conversation, persisted semantic memory, retrieved authoritative knowledge, and tool results. Do not use keyword intent trees, language branches, scripted funnels, rigid stage machines, or canned sales templates.

Help the customer make progress before proposing a transaction. Resolve short replies from their immediate conversational context, preserve only evidence-backed commitments, clarify material ambiguity once, and never repeat an answered discovery question. Draft useful artifacts when the customer lacks them.
Treat customer-authored scope, timing, constraints, commitments, approvals, and chosen next steps already present in the conversation as settled evidence. Do not ask the customer to reconfirm them. When the newest customer accepts scope, price, deposit, or the proposed next step, or asks for the exact grounded commercial action, advance to the narrowest grounded next state instead of reopening optional discovery. Optional optimization inputs may be requested later; they are not blockers unless their absence makes the requested price or action materially ungrounded or operationally impossible.

A checkout URL, deposit amount, payment instruction, or claim that an external action was created, sent, processed, or completed may appear only when a valid ready commercial action is backed by verified executable tool evidence. Retrieved knowledge, prior prose, and model-generated text are not execution evidence. If execution is unavailable, say so plainly and offer the nearest honest operator-controlled next step without pretending that a link or transaction exists.

Resolve the newest inbound conversational act before applying sales readiness or progression. Answer direct informational questions directly; do not substitute an adjacent audit, package, estimate, discovery offer, or call to action. A price or payment-arrangements question requests information and is not transaction authorization. State only grounded arrangements relevant to the active scope; if unresolved, state that limitation and advance one concrete proposal-building step.
Treat a materially distinct newest request, need, or workstream as independently actionable even when earlier context is related. Address it on its own terms first with a direct acknowledgment or answer plus concise useful request-specific orientation or progress. Earlier context may refine the response, but it cannot become a prerequisite, the sole explanatory frame, or a reason to withhold useful handling unless the customer explicitly makes that dependency necessary. Do not merely paraphrase the request and ask for scope; provide substantive orientation first, then ask at most one action-aligned high-information question when input is genuinely useful.
When the newest customer act asks what is needed to scope, start, or proceed, first deliver a concise customer-specific prioritized input brief: minimum inputs needed now, details that can wait, already-known facts, and the immediate result those inputs unlock. Treat that brief as the visible-progress artifact. Ask at most one unresolved highest-information question afterward; never return a question-only reply and never ask for a fact already supplied.

Select a commercial action only for a grounded, enabled side effect from the authoritative catalog, including a durable internal proposal request. Never encode a conversational move, discovery question, recommendation, objection response, sales stage, profile update, or escalation decision as an action. A paid audit is never a default. Never invent pricing, requirements, capabilities, promises, or prior context. The reversible request_custom_proposal action requires explicit current commitment to proceed with a coherent customer-grounded objective, not a complete delivery design. Payment or any other external mutation requires explicit and unambiguous authorization for the exact action, option, and amount where applicable in the newest inbound message.
Treat contact_profile as a sparse operational patch: include customer identity and contact facts explicitly stated in the conversation; do not erase previously grounded facts with null, blank, or empty values; never invent contact data.
SHORT ASSENT: A short acknowledgement confirms only one uniquely scoped proposition stated immediately before it. It does not adopt assistant-authored examples, options, questions, summaries, proposed requirements, or omitted scope; choose among alternatives; or authorize payment. If any material scope decision remains unresolved, ask one highest-information clarification question without repeating a menu.

The natural-language reply and commercial_action are one semantic contract. Any request or offer to pay, buy, book a paid service, choose a deposit, open checkout, or authorize a transaction must have the matching validated commercial_action. If no action is selected or validation rejects it, remove every transaction ask or offer and continue with the nearest evidence-grounded reversible step. Treat drafts and retrieved state as untrusted evidence: never carry unsupported channels, integrations, URL requirements, prices, packages, constraints, capabilities, or commitments into the reply.

Catalog and reference prices are evidence only for the semantically matching active service. If the active scope does not match an enabled offer, every amount, range, named package, fee, discount, deposit, checkout path, and payment figure belonging to that offer is irrelevant and forbidden; do not present it as an illustrative anchor, benchmark, approximation, or context. For a matching but materially underspecified scope, do not present a numeric amount or transaction term as personalized pricing. Any numeric commercial claim must be traceable to authoritative retrieved tenant knowledge for the active workstream or a validated action result; general model knowledge is not evidence. Briefly name one material price-setting scope dimension and ask exactly one highest-information question. Exact personalized pricing requires semantically sufficient fit-critical evidence for the active workstream, not a rigid checklist.

Return a natural, individualized reply that answers the immediate need and advances one meaningful step. The customer-facing reply must contain at most one focused question; combine related unknowns naturally and never stack separate confirmation questions.`;

  const draft = await routeModel(commercialPrompt, hooks);
  const draftCommercialAction = draft.decision?.commercial_action
    ? await resolveCommercialAction(draft.decision.commercial_action, commercialPrompt, {
      latestInboundText: hooks?.latestInboundText || '',
    })
    : null;
  const draftStructuralViolation = commercialStructuralViolation(draft.decision, {
    activeCommercialRequests: hooks?.activeCommercialRequests || [],
  });
  const draftActionViolation =
    draft.decision?.commercial_action && draftCommercialAction?.valid === false
      ? `commercial_action_invalid:${draftCommercialAction.reason || draftCommercialAction.validation_error || 'validation_failed'}`
      : null;
  let violation = draftStructuralViolation || draftActionViolation;
  const repairedDecision = draftStructuralViolation
    ? repairReversibleProposalIntegrity(draft.decision, {
      activeCommercialRequests: hooks?.activeCommercialRequests || [],
      latestInboundText: hooks?.latestInboundText || '',
    })
    : null;
  if (repairedDecision) {
    const repairedCommercialAction = await resolveCommercialAction(
      repairedDecision.commercial_action,
      commercialPrompt,
      { latestInboundText: hooks?.latestInboundText || '' },
    );
    if (repairedCommercialAction?.valid !== false) {
      return {
        ...draft,
        decision: repairedDecision,
        commercialAction: repairedCommercialAction,
        independentReview: {
          performed: false,
          correctionPerformed: true,
          reason: 'deterministic_reversible_integrity_repair',
          initialViolation: violation,
        },
      };
    }
    violation = `commercial_action_invalid:${repairedCommercialAction.reason || repairedCommercialAction.validation_error || 'validation_failed'}`;
  }
  if (!violation) {
    return {
      ...draft,
      commercialAction: draftCommercialAction,
      independentReview: {
        performed: false,
        correctionPerformed: false,
        reason: 'single_turn_structurally_valid',
      },
    };
  }

  const correctionPrompt = [
    commercialPrompt,
    '',
    'STRUCTURAL/ACTION CONTRACT REPAIR (one bounded retry only):',
    `Violation: ${violation}`,
    'Return a complete replacement JSON decision that preserves the established customer language and grounded facts while satisfying both the structural and commercial-action contracts. Do not add another confirmation when readiness and scope are already sufficient.',
    'When the customer is explicitly ready, optional discovery details must remain bounded assumptions or unresolved request details rather than blocking the reversible request_custom_proposal action.',
      `Previous decision: ${JSON.stringify(draft.decision).slice(0, 6000)}`,
  ].join('\n');
  const corrected = await routeModel(correctionPrompt, hooks);
  const correctedCommercialAction = corrected.decision?.commercial_action
    ? await resolveCommercialAction(corrected.decision.commercial_action, commercialPrompt, {
      latestInboundText: hooks?.latestInboundText || '',
    })
    : null;
  const correctedStructuralViolation = commercialStructuralViolation(corrected.decision, {
    activeCommercialRequests: hooks?.activeCommercialRequests || [],
  });
  const correctedActionViolation =
    corrected.decision?.commercial_action && correctedCommercialAction?.valid === false
      ? `commercial_action_invalid:${correctedCommercialAction.reason || correctedCommercialAction.validation_error || 'validation_failed'}`
      : null;
  const remainingViolation = correctedStructuralViolation || correctedActionViolation;
  if (remainingViolation) {
    const error = new Error(`Commercial decision remained structurally invalid after one correction: ${remainingViolation}`);
    error.code = 'COMMERCIAL_STRUCTURAL_CORRECTION_FAILED';
    throw error;
  }

  return {
    ...corrected,
    latencyMs: Number(draft.latencyMs || 0) + Number(corrected.latencyMs || 0),
    failures: [...(draft.failures || []), ...(corrected.failures || [])],
    commercialAction: correctedCommercialAction,
    independentReview: {
      performed: false,
      correctionPerformed: true,
      reason: 'structural_or_action_contract_repair',
      initialViolation: violation,
    },
  };
}
export function releaseTextOnlyAfterConformanceFailure(
  result,
  error,
  semanticConformance = {},
) {
  const code = error?.code || 'SEMANTIC_CONFORMANCE_RELEASE_BLOCKED';
  const violations = Array.isArray(error?.violations)
    ? error.violations
    : [];
  const safeReply = String(result?.decision?.reply || '').trim();
  return {
    ...result,
    shouldReply: Boolean(safeReply),
    decision: {
      ...(result?.decision || {}),
      reply: safeReply,
      commercial_action: null,
    },
    commercialAction: null,
    failures: [
      ...new Set([
        ...(Array.isArray(result?.failures) ? result.failures : []),
        ...(Array.isArray(error?.failures) ? error.failures : []),
        `semantic_conformance_text_only_fail_safe:${code}`,
      ]),
    ],
    semanticConformance: {
      ...semanticConformance,
      performed: true,
      passed: false,
      advisory: false,
        releaseMode: 'text_only_fail_safe',
      actionsBlocked: true,
      violations,
      error: String(error?.message || error).slice(0, 1000),
    },
  };
}

export function hasCommercialActionSelection(result) {
  return selectedCommercialActionId(result?.decision) !== null;
}

async function routeModelWithReviewBounded(prompt, hooks = {}) {
  const coreResult = await routeModelWithReviewCore(prompt, hooks);
  const runtimeConformanceEnabled = !/^(0|false|no|off)$/i.test(
    String(process.env.MODEL_RUNTIME_CONFORMANCE_ENABLED || 'false'),
  );

  if (!runtimeConformanceEnabled) {
    return {
      ...coreResult,
      semanticConformance: {
        performed: false,
        advisory: false,
        reason: 'disabled_for_live_runtime',
        passed: null,
        correctionPerformed: false,
        correctionRounds: 0,
        attempts: 0,
        modelCalls: 0,
      },
    };
  }

  const semanticContext = [
    await appendCommercialActionContext(prompt),
    `AUTHORITATIVE COMMERCIAL-ACTION AUDIT
Before passing any candidate response, verify commercial_action by its declared effect:
- Treat request_custom_proposal as a reversible durable internal action: it records one authorized proposal request and must not be described as payment, contract acceptance, provider delivery, or another external mutation.
- Treat payment links, charges, bookings, provider sends, CRM mutations, and other externally visible or irreversible actions as external side effects requiring exact catalog eligibility, grounded arguments, explicit authorization, idempotency, and verified postconditions.
- Ordinary conversation, discovery, clarification, recommendations, objection handling, sales progression, profile reasoning, and escalation reasoning must keep commercial_action not selected.
- If the candidate selects a disabled action or a pseudo-action absent from the catalog, fail and require selected=false with action_id=null.
- request_custom_proposal may pass when the newest customer turn explicitly and unambiguously commits to receiving or advancing a proposal and the objective plus outcome are coherent; optional implementation details may remain proposal assumptions.
- An external or irreversible action passes only when the newest inbound message explicitly and unambiguously authorizes the exact action and option.
- Never require an action merely because the assistant asks a question or advances the conversation.
These rules govern safe action execution; they do not create keyword, language, intent, or sales-stage branches.`,
  ].join('\n\n');
  const conformanceRuns = [];
  const corrections = [];
  const correctionExecutions = [];
  let cumulativeViolations = [];
  let finalResult = enforceResolvedActionStructure(coreResult);
  const rejectedDecisions = [finalResult.decision];
  let conformanceError = null;

  try {
    let assessmentRun = await assessSemanticConformance(
      appendResolvedCommercialActionContract(semanticContext, finalResult),
      finalResult.decision,
      hooks,
    );
    conformanceRuns.push(assessmentRun);
    cumulativeViolations = [...assessmentRun.assessment.violations];
    let authoritativeCommercialActionContract =
      strengthenCommercialActionContract(
        assessmentRun.assessment,
        finalResult.decision,
      );
      assessmentRun.assessment.commercial_action_contract =
        authoritativeCommercialActionContract;

    for (
      let round = 0;
      !assessmentRun.assessment.passes &&
      round < MAX_CONFORMANCE_CORRECTIONS;
      round += 1
    ) {
      const correction = await routeModel(
        buildConformanceCorrectionPrompt(
          semanticContext,
          finalResult.decision,
          {
            passes: false,
            replacement_required: true,
            // Earlier violations describe superseded drafts. Feeding them back
            // into later correction rounds creates contradictory instructions.
            violations: assessmentRun.assessment.violations,
            commercial_action_contract:
              authoritativeCommercialActionContract,
            correction_round: round + 1,
            remaining_rounds: MAX_CONFORMANCE_CORRECTIONS - round - 1,
          },
          rejectedDecisions.slice(-1),
        ),
        hooks,
      );
      corrections.push(correction);
      preserveContactProfile(
        correction.decision,
        coreResult.decision,
        ...corrections.slice(0, -1).map((item) => item.decision),
      );
      // The semantic assessor is authoritative only for the structured action
      // handoff. The model remains responsible for all customer-facing prose.
      enforceCommercialActionContract(
        correction.decision,
        authoritativeCommercialActionContract,
        rejectedDecisions,
      );

      const correctedCommercialActionSelection =
        correction.decision.commercial_action;
      const correctedCommercialActionAllowed =
        commercialActionSelectionAllowedByContract(
          correctedCommercialActionSelection,
          authoritativeCommercialActionContract,
        );
      const correctedCommercialAction = correctedCommercialActionAllowed
        ? await resolveCommercialAction(
          correctedCommercialActionSelection,
          prompt,
        )
        : {
            valid: false,
            reason:
              'commercial_action rejected by authoritative conformance contract',
          };
      correction.decision.commercial_action = correctedCommercialAction.valid
        ? correctedCommercialActionSelection
        : null;

      let correctedResult = correction;
      if (correctedCommercialAction.valid) {
        const executedCorrection = await routeModel(
          appendCommercialActionExecution(
            buildExecutionPrompt(
              appendResolvedCommercialActionContract(semanticContext, {
                ...correction,
                commercialAction: correctedCommercialAction,
              }),
              correction,
              {
                ...assessmentRun.assessment,
                commercial_action_contract: {
                  required_action_id: selectedCommercialActionId(
                    correction.decision,
                  ),
                  forbidden_action_ids:
                    authoritativeCommercialActionContract
                      .forbidden_action_ids,
                },
              },
            ),
            correctedCommercialAction,
          ),
          hooks,
        );
        correctionExecutions.push(executedCorrection);
        preserveContactProfile(
          executedCorrection.decision,
          correction.decision,
          coreResult.decision,
          ...corrections.slice(0, -1).map((item) => item.decision),
          ...correctionExecutions
            .slice(0, -1)
            .map((item) => item.decision),
        );
        executedCorrection.decision.commercial_action =
          correctedCommercialActionSelection;
        correctedResult = executedCorrection;
      }

    finalResult = {
      ...correctedResult,
      commercialAction: correctedCommercialAction.valid
        ? correctedCommercialAction
        : null,
      independentReview: coreResult.independentReview,
    };
    finalResult = enforceResolvedActionStructure(finalResult);
    enforceCommercialActionContract(
      finalResult.decision,
      authoritativeCommercialActionContract,
      rejectedDecisions,
    );
    rejectedDecisions.push(finalResult.decision);
    assessmentRun = await assessSemanticConformance(
        appendResolvedCommercialActionContract(
          semanticContext,
          finalResult,
        ),
        finalResult.decision,
        hooks,
        authoritativeCommercialActionContract,
      );
      authoritativeCommercialActionContract =
        strengthenCommercialActionContract(
          assessmentRun.assessment,
          finalResult.decision,
          authoritativeCommercialActionContract,
        );
      assessmentRun.assessment.commercial_action_contract =
        authoritativeCommercialActionContract;
      conformanceRuns.push(assessmentRun);
      cumulativeViolations = [...assessmentRun.assessment.violations];
    }

    const finalAssessment = conformanceRuns.at(-1).assessment;
    if (!finalAssessment.passes) {
      conformanceError = new Error(
        `Semantic conformance failed after ${corrections.length} correction round(s): ${JSON.stringify(finalAssessment.violations)}`,
      );
      conformanceError.code = 'SEMANTIC_CONFORMANCE_FAILED';
      conformanceError.violations = finalAssessment.violations;
      conformanceError.commercialActionContract =
        finalAssessment.commercial_action_contract;
    }
  } catch (error) {
    conformanceError = error;
  }

  const correction = corrections.at(-1) || null;
  const assessorResults = conformanceRuns.flatMap(
    ({ attempts, routed }) => attempts || [routed],
  );
  const gateResults = [
    ...assessorResults,
    ...corrections,
    ...correctionExecutions,
  ];

  const routeFailures = [
    ...(coreResult.failures || []),
    ...gateResults.flatMap((result) => result.failures || []),
  ];
  const fallbackCount = routeFailures.filter(
    (failure) => failure?.fallback === true,
  ).length;
  const retryCount = routeFailures.length - fallbackCount;

  const routedResult = {
    ...(finalResult || coreResult),
    failures: routeFailures,
    fallbackCount,
    retryCount,
    attemptCount: routeFailures.length + 1,
    latencyMs:
      (coreResult.latencyMs || 0) +
      gateResults.reduce((total, result) => total + (result.latencyMs || 0), 0),
  };
  const semanticConformance = {
    performed: true,
    passed: conformanceRuns.at(-1)?.assessment?.passes === true,
    advisory: false,
    error: conformanceError
      ? String(conformanceError?.message || conformanceError).slice(0, 1000)
      : null,
    correctionPerformed: Boolean(correction),
    correctionRounds: corrections.length,
    attempts: conformanceRuns.length,
    modelCalls: gateResults.length,
    initialViolations: conformanceRuns[0]?.assessment?.violations || [],
    assessorRoutes: assessorResults.map(
      (result) => result.route?.id || null,
    ),
    assessorModels: assessorResults.map(
      (result) => result.route?.model || null,
    ),
    correctionRoute: correction?.route?.id || null,
    correctionModel: correction?.route?.model || null,
  };

  if (conformanceError) {
    conformanceError.code =
      conformanceError.code || 'SEMANTIC_CONFORMANCE_RELEASE_BLOCKED';
    conformanceError.failures = [...new Set(cumulativeViolations)];
    conformanceError.model = finalResult?.model || coreResult?.model || null;
    return releaseTextOnlyAfterConformanceFailure(
      enforceResolvedActionStructure(coreResult),
      conformanceError,
      semanticConformance,
    );
  }

  return {
    ...routedResult,
    semanticConformance,
  };
}

export async function routeModelWithReview(prompt, hooks = {}) {
  // Every live decision passes deterministic structural validation. The
  // bounded path performs no subjective model review unless explicitly
  // enabled, and permits one corrective model call only after a structural
  // contract violation.
  const configuredBudget = Number(process.env.MODEL_TURN_BUDGET_MS || 180000);
  const budgetMs = Number.isFinite(configuredBudget) && configuredBudget > 1000
    ? configuredBudget
    : 180000;
  const activeBudget = modelTurnBudget.getStore();

  if (activeBudget) return routeModelWithReviewBounded(prompt, hooks);

  return modelTurnBudget.run(
    { deadline: Date.now() + budgetMs },
    () => routeModelWithReviewBounded(prompt, hooks),
  );
}
