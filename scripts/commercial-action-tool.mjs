import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultCatalogPath = path.join(root, 'config', 'commercial-actions.default.json');
const privateCatalogPath = path.join(root, '.private', 'commercial-actions.json');

async function readJson(filePath, optional = false) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return {};
    throw error;
  }
}

function mergeById(base = [], override = []) {
  const merged = new Map();

  for (const item of base) {
    if (item && typeof item.id === 'string') merged.set(item.id, { ...item });
  }

  for (const item of override) {
    if (!item || typeof item.id !== 'string') continue;
    merged.set(item.id, { ...(merged.get(item.id) || {}), ...item });
  }

  return [...merged.values()];
}

function baseCleanSelection(raw) {
  const action = raw && typeof raw === 'object' ? raw : {};
  const args = action.arguments && typeof action.arguments === 'object' ? action.arguments : {};
  const total = Number(args.grounded_total_usd);

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
      grounded_total_usd: Number.isFinite(total) && total > 0 ? total : null,
      grounding_reference: typeof args.grounding_reference === 'string' && args.grounding_reference.trim()
        ? args.grounding_reference.trim()
        : null,
      missing_fact: typeof args.missing_fact === 'string' && args.missing_fact.trim()
        ? args.missing_fact.trim()
        : null,
      customer_commitment: typeof args.customer_commitment === 'string' && args.customer_commitment.trim()
        ? args.customer_commitment.trim()
        : null,
      authorization_is_explicit: args.authorization_is_explicit === true,
      authorization_is_unambiguous: args.authorization_is_unambiguous === true,
      authorization_evidence: typeof args.authorization_evidence === 'string' && args.authorization_evidence.trim()
        ? args.authorization_evidence.trim()
        : null,
      authorization_scope: typeof args.authorization_scope === 'string' && args.authorization_scope.trim()
        ? args.authorization_scope.trim()
        : null,
    },
  };
}
const TRANSACTIONAL_COMMERCIAL_ACTIONS = new Set(["request_payment_choice","present_checkout"]);

function cleanSelection(...callArguments) {
  const input = callArguments[0];
  const selection = baseCleanSelection(...callArguments);
  if (!selection || typeof selection !== 'object') return selection;

  const candidates = [selection, selection.action, selection.commercial_action, input, input?.action, input?.commercial_action]
    .filter((value) => value && typeof value === 'object');
  const selected = candidates.find((value) => {
    const id = value.action_id ?? value.actionId ?? value.id ?? (typeof value.action === 'string' ? value.action : '');
    return TRANSACTIONAL_COMMERCIAL_ACTIONS.has(String(id));
  });
  if (!selected) return selection;

  const args = [selected.arguments, selected.args, input?.arguments, input?.args, input?.commercial_action?.arguments]
    .find((value) => value && typeof value === 'object') || {};
  const evidence = String(args.authorization_evidence || selected.authorization_evidence || '').trim();
  const scope = String(args.authorization_scope || selected.authorization_scope || '').trim();
  const authorized = args.authorization_is_explicit === true
    && args.authorization_is_unambiguous === true
    && evidence.length > 0
    && scope.length > 0;
  if (authorized) return selection;

  selection.action_id = null;
  selection.selection_reason = selection.selection_reason
    || 'The newest inbound message does not explicitly and unambiguously authorize the exact transactional action and option.';
  selection.requested_commitment = null;
  selection.arguments = {
    ...selection.arguments,
    option_id: null,
    grounded_total_usd: null,
    customer_commitment: null,
    authorization_is_explicit: false,
    authorization_is_unambiguous: false,
    authorization_evidence: null,
    authorization_scope: null,
  };
  return selection;
}


function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function referenceIsGrounded(reference, amount, sourcePrompt) {
  if (!reference || !sourcePrompt) return false;

  const source = String(sourcePrompt).toLocaleLowerCase();
  const evidence = String(reference).trim().toLocaleLowerCase();
  if (!source.includes(evidence)) return false;

  const numbers = String(reference)
    .match(/(?:\d[\d,]*(?:\.\d+)?)/g)
    ?.map((value) => Number(value.replaceAll(',', '')))
    .filter(Number.isFinite) || [];

  return numbers.some((value) => Math.abs(value - amount) < 0.005);
}

