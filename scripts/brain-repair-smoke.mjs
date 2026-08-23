import assert from 'node:assert/strict';
import {
  appendConversationEvidence,
  deriveSemanticState,
} from './semantic-state.mjs';
import {
  hasSubstantiveReply,
  validateDecisionContract,
} from './model-router.mjs';
import { runtimeScoreDefinitions } from './langfuse-api.mjs';

assert.equal(hasSubstantiveReply('...'), false);
assert.equal(hasSubstantiveReply('?!'), false);
assert.equal(hasSubstantiveReply('I can help you choose the next step.'), true);
assert.throws(
  () => validateDecisionContract({ should_reply: true, reply: '...' }),
  /substantive reply/,
);

const initial = deriveSemanticState({
  conversation_summary: 'Customer wants a Shopify sales and support bot.',
  confirmed_commitments: ['Shopify store'],
  solution_scope: {
    channels: ['website'],
    timeline: 'one month',
  },
});

const firstEvidence = appendConversationEvidence(initial, {
  userText: 'We need website support and sales in one month.',
  assistantReply: 'Understood. What daily volume do you expect?',
  decision: initial,
});
assert.equal(firstEvidence.length, 1);

const accumulated = deriveSemanticState({
  confirmed_commitments: ['35% deposit approved'],
  solution_scope: {
    payment: '35% deposit',
  },
}, {
  ...initial,
  recent_evidence: firstEvidence,
});

assert.deepEqual(accumulated.solution_scope.channels, ['website']);
assert.equal(accumulated.solution_scope.timeline, 'one month');
assert.equal(accumulated.solution_scope.payment, '35% deposit');
assert.deepEqual(
  accumulated.confirmed_commitments,
  ['Shopify store', '35% deposit approved'],
);

const secondEvidence = appendConversationEvidence(accumulated, {
  userText: 'Yes, proceed with the deposit.',
  assistantReply: 'I will prepare the payment step.',
  decision: accumulated,
});
assert.equal(secondEvidence.length, 2);
assert.equal(secondEvidence[0].user, 'We need website support and sales in one month.');
assert.equal(secondEvidence[1].user, 'Yes, proceed with the deposit.');

let evidence = secondEvidence;
for (let index = 0; index < 15; index += 1) {
  evidence = appendConversationEvidence({ recent_evidence: evidence }, {
    userText: `Message ${index}`,
    assistantReply: `Reply ${index}`,
  });
}
assert.equal(evidence.length, 12);
assert.equal(evidence.at(-1).user, 'Message 14');

const authoritativeNestedState = deriveSemanticState({
  next_best_action: 'ask another discovery question',
  open_questions: ['booking mechanism'],
  material_blocker: 'booking mechanism',
  semantic_state: {
    next_best_action: 'request approved deposit',
    open_questions: [],
    material_blocker: null,
    commitment_level: 'payment_authorized',
  },
}, {});
assert.equal(authoritativeNestedState.next_best_action, 'request approved deposit');
assert.deepEqual(authoritativeNestedState.open_questions, []);
assert.equal(authoritativeNestedState.material_blocker, null);

const unauditedCommercialScores = Object.fromEntries(
  runtimeScoreDefinitions({
    decision: { commercial_action: null },
    commercial_action: null,
    semantic_conformance: { performed: false, passed: true },
  }).map(({ name, value }) => [name, value]),
);
assert.equal(unauditedCommercialScores.commercial_action_valid, 0);

const dispatchedCommercialScores = Object.fromEntries(
  runtimeScoreDefinitions({
    decision: { commercial_action: { action_id: 'request_deposit' } },
    commercial_action: {
      valid: true,
      selection: { action_id: 'request_deposit' },
    },
    semantic_conformance: { performed: true, passed: true },
  }).map(({ name, value }) => [name, value]),
);
assert.equal(dispatchedCommercialScores.commercial_action_valid, 1);

process.stdout.write(`${JSON.stringify({
  status: 'passed',
  checks: [
    'substantive-reply-gate',
    'semantic-fact-preservation',
    'recent-evidence-accumulation',
    'bounded-evidence-history',
    'nested-semantic-state-authority',
    'commercial-score-requires-semantic-audit-or-dispatch',
  ],
})}\n`);
