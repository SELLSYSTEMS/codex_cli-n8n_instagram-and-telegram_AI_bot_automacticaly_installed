import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const graphSource = await readFile(new URL('./brain-graph.mjs', import.meta.url), 'utf8');
const systemPrompt = await readFile(new URL('../prompts/brain-system.md', import.meta.url), 'utf8');
const decisionSchema = JSON.parse(
  await readFile(new URL('../schemas/brain-decision.schema.json', import.meta.url), 'utf8'),
);

assert.doesNotMatch(graphSource, /\breply_text\b/, 'runtime prompt must not request reply_text');
assert.doesNotMatch(systemPrompt, /\breply_text\b/, 'shared prompt must not request reply_text');
assert.equal(decisionSchema.properties?.reply?.type, 'string');
assert.ok(decisionSchema.required?.includes('reply'), 'decision schema must require reply');
assert.ok(decisionSchema.required?.includes('action'), 'decision schema must require canonical action');
assert.deepEqual(
  decisionSchema.properties?.action?.enum,
  ['reply', 'silent', 'escalate'],
  'decision schema must define the canonical action enum',
);
assert.ok(decisionSchema.required?.includes('should_escalate'), 'decision schema must require escalation state');

console.log(JSON.stringify({ status: 'passed', contract: 'reply+action' }));
