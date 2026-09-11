import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizationEvidenceMatchesLatestInbound,
  canonicalizeGroundingReference,
  groundingReferenceSupportsUsdAmount,
  inferGroundedUsdTotalFromReference,
} from './commercial-action-tool.mjs';

test('short authorization is accepted only when it exactly matches the latest inbound message', () => {
  assert.equal(authorizationEvidenceMatchesLatestInbound('Yes.', 'Yes.'), true);
  assert.equal(authorizationEvidenceMatchesLatestInbound('Okay', 'Okay!'), true);
  assert.equal(authorizationEvidenceMatchesLatestInbound('Yes.', 'Yes, but change the scope.'), false);
  assert.equal(authorizationEvidenceMatchesLatestInbound('Yes.', 'I said yes earlier.'), false);
  assert.equal(authorizationEvidenceMatchesLatestInbound('', 'Yes.'), false);
});

test('grounded total accepts normalized multiline authoritative evidence', () => {
  const sourcePrompt = [
    '# Authoritative commercial terms',
    'Commercial terms:',
    '  Exact total: USD 165',
    '  Deposit: USD 57.75',
    'Payment destination: https://automation.sell.systems',
  ].join('\r\n');
  const reference = [
    'Commercial terms:',
    'Exact total: USD 165',
    'Deposit: USD 57.75',
  ].join('\n');

  assert.equal(inferGroundedUsdTotalFromReference(reference, sourcePrompt), 165);
  assert.equal(groundingReferenceSupportsUsdAmount(reference, 165, sourcePrompt), true);
  assert.equal(groundingReferenceSupportsUsdAmount(reference, 57.75, sourcePrompt), true);
  assert.equal(groundingReferenceSupportsUsdAmount(reference, 999, sourcePrompt), false);
  assert.equal(
    inferGroundedUsdTotalFromReference('Exact total: USD 999', sourcePrompt),
    null,
  );
});

test('canonical grounding replaces a model paraphrase with authoritative source evidence', () => {
  const sourcePrompt = [
    '# Authoritative commercial terms',
    'Exact total: USD 1,256',
    'Deposit: USD 439.60',
  ].join('\n');

  assert.equal(
    canonicalizeGroundingReference(
      'The approved implementation costs $1,256.',
      1256,
      sourcePrompt,
    ),
    'Exact total: USD 1,256',
  );
  assert.equal(
    canonicalizeGroundingReference('Exact total: USD 999', 999, sourcePrompt),
    null,
  );
});
