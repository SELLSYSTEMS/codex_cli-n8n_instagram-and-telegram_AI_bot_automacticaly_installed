import assert from 'node:assert/strict';

import { normalizeDurableMemory } from './durable-memory.mjs';
import { commercialStructuralViolation } from './model-router.mjs';

const ready = {
  commercial_readiness: 'explicitly_ready',
  scope_sufficiency: 'proposal_ready',
  commercial_action: { action_id: 'request_custom_proposal' },
  commercial_next_step: {
    action_required: true,
    action_id: 'request_custom_proposal',
  },
};

assert.match(
  commercialStructuralViolation(ready),
  /request_custom_proposal must include bounded customer_commitment/,
);
assert.equal(
  commercialStructuralViolation({
    ...ready,
    commercial_action: { action_id: null },
    commercial_next_step: {
      action_required: false,
      action_id: null,
    },
  }),
  null,
);
assert.equal(
  commercialStructuralViolation({
    commercial_readiness: 'explicitly_ready',
    scope_sufficiency: 'transaction_ready',
    commercial_action: { action_id: null },
    commercial_next_step: {
      action_required: false,
      action_id: null,
    },
  }),
  null,
);
assert.match(
  commercialStructuralViolation({
    commercial_readiness: 'explicitly_ready',
    scope_sufficiency: 'insufficient',
    commercial_action: { action_id: null },
    commercial_next_step: {
      action_required: false,
      action_id: null,
    },
  }),
  /cannot remain in insufficient discovery/,
);
assert.match(
  commercialStructuralViolation({
    commercial_readiness: 'considering',
    scope_sufficiency: 'insufficient',
    commercial_action: { action_id: null },
    commercial_next_step: {
      action_required: true,
      action_id: 'request_custom_proposal',
    },
  }),
  /must match the selected commercial action/,
);

const memory = normalizeDurableMemory({
  commercial_readiness: 'explicitly_ready',
  scope_sufficiency: 'proposal_ready',
});
assert.equal(memory.memory_schema_version, 3);
assert.equal(memory.commercial_readiness, 'explicitly_ready');
assert.equal(memory.scope_sufficiency, 'proposal_ready');

const progressionPromptText = await (await import('node:fs/promises')).readFile(
  new URL('../prompts/brain-system.md', import.meta.url),
  'utf8',
);
const normalizedProgressionPromptText = progressionPromptText.toLowerCase();

for (const requiredProgressionRule of [
  'A detail is material only when proceeding without it would make that action inaccurate, unauthorized, unsafe, or irreversibly wrong.',
  'advance in the same turn by selecting `request_custom_proposal`',
  'Do not repeat the clarification.',
  'use the least irreversible action that preserves momentum',
]) {
  if (!normalizedProgressionPromptText.includes(requiredProgressionRule.toLowerCase())) {
    throw new Error(`Missing conversational progression contract: ${requiredProgressionRule}`);
  }
}

console.log(JSON.stringify({ ok: true, contract: 'commercial-readiness-v1' }));
