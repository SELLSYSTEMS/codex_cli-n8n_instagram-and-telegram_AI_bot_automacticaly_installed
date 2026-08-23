const DEFAULT_HISTORY_LIMIT = 12;

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function cleanString(value) {
  const normalized = normalizeString(value);
  return typeof normalized === 'string' ? normalized : '';
}

function isMeaningful(value, allowNull = false) {
  if (value === null) return allowNull;
  if (value === undefined) return false;
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

function stableKey(value) {
  if (typeof value === 'string') return `string:${value.trim()}`;
  try {
    return `json:${JSON.stringify(value)}`;
  } catch {
    return `value:${String(value)}`;
  }
}

function mergeArrays(base, incoming) {
  const merged = [];
  const seen = new Set();

  for (const value of [...base, ...incoming]) {
    const normalized = normalizeString(value);
    if (!isMeaningful(normalized)) continue;
    const key = stableKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }

  return merged;
}

export function mergeSemanticState(base = {}, incoming = {}, { allowNull = true } = {}) {
  const result = isPlainObject(base) ? structuredClone(base) : {};
  if (!isPlainObject(incoming)) return result;

  for (const [key, rawValue] of Object.entries(incoming)) {
    const value = normalizeString(rawValue);
    if (!isMeaningful(value, allowNull)) continue;

    if (value === null) {
      if (!isMeaningful(result[key], false)) result[key] = null;
      continue;
    }

    if (Array.isArray(value)) {
      result[key] = mergeArrays(
        Array.isArray(result[key]) ? result[key] : [],
        value,
      );
      continue;
    }

    if (isPlainObject(value)) {
      result[key] = mergeSemanticState(
        isPlainObject(result[key]) ? result[key] : {},
        value,
        { allowNull },
      );
      continue;
    }

    result[key] = value;
  }

  return result;
}

const STATE_FIELD_ALIASES = {
  intent: ['intent'],
  conversation_phase: ['conversationPhase', 'conversation_phase'],
  customer_readiness: ['customerReadiness', 'customer_readiness'],
  material_blocker: ['materialBlocker', 'material_blocker'],
  next_best_action: ['nextBestAction', 'next_best_action'],
  commercial_progress: ['commercialProgress', 'commercial_progress'],
  decision_status: ['decisionStatus', 'decision_status'],
  confirmed_commitments: ['confirmedCommitments', 'confirmed_commitments'],
  pending_customer_commitment: ['pendingCustomerCommitment', 'pending_customer_commitment'],
  solution_scope: ['solutionScope', 'solution_scope'],
  active_workstream: ['activeWorkstream', 'active_workstream', 'currentWorkstream', 'current_workstream'],
  workstream_changed: ['workstreamChanged', 'workstream_changed'],
  known_facts: ['knownFacts', 'known_facts'],
  open_questions: ['openQuestions', 'open_questions'],
  customer_objectives: ['customerObjectives', 'customer_objectives'],
  decision_criteria: ['decisionCriteria', 'decision_criteria'],
  objections: ['objections'],
  commercial_context: ['commercialContext', 'commercial_context'],
};

function firstMeaningful(source, aliases) {
  for (const alias of aliases) {
    if (!Object.hasOwn(source, alias)) continue;
    const value = normalizeString(source[alias]);
    if (isMeaningful(value, false)) return value;
  }
  return undefined;
}

function firstPresent(source, aliases) {
  for (const alias of aliases) {
    if (Object.hasOwn(source, alias)) return source[alias];
  }
  return undefined;
}

export function deriveSemanticState(decision = {}, priorState = {}) {
  const source = isPlainObject(decision) ? decision : {};
  const nestedState = isPlainObject(source.semanticState)
    ? source.semanticState
    : isPlainObject(source.semantic_state)
      ? source.semantic_state
      : {};

  const topLevelState = {};

  for (const [field, aliases] of Object.entries(STATE_FIELD_ALIASES)) {
    const value = firstMeaningful(source, aliases);
    if (value !== undefined) topLevelState[field] = value;
  }

  let state = mergeSemanticState(priorState, topLevelState, { allowNull: false });
  state = mergeSemanticState(state, nestedState, { allowNull: true });

  const nestedOpenQuestions = firstPresent(
    nestedState,
    STATE_FIELD_ALIASES.open_questions,
  );
  const sourceOpenQuestions = firstPresent(
    source,
    STATE_FIELD_ALIASES.open_questions,
  );
  const explicitOpenQuestions = nestedOpenQuestions !== undefined
    ? nestedOpenQuestions
    : sourceOpenQuestions;
  if (explicitOpenQuestions === null) {
    state.open_questions = [];
  } else if (Array.isArray(explicitOpenQuestions)) {
    state.open_questions = [...new Set(
      explicitOpenQuestions
        .map((value) => normalizeString(value))
        .filter((value) => isMeaningful(value, false)),
    )];
  }

  const nestedMaterialBlocker = firstPresent(
    nestedState,
    STATE_FIELD_ALIASES.material_blocker,
  );
  const sourceMaterialBlocker = firstPresent(
    source,
    STATE_FIELD_ALIASES.material_blocker,
  );
  const explicitMaterialBlocker = nestedMaterialBlocker !== undefined
    ? nestedMaterialBlocker
    : sourceMaterialBlocker;
  const materialBlockerWasExplicitlyCleared =
    explicitMaterialBlocker === null
    || (
      typeof explicitMaterialBlocker === 'string'
      && explicitMaterialBlocker.trim() === ''
    );
  if (materialBlockerWasExplicitlyCleared) {
    state.material_blocker = null;
    if (explicitOpenQuestions === undefined) {
      state.open_questions = [];
    }
  } else if (
    (
      explicitOpenQuestions === null
      || (Array.isArray(explicitOpenQuestions) && state.open_questions.length === 0)
    )
    && explicitMaterialBlocker === undefined
  ) {
    state.material_blocker = null;
  }

  const nestedPendingCustomerCommitment = firstPresent(
    nestedState,
    STATE_FIELD_ALIASES.pending_customer_commitment,
  );
  const sourcePendingCustomerCommitment = firstPresent(
    source,
    STATE_FIELD_ALIASES.pending_customer_commitment,
  );
  const explicitPendingCustomerCommitment =
    nestedPendingCustomerCommitment !== undefined
      ? nestedPendingCustomerCommitment
      : sourcePendingCustomerCommitment;
  if (
    explicitPendingCustomerCommitment === null
    || (
      typeof explicitPendingCustomerCommitment === 'string'
      && explicitPendingCustomerCommitment.trim() === ''
    )
  ) {
    state.pending_customer_commitment = null;
  }

  return state;
}

export function compactCommercialAction(value) {
  if (!isPlainObject(value)) return null;
  const actionId = typeof value.action_id === 'string' ? value.action_id.trim() : '';
  if (!actionId) return null;
  return {
    ...value,
    action_id: actionId,
  };
}

export function boundedHistory(history, limit = DEFAULT_HISTORY_LIMIT) {
  if (!Array.isArray(history)) return [];
  const parsedLimit = Number(limit);
  const safeLimit = Number.isInteger(parsedLimit) && parsedLimit > 0
    ? parsedLimit
    : DEFAULT_HISTORY_LIMIT;
  return history.slice(-safeLimit);
}

export function appendConversationEvidence(
  priorState = {},
  {
    userText = '',
    assistantReply = '',
    decision = {},
    limit = DEFAULT_HISTORY_LIMIT,
  } = {},
) {
  const previous = isPlainObject(priorState) ? priorState : {};
  const commitments = decision.confirmed_commitments || decision.confirmedCommitments;
  const solutionScope = decision.solution_scope || decision.solutionScope;
  const evidenceItem = {
    user: cleanString(userText),
    assistant: cleanString(assistantReply),
    summary: cleanString(decision.conversation_summary || decision.conversationSummary),
    commitments: Array.isArray(commitments)
      ? commitments.map((item) => cleanString(item)).filter(Boolean)
      : [],
    solution_scope: isPlainObject(solutionScope) ? structuredClone(solutionScope) : {},
  };
  const hasEvidence = Boolean(
    evidenceItem.user
    || evidenceItem.assistant
    || evidenceItem.summary
    || evidenceItem.commitments.length
    || Object.keys(evidenceItem.solution_scope).length,
  );
  const priorEvidence = boundedHistory(previous.recent_evidence, limit);
  return hasEvidence
    ? boundedHistory([...priorEvidence, evidenceItem], limit)
    : priorEvidence;
}
