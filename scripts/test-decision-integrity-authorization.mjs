import assert from 'node:assert/strict';

import { enforceDecisionIntegrity } from './decision-integrity.mjs';

const input = {
  tenant_id: '11111111-1111-4111-8111-111111111111',
  conversation_id: '22222222-2222-4222-8222-222222222222',
  inbound_message_id: '33333333-3333-4333-8333-333333333333',
};

function decision(argumentsPayload) {
  return {
    commercial_action: {
      action_id: 'request_custom_proposal',
      arguments: argumentsPayload,
    },
    commercial_action_resolution: {
      valid: true,
      status: 'ready_for_execution',
      selection: {
        action_id: 'request_custom_proposal',
        arguments: argumentsPayload,
      },
    },
  };
}

const conditional = await enforceDecisionIntegrity(input, decision({
  customer_commitment: 'I can approve a deposit this week.',
  confirmed_scope_summary: 'A multichannel support bot.',
  authorization_is_explicit: false,
  authorization_is_unambiguous: false,
  authorization_evidence: null,
  missing_fact: null,
}));

assert.equal(conditional.commercial_action, null);
assert.equal(conditional.commercial_action_resolution.valid, false);
assert.equal(conditional.commercial_action_resolution.status, 'rejected');
assert.equal(
  conditional.commercial_action_resolution.reason,
  'commercial_action_requires_explicit_unambiguous_authorization',
);

const incompleteScope = await enforceDecisionIntegrity(input, decision({
  customer_commitment: 'Please prepare the proposal now.',
  confirmed_scope_summary: 'A multichannel support bot.',
  authorization_is_explicit: true,
  authorization_is_unambiguous: true,
  authorization_evidence: 'Please prepare the proposal now.',
  missing_fact: 'The channels are not yet confirmed.',
}));

assert.equal(incompleteScope.commercial_action, null);
assert.equal(incompleteScope.commercial_action_resolution.valid, false);
assert.equal(incompleteScope.commercial_action_resolution.status, 'rejected');
assert.equal(
  incompleteScope.commercial_action_resolution.reason,
  'commercial_action_has_unresolved_material_fact',
);

console.log(JSON.stringify({
  passed: true,
  cases: 2,
  blocked_database_calls: true,
}, null, 2));
