import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultCatalogPath = path.join(root, 'config', 'commercial-actions.default.json');
const privateCatalogPath = path.join(root, '.private', 'active', 'commercial', 'commercial-actions.json');

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
  const nestedArgs = action.arguments && typeof action.arguments === 'object'
    ? action.arguments
    : {};
  const argumentValue = (key) => {
    const flatValue = action[key];
    if (flatValue !== undefined && flatValue !== null && flatValue !== '') {
      return flatValue;
    }
    return nestedArgs[key];
  };
  const offerId = argumentValue('offer_id');
  const optionId = argumentValue('option_id');
  const total = Number(argumentValue('grounded_total_usd'));
  const groundingReference = argumentValue('grounding_reference');
  const missingFact = argumentValue('missing_fact');
  const customerCommitment = argumentValue('customer_commitment');
  const authorizationIsExplicit = argumentValue('authorization_is_explicit');
  const authorizationIsUnambiguous = argumentValue('authorization_is_unambiguous');
  const authorizationEvidence = argumentValue('authorization_evidence');
  const authorizationScope = argumentValue('authorization_scope');
  const rawActionId = typeof action.action_id === 'string'
    ? action.action_id.trim()
    : '';
  const actionId = rawActionId === 'not_selected' ? null : rawActionId || null;

  return {
    action_id: actionId,
    selection_reason: typeof action.selection_reason === 'string'
      ? action.selection_reason.trim()
      : '',
    requested_commitment: typeof action.requested_commitment === 'string' && action.requested_commitment.trim()
      ? action.requested_commitment.trim()
      : null,
    arguments: {
      offer_id: typeof offerId === 'string' && offerId.trim()
        ? offerId.trim()
        : null,
      option_id: typeof optionId === 'string' && optionId.trim()
        ? optionId.trim()
        : null,
      grounded_total_usd: Number.isFinite(total) && total > 0 ? total : null,
      grounding_reference: typeof groundingReference === 'string' && groundingReference.trim()
        ? groundingReference.trim()
        : null,
      missing_fact: typeof missingFact === 'string' && missingFact.trim()
        ? missingFact.trim()
        : null,
      customer_commitment: typeof customerCommitment === 'string' && customerCommitment.trim()
        ? customerCommitment.trim()
        : null,
      authorization_is_explicit: authorizationIsExplicit === true,
      authorization_is_unambiguous: authorizationIsUnambiguous === true,
      authorization_evidence: typeof authorizationEvidence === 'string' && authorizationEvidence.trim()
        ? authorizationEvidence.trim()
        : null,
      authorization_scope: typeof authorizationScope === 'string' && authorizationScope.trim()
        ? authorizationScope.trim()
        : null,
    },
  };
}
const COMMERCIAL_ACTION_HANDLERS = Object.freeze({
  present_checkout: "present_checkout",
  request_custom_proposal: "persist_custom_proposal_request",
});
const TRANSACTIONAL_COMMERCIAL_ACTIONS = new Set(Object.keys(COMMERCIAL_ACTION_HANDLERS));

export function isOperationalCheckout(catalog) {
  const checkout = catalog?.checkout || {};
  return checkout.provider_configured !== false
    && typeof checkout.provider_name === "string"
    && checkout.provider_name.trim().length > 0
    && typeof checkout.url === "string"
    && checkout.url.trim().length > 0;
}

export function isOperationalPaymentOption(option, catalog) {
  if (!option || option.enabled !== true || !isOperationalCheckout(catalog)) return false;

  const optionId = String(option.id || "");
  const optionFraction = Number(option.fraction_of_grounded_total);

  if (optionId === "deposit") {
    const configuredFraction = Number(catalog?.checkout?.deposit_fraction);
    const hasConfiguredFraction = catalog?.checkout?.deposit_fraction !== undefined
      && catalog?.checkout?.deposit_fraction !== null
      && catalog?.checkout?.deposit_fraction !== "";
    return catalog?.checkout?.deposit_enabled !== false
      && Number.isFinite(optionFraction)
      && optionFraction > 0
      && optionFraction < 1
      && (!hasConfiguredFraction
        || (Number.isFinite(configuredFraction)
          && Math.abs(configuredFraction - optionFraction) < 1e-6));
  }

  if (optionId === "full_payment") {
    return catalog?.checkout?.full_payment_enabled !== false
      && Number.isFinite(optionFraction)
      && Math.abs(optionFraction - 1) < 1e-6;
  }

  return false;
}

