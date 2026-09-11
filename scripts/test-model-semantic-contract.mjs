import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./model-router.mjs', import.meta.url), 'utf8');

assert.match(
  source,
  /including the reversible durable internal request_custom_proposal action/,
  'The model contract must classify proposal creation as a reversible internal action.',
);
assert.match(
  source,
  /Optional delivery and implementation details may remain open/,
  'Optional implementation details must not block a proposal request.',
);
assert.match(
  source,
  /Payment or any other external mutation requires explicit and unambiguous authorization/,
  'External mutations must retain strict authorization requirements.',
);
assert.doesNotMatch(
  source,
  /Generic assent or readiness does not fill omitted material scope/,
  'The obsolete rule that caused repeated discovery must be absent.',
);

console.log(JSON.stringify({
  ok: true,
  proposal_action_is_reversible_internal: true,
  optional_details_do_not_block_proposal: true,
  external_mutations_remain_strict: true,
}, null, 2));
