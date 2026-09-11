import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { commercialStructuralViolation } from './model-router.mjs';

const proposalAction = {
  commercial_readiness: 'explicitly_ready',
  scope_sufficiency: 'proposal_ready',
  commercial_action: {
    action_id: 'request_custom_proposal',
    arguments: {
      customer_commitment: 'USD 165 works for me. I accept that audit and want to start now.',
      authorization_is_explicit: true,
      authorization_is_unambiguous: true,
      authorization_evidence: 'USD 165 works for me. I accept that audit and want to start now.',
      authorization_scope: 'Quick Workflow Audit for the customer existing automation at USD 165.',
      missing_fact: null,
    },
  },
  commercial_next_step: {
    action_required: true,
    action_id: 'request_custom_proposal',
  },
};

assert.equal(commercialStructuralViolation(proposalAction), null);

assert.match(
  commercialStructuralViolation({
    ...proposalAction,
    commercial_readiness: 'exploring',
  }),
  /explicit current-turn customer commitment/i,
);

assert.match(
  commercialStructuralViolation({
    ...proposalAction,
    scope_sufficiency: 'insufficient',
  }),
  /explicit readiness cannot remain in insufficient discovery/i,
);

assert.match(
  commercialStructuralViolation({
    ...proposalAction,
    commercial_action: {
      action_id: 'request_custom_proposal',
      arguments: {
        ...proposalAction.commercial_action.arguments,
        authorization_scope: null,
      },
    },
  }),
  /must include bounded customer_commitment and authorization_scope/i,
);

assert.match(
  commercialStructuralViolation({
    ...proposalAction,
    commercial_action: {
      action_id: 'request_custom_proposal',
      arguments: {
        ...proposalAction.commercial_action.arguments,
        authorization_is_unambiguous: false,
      },
    },
  }),
  /explicit and unambiguous authorization booleans/i,
);

const activeCommercialRequests = [{
  action_id: 'request_custom_proposal',
  status: 'requested',
}];

assert.match(
  commercialStructuralViolation(proposalAction, { activeCommercialRequests }),
  /already exists/i,
);

assert.equal(
  commercialStructuralViolation({
    commercial_readiness: 'explicitly_ready',
    scope_sufficiency: 'proposal_ready',
    commercial_action: null,
    commercial_next_step: { action_required: false, action_id: null },
  }, { activeCommercialRequests }),
  null,
);

const [brainPrompt, privatePolicy] = await Promise.all([
  readFile(new URL('../prompts/brain-system.md', import.meta.url), 'utf8'),
  readFile(new URL('../.private/active/knowledge/runtime-consultative-sales-policy.md', import.meta.url), 'utf8'),
]);

assert.match(brainPrompt, /exploratory buying questions/i);
assert.match(brainPrompt, /do not treat them as authorization/i);
assert.match(privatePolicy, /are not authorization to create a proposal request/i);

console.log(JSON.stringify({
  passed: true,
  cases: 10,
  active_lifecycle_reused: true,
  exploratory_interest_rejected: true,
  semantic_contract_checked: true,
}, null, 2));