export function isExecutableCommercialAction(action, catalog) {
  if (!action || action.enabled !== true) return false;
  const actionId = String(action.action_id || action.id || "");
  if (!TRANSACTIONAL_COMMERCIAL_ACTIONS.has(actionId)) return false;
  if (actionId === "present_checkout") {
    if (!isOperationalCheckout(catalog)) return false;
    if (action.requires_payment_option !== true) return true;
    return Array.isArray(catalog?.payment_options)
      && catalog.payment_options.some((option) => isOperationalPaymentOption(option, catalog));
  }
  return COMMERCIAL_ACTION_HANDLERS[actionId] === "persist_custom_proposal_request";
}

function cleanSelection(...callArguments) {
  return baseCleanSelection(...callArguments);
}


function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function inferGroundedUsdTotalFromReference(reference, sourcePrompt) {
  const evidence = String(reference || '').trim();
  const source = String(sourcePrompt || '');
  if (
    !evidence
    || !source
    || !source.toLocaleLowerCase().includes(evidence.toLocaleLowerCase())
  ) {
    return null;
  }

  const matches = [
    ...evidence.matchAll(
      /(?:US\$|\$)\s*(\d[\d,]*(?:\.\d{1,2})?)(?:\s*USD\b)?|\bUSD\s*(\d[\d,]*(?:\.\d{1,2})?)/gi,
    ),
  ];
  const amounts = matches
    .map((match) => Number(String(match[1] || match[2] || '').replaceAll(',', '')))
    .filter((value) => Number.isFinite(value) && value > 0);
  const uniqueAmounts = [
    ...new Map(amounts.map((amount) => [amount.toFixed(2), roundMoney(amount)])).values(),
  ];

  return uniqueAmounts.length === 1 ? uniqueAmounts[0] : null;
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

function inferGroundingReference(amount, sourcePrompt) {
  const target = Number(amount);
  if (!Number.isFinite(target) || !sourcePrompt) return null;

  const candidates = String(sourcePrompt)
    .split(/\r?\n|\\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return candidates.find((candidate) => (
    /authoritative|commercial[_ -]truth|price|pricing|usd|total|cost/i.test(candidate)
    && referenceIsGrounded(candidate, target, sourcePrompt)
  )) || null;
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
    offers: mergeById(base.offers, override.offers),
    payment_options: mergeById(base.payment_options, override.payment_options),
    actions: mergeById(base.actions, override.actions),
  };
}

export async function appendCommercialActionContext(prompt) {
  const catalog = await loadCommercialActionCatalog();
  const executableActions = Array.isArray(catalog.actions)
    ? catalog.actions.filter((action) => isExecutableCommercialAction(action, catalog))
    : [];
  const operationalPaymentOptions = Array.isArray(catalog.payment_options)
    ? catalog.payment_options.filter((option) => isOperationalPaymentOption(option, catalog))
    : [];
  const operationalOffers = Array.isArray(catalog.offers)
    ? catalog.offers.filter((offer) => (
      offer?.enabled === true
      && String(offer.currency || '').trim().toUpperCase() === 'USD'
      && Number.isFinite(Number(offer.total_usd))
      && Number(offer.total_usd) > 0
    ))
    : [];
  const availableCatalog = {
    version: catalog.version || null,
    checkout: executableActions.length > 0 ? catalog.checkout || null : null,
    offers: operationalOffers,
    payment_options: operationalPaymentOptions,
    actions: executableActions,
  };

  return `${prompt}

EXECUTABLE COMMERCIAL TOOLS
This inventory is an execution contract, not a general price list. An offer is available only when the current requested outcome and material scope match it.
Unmatched offers, amounts, deposits, checkout URLs, and payment terms are invisible to customer-facing prose and cannot be used as examples or benchmarks.
When no offer matches, keep commercial_action.action_id null and continue with a truthful custom-scope next step without mentioning any catalog offer or amount.
Use natural-language reasoning for discovery, qualification, recommendations, objections, summaries, and ordinary next steps. Those are conversation, not tools.
Set commercial_action.action_id to null unless a real side effect listed below must be executed now. A null action must never stall the conversation.
Ask at most one high-information question only when its answer materially changes scope, recommendation, price, or safe execution. Never repeat a resolved question.
The present_checkout tool is allowed only when the active scope, exact USD total, selected payment option, and the customer's explicit authorization in the newest message are grounded in authoritative current context.
Follow the selected action's requires_catalog_offer contract. When it is true, map the scope to one authoritative enabled offer below and set arguments.offer_id. When it is false, offer_id may be null only when arguments.grounded_total_usd is the exact already-agreed USD total and grounding_reference identifies the authoritative amount and scope.
Never infer, round, convert, or invent a price, checkout URL, payment status, customer fact, or authorization. The newest customer message must explicitly authorize the exact scope and payment option; grounding_reference must preserve the evidence used for validation.
The tool owns the payable amount and checkout URL. A checkout URL, deposit amount, or payment instruction is available only through a validated resolved tool result; never copy payment data from retrieved knowledge into prose as a substitute for tool execution.

${JSON.stringify(availableCatalog, null, 2)}`;
}

export function inferUniqueOperationalPaymentOptionId(
  catalog,
  allowedOptionIds = null,
) {
  const allowed = Array.isArray(allowedOptionIds)
    ? new Set(
      allowedOptionIds
        .map((id) => String(id || '').trim())
        .filter(Boolean),
    )
    : null;
  const candidates = Array.isArray(catalog?.payment_options)
    ? catalog.payment_options.filter((option) => {
      const optionId = String(option?.id || '').trim();
      return optionId
        && (!allowed || allowed.has(optionId))
        && isOperationalPaymentOption(option, catalog);
    })
    : [];

  return candidates.length === 1
    ? String(candidates[0].id || '').trim() || null
    : null;
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
  if (selection.action_id === "request_custom_proposal") {
    if (!isExecutableCommercialAction(action, catalog)) {
      return {
        valid: false,
        status: "invalid",
        reason: "commercial_action_not_executable",
        selection,
        execution: null,
      };
    }
    if (action.requires_customer_commitment === true && !selection.arguments?.customer_commitment) {
      return {
        valid: false,
        status: "invalid",
        reason: "missing_customer_commitment",
        selection,
        execution: null,
      };
    }
    return {
      valid: true,
      status: "ready_for_execution",
      reason: null,
      selection: {
        ...selection,
        action_id: action.id,
        seller_owned: true,
      },
      execution: {
        kind: COMMERCIAL_ACTION_HANDLERS[action.id],
        action_id: action.id,
        status: "requested",
        seller_owned: true,
        customer_commitment: selection.arguments?.customer_commitment,
        source_prompt: sourcePrompt || null,
        response_contract: action.response_contract || {},
      },
    };
  }
  if (!isExecutableCommercialAction(action, catalog)) {
    return {
      valid: false,
      status: 'rejected',
      selection,
      execution: null,
      validation_error: 'The selected commercial action is unavailable.',
    };
  }

  if (action.requires_explicit_authorization === true) {
    const args = selection.arguments || {};
    const evidence = String(args.authorization_evidence || '').trim();
    const scope = String(args.authorization_scope || '').trim();
    if (
      args.authorization_is_explicit !== true
      || args.authorization_is_unambiguous !== true
      || !evidence
      || !scope
    ) {
      return {
        valid: false,
        status: 'authorization_required',
        selection,
        execution: null,
        validation_error: 'This transactional action requires explicit, unambiguous customer authorization with evidence and scope.',
      };
    }
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
          validation_error: 'This action requires a concise semantic rationale explaining why no safe, useful, reversible action can proceed and why the unresolved fact makes the next action unsafe, unauthorized, or impossible.',
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

  const offerId = String(selection.arguments.offer_id || '').trim();
  const operationalOffers = (catalog.offers || []).filter((candidate) => (
    candidate.enabled === true
    && String(candidate.currency || '').trim().toUpperCase() === 'USD'
    && Number.isFinite(Number(candidate.total_usd))
    && Number(candidate.total_usd) > 0
  ));
  let selectedOffer = offerId
    ? operationalOffers.find((candidate) => candidate.id === offerId)
    : null;

  // The model may omit an identifier even after selecting the checkout tool.
  // Resolve only an unambiguous operational offer; never guess among offers.
  if (!offerId && action.requires_catalog_offer === true) {
    const groundedTotalUsd = Number(selection.arguments.grounded_total_usd);
    const exactTotalMatches = Number.isFinite(groundedTotalUsd) && groundedTotalUsd > 0
      ? operationalOffers.filter((candidate) => (
        Math.abs(Number(candidate.total_usd) - groundedTotalUsd) < 0.005
      ))
      : [];

    if (exactTotalMatches.length === 1) {
      [selectedOffer] = exactTotalMatches;
    } else if (operationalOffers.length === 1) {
      [selectedOffer] = operationalOffers;
    }
  }

  const offerIsOperational = Boolean(selectedOffer);

  if (action.requires_catalog_offer === true && !offerIsOperational) {
    return {
      valid: false,
      status: 'rejected',
      selection,
      execution: null,
      validation_error: 'This action requires an enabled authoritative USD offer.',
    };
  }

  let total = selection.arguments.grounded_total_usd;
  if (offerIsOperational) {
    total = Number(selectedOffer.total_usd);
    selection.arguments.offer_id = selectedOffer.id;
    selection.arguments.grounded_total_usd = total;
    selection.arguments.grounding_reference = String(
      selectedOffer.grounding_reference
      || `Authoritative offer ${selectedOffer.id}: exact total USD ${total}.`,
    ).trim();
  }
  if (action.requires_grounded_total === true) {
    if (!total) {
      total = inferGroundedUsdTotalFromReference(
        selection.arguments.grounding_reference,
        sourcePrompt,
      );
      if (total) {
        selection.arguments.grounded_total_usd = total;
      }
    }
    if (!total) {
      return {
        valid: false,
        status: 'rejected',
        selection,
        execution: null,
        validation_error: 'This action requires an exact grounded total.',
      };
    }

    selection.arguments.grounding_reference = (
      selection.arguments.grounding_reference
      || inferGroundingReference(total, sourcePrompt)
    );

    if (!offerIsOperational && !referenceIsGrounded(
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

  let optionId = selection.arguments.option_id;
  if (!optionId && action.requires_payment_option === true) {
    optionId = inferUniqueOperationalPaymentOptionId(
      catalog,
      action.allowed_payment_options,
    );
    if (optionId) {
      selection.arguments.option_id = optionId;
    }
  }
  const option = optionId
    ? catalog.payment_options?.find((candidate) => candidate.id === optionId)
    : null;

  if (
    action.requires_payment_option === true
    && (!option || !isOperationalPaymentOption(option, catalog))
  ) {
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
      !isOperationalPaymentOption(option, catalog)
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
  const responseContract =
    action.response_contract && typeof action.response_contract === 'object'
      ? action.response_contract
      : null;
  if (
    responseContract?.commitment_consumed === true
    && responseContract?.customer_input_allowed === false
  ) {
    selection.requested_commitment = null;
  }

  return {
    valid: true,
    status: 'ready',
    selection,
    execution: {
      action_id: action.id,
      objective: action.objective,
      response_contract: responseContract,
      requested_commitment: selection.requested_commitment,
      customer_commitment: selection.arguments.customer_commitment,
      missing_fact: selection.arguments.missing_fact,
      offer: offerIsOperational
        ? {
          id: selectedOffer.id,
          label: selectedOffer.label,
          scope: selectedOffer.scope,
          total_usd: total,
          currency: 'USD',
        }
        : null,
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

Treat this result as authoritative for commercial action selection and transaction facts.
Check action eligibility against grounded conversation evidence. Exact transaction authorization must be present in the newest inbound customer turn; general interest, accepted scope, or authorization for another option is not enough.
If the action is null, rejected, or normalized away, continue the consultation naturally with the nearest useful step. Do not invent a pseudo-action or payment request.
If the action is ready, execute it now and do not ask for the same authorization again.
Ask at most one genuinely material unresolved question. Never repeat settled requirements or request arbitrary contact details.
Do not expose tool metadata, validation language, action IDs, schemas, or internal reasoning.`;
}
export function appendCommercialActionExecution(prompt, resolution) {
  return `${prompt}

AUTHORITATIVE COMMERCIAL ACTION EXECUTION
${JSON.stringify(resolution, null, 2)}

Return one complete replacement decision using the required JSON contract. This is a customer-facing execution pass, not another planning pass.
Copy the validated commercial_action exactly and keep its objective, commitment, amount, currency, option, credits, and checkout data mutually consistent.
Perform the validated objective now. Do not ask again for authorization already grounded in the newest inbound turn.
For present_checkout, give the authenticated action in one compact sequence: open checkout.url, sign in using checkout.sign_in_method, click checkout.funding_control, add the exact credits for payment_amount_usd, and choose one of checkout.payment_methods. Mention checkout.post_payment_process when configured.
Never invent or alter a URL, amount, currency, credit quantity, payment method, or post-payment promise. If no action is validated, provide no checkout or payment instructions.
Ask at most one question only when the response contract permits it and the answer truly blocks the safe next action.
Use the whole conversation. Do not repeat settled questions, narrate implementation, emit an execution artifact, or expose internal metadata.
Write a concise, natural response for this customer and conversation.`;
}
