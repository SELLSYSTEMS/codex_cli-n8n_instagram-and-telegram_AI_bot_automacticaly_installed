import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Owner: Brain maintainers. Classification: public, deterministic regression.
// Authority: decision schema and durable commercial action contract.
// Lifecycle: release gate; retire only with replacement contract coverage.
const root = new URL('../', import.meta.url);
const prompt = await readFile(new URL('prompts/brain-system.md', root), 'utf8');
const tool = await readFile(new URL('scripts/commercial-action-tool.mjs', root), 'utf8');
const schema = JSON.parse(await readFile(new URL('schemas/brain-decision.schema.json', root), 'utf8'));
const action = schema.properties.commercial_action;

assert.equal(action.type, 'object', 'No action must still use the required action object');
assert.ok(action.required.includes('action_id'));
assert.ok(action.properties.action_id.type.includes('null'));
assert.ok(prompt.includes('keep `commercial_action.action_id` null'));
assert.ok(!prompt.includes('keep `commercial_action` null'));
assert.ok(prompt.includes('An existing persisted request may be described truthfully as already recorded'));
assert.ok(tool.includes('A catalog match is not a prerequisite for request_custom_proposal'));
assert.ok(!tool.includes('When no offer matches, keep commercial_action.action_id null'));
assert.ok(tool.includes('do not select a catalog checkout or quote an unmatched offer or amount'));

console.log(JSON.stringify({ ok: true, checks: 9, contract: 'custom_proposal_without_catalog_checkout' }));
