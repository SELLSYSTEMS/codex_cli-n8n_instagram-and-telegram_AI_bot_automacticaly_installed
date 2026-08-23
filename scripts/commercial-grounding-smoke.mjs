#!/usr/bin/env node
import assert from 'node:assert/strict';
import { inferGroundedUsdTotalFromReference } from './commercial-action-tool.mjs';

assert.equal(
  inferGroundedUsdTotalFromReference(
    'Proof-Driven Landing Build: about US$1,256.',
    'Authoritative commercial truth:\nProof-Driven Landing Build: about US$1,256.',
  ),
  1256,
);
assert.equal(
  inferGroundedUsdTotalFromReference(
    'Approved total: USD 1,256.50.',
    'Approved total: USD 1,256.50.',
  ),
  1256.5,
);
assert.equal(
  inferGroundedUsdTotalFromReference(
    'Options: US$1,256 or US$2,000.',
    'Options: US$1,256 or US$2,000.',
  ),
  null,
);
assert.equal(
  inferGroundedUsdTotalFromReference(
    'Proof-Driven Landing Build: US$1,256.',
    'Different trusted evidence: US$1,256.',
  ),
  null,
);
assert.equal(
  inferGroundedUsdTotalFromReference(
    'Proof-Driven Landing Build: 1,256.',
    'Proof-Driven Landing Build: 1,256.',
  ),
  null,
);

console.log(JSON.stringify({
  status: 'passed',
  checks: [
    'trusted-usd-reference-recovery',
    'trusted-usd-prefix-recovery',
    'ambiguous-usd-reference-fails-closed',
    'untrusted-reference-fails-closed',
    'currencyless-reference-fails-closed',
  ],
}));