export async function loadCommercialActionCatalog() {
  const [base, override] = await Promise.all([
    readJson(defaultCatalogPath),
    readJson(privateCatalogPath, true),
  ]);

  return {
    ...base,
    ...override,
    instructions: { ...(base.instructions || {}), ...(override.instructions || {}) },
    checkout: { ...(base.checkout || {}), ...(override.checkout || {}) },
    payment_options: mergeById(base.payment_options, override.payment_options),
    actions: mergeById(base.actions, override.actions),
  };
}

export async function appendCommercialActionContext(prompt) {
  const catalog = await loadCommercialActionCatalog();
  const availableCatalog = {
    version: catalog.version,
    selection_mode: catalog.selection_mode,
    instructions: catalog.instructions,
    checkout: catalog.checkout,
    payment_options: catalog.payment_options?.filter((option) => option.enabled),
    actions: catalog.actions?.filter((action) => action.enabled),
  };

  return `${prompt}

COMMERCIAL ACTION TOOL CATALOG
This runtime catalog exposes actions and verified checkout facts. It is not dialogue copy and none of its wording is a response template.
Choose an action through semantic reasoning from the full conversation, memory, retrieved evidence, and current customer readiness.
Use action_id null when no enabled executable action can responsibly run now; a null action is not permission for the conversation to stall.
Treat the customer's explicit current facts as authoritative for their situation. If retrieved examples or generic documents conflict with the customer's stated channels, scope, service, constraints, or priorities, preserve the customer facts and ignore the conflicting example. Use RAG to ground company capabilities, policy, evidence, and offers, never to invent or replace customer facts.
A short confirmation belongs to the immediately preceding proposition. It authorizes a transaction only when that proposition named the exact enabled action and option; otherwise keep action_id null and continue naturally. When exact valid authorization is present, select the matching action now.
Do not repeat an offer, price, checkout link, or paid diagnostic unless the customer asks for it again or materially new information changes the recommendation. During exploration, answer usefully and ask at most one high-information question; never use a paid audit as the automatic next step.
Never invent a quote. Set grounded_total_usd only when the exact total is explicitly present in the conversation, retrieved knowledge, or another tool result contained above. Copy the exact supporting phrase into grounding_reference.
Select only real enabled actions from the catalog. Never invent authorization, quote-preparation, follow-up, or other pseudo-actions whose only effect is promising future work. Resolve commitments from the full conversation and the immediately preceding assistant request, not from the latest customer sentence in isolation. A cooperative reply may both accept a request and add or refine a requirement; preserve both meanings and advance the state.
Distinguish four semantic states instead of collapsing them into a sales funnel: interest in a problem, evaluation of a possible solution, acceptance of a specific commercial scope, and authorization of an exact transaction. A need, desired outcome, channel, pain point, technical question, or willingness to continue is useful consultation context; none of those alone accepts a paid audit, service, checkout, or deposit.

CONVERSATION PROGRESSION CONTRACT:
- Interpret every new message in the context of the complete conversation state. A short addition or confirmation updates the current scope; it does not start a fresh discovery flow or erase previously agreed requirements.
- Discovery must converge. Never repeat the same request for information after the customer has supplied a new requirement, confirmed direction, or said they do not have that material. Synthesize what is known, expose only material assumptions, and ask at most the single highest-information question needed for the next decision.
- If an utterance has multiple plausible meanings and choosing between them would materially change scope, price, delivery, risk, or the commercial next step, ask one concise semantic clarification. Do not silently select an interpretation and do not treat ambiguity as transaction authorization.
- Do not require the customer to author FAQs, scripts, templates, specifications, or other implementation artifacts before you can advise them. Use conversation context, retrieved knowledge, and professional judgment to propose a concrete first draft or scoped recommendation, then invite correction.
- When enough scope is known and the customer repeatedly signals a desire to proceed, stop collecting generic discovery data. Briefly synthesize the individualized solution, its value and important assumptions, then propose one concrete next step that advances the decision. This can be scope confirmation, a grounded estimate, a proposal, or a transaction request according to readiness; it is never permission to execute a transaction without exact authorization.
- Respond to meaning rather than literal wording. Do not use language-specific branches, keyword trees, canned dialogue stages, or copied sales templates to decide what the customer means.

PRICING AND OFFER CONTRACT:
- A price question or price objection is evidence that the customer is evaluating a solution. It is not acceptance of an offer and must not trigger an unrelated package, fixed-price anchor, paid audit, checkout, or deposit request.
- Mention a price or commercial package only when it is grounded in retrieved company knowledge and relevant to the currently understood scope. If a reliable matching price cannot yet be determined, explain the one material scope variable that affects it and ask only for that variable.
- A paid audit is one possible diagnostic service, not a default funnel or prerequisite. Recommend it only when the customer's situation genuinely requires diagnostic work and the retrieved offer data supports that recommendation.
- Do not rush a low-information lead into commitment. Do not keep a decision-ready lead in discovery. Use the semantic commercial state and the evidence in the full thread to choose the proportionate next step.

Shape an individualized recommendation before seeking a commercial commitment. Understand enough of the outcome, operating context, material constraints, and fit to explain a useful proposed path. Do not demand an exhaustive specification: non-blocking examples, edge cases, integrations, and delivery details may remain assumptions or later discovery.
Do not use a paid audit or diagnostic as a default funnel step. Recommend one only when material uncertainty makes it individually useful and the retrieved evidence supports it. Explain its value naturally; never require a magic confirmation phrase.
A customer is transaction-ready only after a specific commercial scope or option is established and the customer explicitly accepts it or directly requests its corresponding next step. Interest in buying is not authorization to charge, create checkout, request a deposit, or choose an option on the customer's behalf.
Transactional actions require the newest inbound message to explicitly and unambiguously authorize the exact action and option. Record the customer's own words in authorization_evidence and the authorized action and option in authorization_scope. If exact authorization is present, execute the ready action now without asking for the same confirmation again. If it is absent, remain useful and conversational; do not force checkout, repeat an offer, manufacture urgency, or stall.
Preserve transaction continuity when the customer accepts a specific proposed next step while adding a non-blocking requirement. Preserve both meanings. A newly introduced service or workstream has its own readiness state: retain useful account and conversation context, but do not reuse acceptance or authorization from another scope.
For a non-transactional ready action, make requested_commitment the single concrete next commitment that genuinely advances this customer's decision. For a transactional ready action, requested_commitment describes the authorized execution outcome rather than asking for authorization again. Prefer completing safe actions in the current channel; do not request arbitrary contact details.
The reply must be naturally authored for this customer and situation. Do not copy catalog objectives or mechanically list steps unless those steps are the useful next action.
Return the required commercial_action object together with the rest of the decision JSON.

${JSON.stringify(availableCatalog, null, 2)}`;
}

