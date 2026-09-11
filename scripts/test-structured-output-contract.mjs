import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertRawDecisionContract,
  buildOpenAIResponseRequest,
} from './model-router.mjs';

test('OpenAI decisions use strict Structured Outputs', () => {
  const request = buildOpenAIResponseRequest({
    model: 'gpt-4.1',
    systemPrompt: 'Return a decision.',
    userPrompt: 'The customer is ready to proceed.',
  });

  assert.equal(request.text?.format?.type, 'json_schema');
  assert.equal(request.text?.format?.name, 'brain_decision');
  assert.equal(request.text?.format?.strict, true);
  assert.ok(request.text?.format?.schema);
  assert.ok(request.text.format.schema.required.includes('commercial_action'));
});

test('incomplete model decisions fail closed before normalization', () => {
  assert.throws(
    () => assertRawDecisionContract({ reply: 'We will prepare a proposal.' }),
    (error) => error?.code === 'model_contract_invalid',
  );
});
