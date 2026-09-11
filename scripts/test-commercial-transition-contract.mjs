#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  assertCommercialTransitionConsistency,
  reconcileCommercialTransition,
} from './model-router.mjs';

assert.doesNotThrow(() => assertCommercialTransitionConsistency({
  commercial_next_step: { action_required: false, action_id: null },
  commercial_action: null,
}));
assert.doesNotThrow(() => assertCommercialTransitionConsistency({
  commercial_next_step: { action_required: true, action_id: 'request_custom_proposal' },
    commercial_action: { action_id: 'request_custom_proposal' },
}));
assert.throws(() => assertCommercialTransitionConsistency({
  commercial_next_step: { action_required: true, action_id: 'request_custom_proposal' },
  commercial_action: null,
}), (error) => error?.code === 'model_contract_invalid');
assert.throws(() => assertCommercialTransitionConsistency({
  commercial_next_step: { action_required: false, action_id: null },
    commercial_action: { action_id: 'request_custom_proposal' },
}), (error) => error?.code === 'model_contract_invalid');

assert.deepEqual(reconcileCommercialTransition({
  commercial_next_step: { action_required: true, action_id: 'request_custom_proposal' },
  commercial_action: null,
}), {
  commercial_next_step: { action_required: false, action_id: null },
  commercial_action: null,
});

assert.deepEqual(reconcileCommercialTransition({
  commercial_next_step: { action_required: false, action_id: null },
      commercial_action: { action_id: 'request_custom_proposal' },
}), {
  commercial_next_step: { action_required: true, action_id: 'request_custom_proposal' },
    commercial_action: { action_id: 'request_custom_proposal' },
});

console.log('commercial transition consistency: 6/6 pass');