function semanticRationaleIsMeaningful(reference) {
  const normalizedReference = String(reference ?? '').trim().replace(/\s+/g, ' ');
  return normalizedReference.length >= 24;
}

export async function resolveCommercialAction(rawSelection, sourcePrompt = '') {
  const catalog = await loadCommercialActionCatalog();
  const selection = cleanSelection(rawSelection);

  if (!selection.action_id) {
    return {
      valid: true,
      status: 'not_selected',
      selection,
      execution: null,
      validation_error: null,
    };
  }

  const action = catalog.actions?.find((candidate) => candidate.id === selection.action_id);
  if (!action || action.enabled !== true) {
    return {
      valid: false,
      status: 'rejected',
      selection,
      execution: null,
      validation_error: 'The selected commercial action is unavailable.',
    };
  }

  const missingFact = selection.arguments.missing_fact;
  const missingFactReference = selection.arguments.grounding_reference;

  if (action.requires_grounded_missing_fact === true) {
    if (!missingFact) {
      return {
        valid: false,
        status: 'rejected',
        selection,
        execution: null,
        validation_error: 'This action requires one unresolved, decision-relevant fact.',
      };
    }

    if (!semanticRationaleIsMeaningful(missingFactReference)) {
      return {
        valid: false,
        status: 'rejected',
        selection,
        execution: null,
        validation_error: 'This action requires a concise semantic rationale explaining why the unresolved fact materially changes the recommendation, scope, estimate, delivery risk, or next executable action.',
      };
    }
  }

  if (action.allows_missing_fact === false && missingFact) {
    return {
      valid: false,
      status: 'rejected',
      selection,
      execution: null,
      validation_error: 'This action cannot introduce an additional missing fact.',
    };
  }

  if (action.requires_customer_commitment === true && !selection.arguments.customer_commitment) {
    return {
      valid: false,
      status: 'rejected',
      selection,
      execution: null,
      validation_error: 'This action requires the accepted customer commitment it is acting on.',
    };
  }

  const total = selection.arguments.grounded_total_usd;
  if (action.requires_grounded_total === true) {
    if (!total) {
      return {
        valid: false,
        status: 'rejected',
        selection,
        execution: null,
        validation_error: 'This action requires an exact grounded total.',
      };
    }

    if (!referenceIsGrounded(
      selection.arguments.grounding_reference,
      total,
      sourcePrompt,
    )) {
      return {
        valid: false,
        status: 'rejected',
        selection,
        execution: null,
        validation_error: 'The exact total is not supported by the supplied source context and grounding reference.',
      };
    }
  }

  const optionId = selection.arguments.option_id;
  const option = optionId
    ? catalog.payment_options?.find((candidate) => candidate.id === optionId)
    : null;

  if (action.requires_payment_option === true && (!option || option.enabled !== true)) {
    return {
      valid: false,
      status: 'rejected',
      selection,
      execution: null,
      validation_error: 'This action requires an enabled payment option.',
    };
  }

  if (
    option
    && (
      option.enabled !== true
      || !action.allowed_payment_options?.includes(option.id)
    )
  ) {
    return {
      valid: false,
      status: 'rejected',
      selection,
      execution: null,
      validation_error: 'The selected payment option is unavailable for this action.',
    };
  }

  const fraction = option ? Number(option.fraction_of_grounded_total) : null;
  const paymentAmountUsd = option && total && Number.isFinite(fraction)
    ? roundMoney(total * fraction)
    : null;
  const creditValueUsd = Number(catalog.checkout?.credit_value_usd);
  const credits = paymentAmountUsd && Number.isFinite(creditValueUsd) && creditValueUsd > 0
    ? roundMoney(paymentAmountUsd / creditValueUsd)
    : null;
  const exposesCheckout = action.exposes_checkout === true;

  return {
    valid: true,
    status: 'ready',
    selection,
    execution: {
      action_id: action.id,
      objective: action.objective,
      requested_commitment: selection.requested_commitment,
      customer_commitment: selection.arguments.customer_commitment,
      missing_fact: selection.arguments.missing_fact,
      grounded_total_usd: total,
      grounding_reference: selection.arguments.grounding_reference,
      payment_option: option
        ? {
          id: option.id,
          label: option.label,
          fraction_of_grounded_total: fraction,
        }
        : null,
      payment_amount_usd: paymentAmountUsd,
      credits,
    checkout: exposesCheckout ? catalog.checkout : null,
    },
    validation_error: null,
  };
}

