import crypto from 'node:crypto';

import { claimCommercialRequest } from './runtime-store.mjs';

const PROPOSAL_ACTION = 'request_custom_proposal';
const EXECUTABLE_RESOLUTION_STATUSES = new Set([
  'ready',
  'ready_for_execution',
  'already_active',
  'executed',
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedText(value, maximum = 1_000) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function actionName(value) {
  const candidate = object(value);
  return candidate.action || candidate.action_id || candidate.actionId || candidate.name || null;
}

function rawProposalAction(result) {
  const candidates = [
    result?.commercial_action,
    result?.commercialAction,
    result?.decision?.commercial_action,
    result?.decision?.commercialAction,
    result?.action,
  ];
  return candidates.find((candidate) => actionName(candidate) === PROPOSAL_ACTION) || null;
}

function validatedProposalAction(result) {
  const resolution = object(
    result?.commercial_action_resolution || result?.commercialActionResolution,
  );
  if (resolution.valid !== true || !EXECUTABLE_RESOLUTION_STATUSES.has(resolution.status)) {
    return null;
  }

  const selection = object(resolution.selection);
  if (actionName(selection) !== PROPOSAL_ACTION) return null;
  return {
    action: {
      ...object(selection.arguments),
      ...selection,
    },
    resolution,
  };
}

function normalizedIdentity(value) {
  return boundedText(value, 300)?.toLocaleLowerCase('en-US') || null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableLifecycleKey(payload, action, confirmedScopeSummary) {
  const tenantId = payload.tenant_id || payload.tenantId;
  const conversationId = payload.conversation_id || payload.conversationId;
  const workstream = normalizedIdentity(
    action.workstream_id || action.workstreamId || action.scope_key || action.scopeKey,
  );
  const scopeIdentity = workstream || sha256(normalizedIdentity(confirmedScopeSummary) || 'default');
  return sha256([tenantId, conversationId, PROPOSAL_ACTION, scopeIdentity].join(':'));
}

function serverIdempotencyKey({ tenantId, conversationId, lifecycleKey }) {
  return `${PROPOSAL_ACTION}:${sha256([tenantId, conversationId, lifecycleKey].join(':'))}`;
}

function uuidList(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Set();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const candidate = item.trim().toLowerCase();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate)) {
      unique.add(candidate);
    }
    if (unique.size >= 20) break;
  }
  return [...unique];
}

function claimField(claimed, snake, camel, fallback = null) {
  return claimed?.[snake] ?? claimed?.[camel] ?? fallback;
}

function rejectUnvalidatedAction(result, reason) {
  const existingResolution = object(
    result?.commercial_action_resolution || result?.commercialActionResolution,
  );
  return {
    ...result,
    commercial_action: null,
    commercialAction: null,
    commercial_action_resolution: {
      ...existingResolution,
      valid: false,
      status: 'rejected',
      reason,
      selection: null,
      execution: null,
    },
  };
}

export async function enforceDecisionIntegrity(payload, result) {
  const rawAction = rawProposalAction(result);
  const validated = validatedProposalAction(result);
  if (!rawAction && !validated) return result;
  if (!validated) {
    return rejectUnvalidatedAction(result, 'commercial_action_not_validated_for_execution');
  }

  const tenantId = boundedText(payload.tenant_id || payload.tenantId, 200);
  const conversationId = boundedText(payload.conversation_id || payload.conversationId, 300);
  if (!tenantId || !conversationId) {
    return rejectUnvalidatedAction(result, 'commercial_action_missing_tenant_or_conversation');
  }

  const { action, resolution } = validated;
  const authorizationExplicit = action.authorization_is_explicit === true
    || action.authorizationIsExplicit === true;
  const authorizationUnambiguous = action.authorization_is_unambiguous === true
    || action.authorizationIsUnambiguous === true;
  const authorizationEvidence = boundedText(
    action.authorization_evidence || action.authorizationEvidence,
    1_000,
  );
  const missingFact = boundedText(action.missing_fact || action.missingFact, 1_000);
  if (missingFact) {
    return rejectUnvalidatedAction(result, 'commercial_action_has_unresolved_material_fact');
  }
  if (!authorizationExplicit || !authorizationUnambiguous || !authorizationEvidence) {
    return rejectUnvalidatedAction(result, 'commercial_action_requires_explicit_unambiguous_authorization');
  }
  const customerCommitment = boundedText(
    action.customer_commitment
      || action.customerCommitment
      || action.authorization_evidence
      || action.authorizationEvidence,
    1_000,
  );
  const confirmedScopeSummary = boundedText(
    action.confirmed_scope_summary
      || action.confirmedScopeSummary
      || action.authorization_scope
      || action.authorizationScope
      || action.scope_summary
      || action.scopeSummary,
    2_000,
  );
  if (!customerCommitment || !confirmedScopeSummary) {
    return rejectUnvalidatedAction(result, 'commercial_action_missing_bounded_commitment_or_scope');
  }

  const lifecycleKey = stableLifecycleKey(payload, action, confirmedScopeSummary);
  const idempotencyKey = serverIdempotencyKey({ tenantId, conversationId, lifecycleKey });
  const sourceInboundMessageId = boundedText(
    payload.inbound_message_id || payload.inboundMessageId,
    200,
  );
  const evidenceIds = uuidList(action.evidence_ids || action.evidenceIds);

  const claimed = await claimCommercialRequest({
    tenantId,
    conversationId,
    action: PROPOSAL_ACTION,
    lifecycleKey,
    idempotencyKey,
    customerCommitment,
    sourceInboundMessageId,
    evidenceIds,
    confirmedScopeSummary,
    context: {
      workstream_id: boundedText(action.workstream_id || action.workstreamId, 300),
      authorization_evidence_hash: authorizationEvidence ? sha256(authorizationEvidence) : null,
      source: 'validated_brain_decision',
    },
  });

  const created = Boolean(claimField(claimed, 'created', 'created', false));
  const requestId = claimField(claimed, 'request_id', 'requestId');
  const requestStatus = claimField(claimed, 'request_status', 'requestStatus', 'active');
  const execution = {
    ...object(resolution.execution),
    persisted: true,
    request_id: requestId,
    request_status: requestStatus,
    created,
    idempotency_key: idempotencyKey,
    lifecycle_key: lifecycleKey,
  };

  return {
    ...result,
    commercial_action: created ? action : null,
    commercialAction: null,
    commercial_action_resolution: {
      ...resolution,
      status: created ? 'executed' : 'already_active',
      execution,
    },
    commercial_request: {
      id: requestId,
      status: requestStatus,
      created,
      lifecycle_key: lifecycleKey,
      idempotency_key: idempotencyKey,
    },
  };
}

export async function finalizeDecisionIntegrity({ input, result }) {
  return enforceDecisionIntegrity(input, result);
}
