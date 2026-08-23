import assert from 'node:assert/strict';

import { releaseTextOnlyAfterConformanceFailure } from './model-router.mjs';

const error = new Error('forced semantic conformance failure');
error.code = 'SEMANTIC_CONFORMANCE_FAILED';
error.failures = ['commercial_action_contract: select no action'];

const released = releaseTextOnlyAfterConformanceFailure(
  {
    reply: 'Thanks. I have the scope and can move this forward.',
    decision: {
      action: 'reply',
      should_reply: true,
      commercial_action: {
        action_id: 'request_payment',
        idempotency_key: 'unsafe-test-action',
      },
    },
    commercialAction: {
      valid: true,
      status: 'ready',
      selection: {
        action_id: 'request_payment',
        idempotency_key: 'unsafe-test-action',
      },
    },
    failures: [],
    model: 'deterministic-test-model',
    provider: 'test',
  },
  error,
  {
    correctionPerformed: true,
    correctionRounds: 3,
    attempts: 4,
    modelCalls: 7,
  },
);

assert.equal(
  released.reply,
  'Thanks. I have the scope and can move this forward.',
);
assert.equal(released.decision.action, 'reply');
assert.equal(released.decision.should_reply, true);
assert.equal(released.decision.commercial_action, null);
assert.equal(released.commercialAction, null);
assert.equal(
  released.semanticConformance.releaseMode,
  'text_only_fail_safe',
);
assert.equal(released.semanticConformance.actionsBlocked, true);
assert.equal(released.semanticConformance.passed, false);
assert.match(
  released.failures.join('\n'),
  /semantic_conformance_text_only_fail_safe:SEMANTIC_CONFORMANCE_FAILED/,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      replyPreserved: released.reply,
      actionsBlocked: released.semanticConformance.actionsBlocked,
      releaseMode: released.semanticConformance.releaseMode,
    },
    null,
    2,
  ),
);