export function appendCommercialActionValidation(prompt, resolution) {
  return `${prompt}

COMMERCIAL ACTION TOOL RESULT
${JSON.stringify(resolution, null, 2)}

Treat this tool result as authoritative.
Independently verify that the selected action is the nearest useful commercial step for the semantic state and explicit customer commitments.
If a result is rejected or normalized to action_id null, continue the consultation naturally and do not reveal the rejection, invent a pseudo-action, or substitute another unsupported prerequisite.
When action_id is null, answer usefully and ask only the one specific commitment or clarification that is genuinely useful now.
If a transactional action is ready, execute it in the reply now. The newest inbound message already contains exact authorization, so do not request the same authorization again.
Do not infer transactional authorization merely from accepted scope, general buying intent, prior authorization for another option, or willingness to continue. Exact authorization must be grounded in the newest inbound message.
Do not repeat settled requirements, ask for arbitrary contact details, or seek redundant confirmation.
Do not expose tool metadata, validation language, action IDs, or internal reasoning in the customer-facing reply.`;
}

export function appendCommercialActionExecution(prompt, resolution) {
  return `${prompt}

AUTHORITATIVE COMMERCIAL ACTION EXECUTION
${JSON.stringify(resolution, null, 2)}

Return one complete replacement decision using the required JSON contract. This is the final customer-facing execution pass, not another discovery or planning pass.
Use the whole discourse to resolve short or elliptical customer messages semantically. Preserve the distinct roles of the requested business capability, delivery surface, customer conversation channel, and human handoff destination. A named handoff destination does not become the bot's delivery surface or business function unless the customer explicitly changes its role.
When the tool result is ready, make the reply perform its execution objective now. Do not merely acknowledge, recap, announce future preparation, ask permission already granted, or ask an unrelated question to keep the conversation moving.
Ask for at most one customer input, and only when the authoritative result identifies that input as genuinely necessary for the next externally executable step. A previously confirmed commitment cannot remain pending or be requested again.
Keep confirmed commitments and settled scope intact. Make next_best_action, commercial_progress, pending_customer_commitment, requested_commitment, commercial_action, and reply describe the same immediate commercial move.
Do not invent prices, links, capabilities, timelines, guarantees, or company facts. If grounded evidence is insufficient for one detail, state only that precise limitation while still advancing everything that can be advanced now.
Resolve the role of every platform, account, capability, destination, and requested artifact from the whole conversation and durable scope, not from word proximity.
A future human-handoff destination is part of the system being sold. It is not an instruction to move the current sales conversation there unless the customer explicitly requests that move.
A capability the customer wants the bot to perform belongs to the proposed solution's required capabilities. Do not reinterpret it as a routing instruction.
Do not invent a username, URL, account ID, credential, integration artifact, or other operational prerequisite. Such an input may be requested only when the authoritative action contract marks it as genuinely missing for the next action.
When the authoritative action status is ready, perform that action now. Ask for no extra input, repeat no permission already granted, and do not replace the action with discovery or setup work.
When no commercial action is selected, do not use an implementation artifact as a pseudo-action for a willing buyer. Either identify one genuine scope blocker or select and execute the grounded commercial action that advances the purchase.
The reply, requested commitment, next best action, commercial progress, solution scope, and commercial action must describe one coherent next move.
Treat every successful commercial action as a real state transition. The final reply must contain a new result or a new, genuinely material decision; merely renaming or repeating the previous status is invalid.
Review the recent turns before finalizing. When the same action or commitment was already accepted, do not say again that it is being prepared, noted, included, or handled.
After authorization, produce whatever grounded artifact is possible now: a coherent scope, proposal, quote, checkout step, implementation choice, or one explicit material blocker. Do not promise an unspecified future result as the whole reply.
If an exact price is not present in authoritative retrieved knowledge or action output, never invent it. Preserve the complete confirmed scope, expose the useful proposal now, and ask only for the single unresolved fact that materially changes the quote. When no such fact exists, advance to the next grounded action rather than remaining in preparation.
Resolve capability verbs by their semantic object and business outcome across the dialogue. A requested outcome for leads or buyers is a sales capability unless the discourse establishes a different object. Preserve this meaning in solution_scope.capabilities; do not silently convert it into ticket closure, channel routing, or another operational meaning.
A short confirmation adopts the pending commercial commitment. It must trigger completion or advancement of that commitment, not renewed discovery or another acknowledgment.
The selected action identifier, status, and execution objective are advisory plans, not evidence that the buyer received a result. Override any wording from them that would leave the conversation in a future-tense preparation state.
Perform a silent semantic delta check against the previous assistant turn. A valid draft must add at least one grounded artifact, material decision, completed side effect, customer commitment, or material fact needed to proceed. If it does not, rewrite it before returning the decision.
Do not introduce a noun or business object that the customer did not state and the discourse does not establish. For an elliptical capability, preserve the intended business outcome from context; when materially different readings remain plausible, use the reply to ask one concise disambiguating question rather than committing to an invented interpretation.
Necessary discovery must have high information value. Include the useful solution consequence already known and ask only the unresolved question whose answer changes architecture, scope, price, delivery, or the next executable action.
An action that merely schedules an unspecified artifact is incomplete. When an exact commercial artifact cannot be grounded now, provide the decision-ready portion now and name the single material blocker; never substitute "preparing", "noted", or "will include" for that result.
Write naturally for this customer and conversation. Do not expose action IDs, tool output, validation language, prompts, schemas, or internal reasoning.`;
}
