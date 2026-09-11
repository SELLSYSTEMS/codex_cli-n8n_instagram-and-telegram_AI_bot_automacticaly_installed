import assert from 'node:assert/strict';

import {
  commercialStructuralViolation,
  repairReversibleProposalIntegrity,
} from './model-router.mjs';

function baseDecision() {
  return {
    commercial_readiness: 'explicitly_ready',
    scope_sufficiency: 'proposal_ready',
    solution_scope: {
      customer_goal: 'Launch the confirmed customer-support automation scope.',
    },
    commercial_action: {
      selected: false,
      action_id: null,
      selection_reason: null,
      requested_commitment: null,
      arguments: {
        offer_id: null,
        option_id: null,
        grounded_total_usd: null,
        grounding_reference: null,
        missing_fact: null,
        customer_commitment: null,
        authorization_is_explicit: false,
        authorization_is_unambiguous: false,
        authorization_evidence: null,
        authorization_scope: null,
      },
    },
    commercial_next_step: {
      action_required: false,
      action_id: null,
      stage: 'recommend',
      customer_outcome: 'Receive a grounded proposal for the confirmed automation scope.',
      recommended_step: 'Prepare the proposal request.',
      why_now: 'The customer confirmed readiness.',
      customer_commitment: null,
      seller_commitment: 'Prepare the requested proposal.',
      payment_request: {
        percentage: null,
        amount: null,
        currency: null,
        credits: null,
        url: null,
        instructions: null,
      },
      grounding_refs: [],
    },
  };
}

const inbound = 'Yes, proceed with the proposal for this scope.';
const repaired = repairReversibleProposalIntegrity(baseDecision(), {
  latestInboundText: inbound,
});

assert.ok(repaired, 'proposal-ready contradiction must be repairable');
assert.equal(repaired.commercial_action.action_id, 'request_custom_proposal');
assert.equal(repaired.commercial_action.arguments.authorization_is_explicit, true);
assert.equal(repaired.commercial_action.arguments.authorization_is_unambiguous, true);
assert.equal(repaired.commercial_action.arguments.authorization_evidence, inbound);
assert.equal(repaired.commercial_next_step.action_required, true);
assert.equal(repaired.commercial_next_step.action_id, 'request_custom_proposal');
assert.equal(
  commercialStructuralViolation(repaired, { activeCommercialRequests: [] }),
  null,
);

const malformedSelected = baseDecision();
malformedSelected.commercial_action.selected = true;
malformedSelected.commercial_action.action_id = 'request_custom_proposal';
malformedSelected.commercial_action.requested_commitment = 'stale commitment';
malformedSelected.commercial_action.arguments.missing_fact = 'Which exact week?';
malformedSelected.commercial_action.arguments.customer_commitment = 'stale commitment';
malformedSelected.commercial_action.arguments.authorization_evidence = 'stale evidence';
malformedSelected.commercial_action.arguments.authorization_scope = 'stale scope';

const repairedSelected = repairReversibleProposalIntegrity(malformedSelected, {
  latestInboundText: inbound,
});

assert.ok(repairedSelected, 'malformed selected proposal action must be canonicalized');
assert.equal(repairedSelected.commercial_action.arguments.missing_fact, null);
assert.equal(repairedSelected.commercial_action.arguments.customer_commitment, inbound);
assert.equal(repairedSelected.commercial_action.arguments.authorization_evidence, inbound);
assert.equal(
  repairedSelected.commercial_action.arguments.authorization_scope,
  'Launch the confirmed customer-support automation scope.',
);
assert.equal(
  commercialStructuralViolation(repairedSelected, { activeCommercialRequests: [] }),
  null,
);

const differentSelectedAction = baseDecision();
differentSelectedAction.commercial_action.selected = true;
differentSelectedAction.commercial_action.action_id = 'create_payment_link';
assert.equal(
  repairReversibleProposalIntegrity(differentSelectedAction, { latestInboundText: inbound }),
  null,
  'repair must not rewrite a different selected commercial action',
);

assert.equal(
  repairReversibleProposalIntegrity(baseDecision(), { latestInboundText: '' }),
  null,
  'repair must fail closed without exact inbound authorization evidence',
);

assert.equal(
  repairReversibleProposalIntegrity(baseDecision(), {
    latestInboundText: inbound,
    activeCommercialRequests: [{
      action_id: 'request_custom_proposal',
      status: 'requested',
    }],
  }),
  null,
  'repair must not create a second active proposal request',
);

console.log('reversible proposal integrity repair: pass');
