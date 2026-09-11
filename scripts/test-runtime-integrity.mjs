import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { RuntimeCoordinator, RuntimeOverloadError } from './runtime-coordinator.mjs';
import { decodeRawWebhook, parseVerifiedJson, verifyMetaWebhook, verifyTelegramSecret } from './channel-integrity.mjs';
import { durableMemoryBytes, normalizeDurableMemory } from './durable-memory.mjs';

const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));
const secret = 'test-app-secret';
const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
assert.equal(verifyMetaWebhook({ rawBody: raw, signature, appSecrets: [secret] }), true);
assert.equal(verifyMetaWebhook({ rawBody: raw, signature: signature.replace(/.$/, '0'), appSecrets: [secret] }), false);
assert.deepEqual(parseVerifiedJson(decodeRawWebhook(raw.toString('base64'))), JSON.parse(raw.toString()));
assert.equal(verifyTelegramSecret({ supplied: 'secret-token', expected: 'secret-token' }), true);
assert.equal(verifyTelegramSecret({ supplied: 'wrong', expected: 'secret-token' }), false);

const memory = normalizeDurableMemory({
  objective: 'Build a support bot',
  workstreams: Array.from({ length: 30 }, (_, index) => `workstream-${index}`),
  contact_profile: { name: 'Test Person', phone: '+10000000000' },
  source_prompt: 'must not survive',
  retrieved_documents: ['must not survive'],
});
assert.equal(memory.memory_schema_version, 3);
assert.equal(memory.active_workstreams.length, 8);
assert.equal(Object.hasOwn(memory, 'source_prompt'), false);
assert.equal(Object.hasOwn(memory, 'retrieved_documents'), false);
assert.ok(durableMemoryBytes(memory) < 8_000);

const coordinator = new RuntimeCoordinator({ concurrency: 2, maxQueue: 2, defaultDeadlineMs: 2_000 });
const events = [];
const deadlineContexts = [];
const task = (name, wait = 15) => async ({ deadlineAt } = {}) => {
  deadlineContexts.push(deadlineAt);
  events.push(`start:${name}`);
  await new Promise((resolve) => setTimeout(resolve, wait));
  events.push(`end:${name}`);
  return name;
};
const first = coordinator.run({ conversationKey: 'a', dedupeKey: 'a:1' }, task('a1'));
const duplicate = coordinator.run({ conversationKey: 'a', dedupeKey: 'a:1' }, task('duplicate'));
const second = coordinator.run({ conversationKey: 'a', dedupeKey: 'a:2' }, task('a2'));
const parallel = coordinator.run({ conversationKey: 'b', dedupeKey: 'b:1' }, task('b1'));
assert.equal(await first, 'a1');
assert.equal(await duplicate, 'a1');
assert.deepEqual(await Promise.all([second, parallel]), ['a2', 'b1']);
assert.ok(events.indexOf('start:a2') > events.indexOf('end:a1'));
assert.equal(events.includes('start:duplicate'), false);
assert.equal(coordinator.snapshot().deduplicated, 1);
assert.ok(deadlineContexts.length >= 3);
assert.equal(deadlineContexts.every((deadlineAt) => Number.isFinite(deadlineAt)), true);

const saturated = new RuntimeCoordinator({ concurrency: 1, maxQueue: 1 });
const hold = saturated.run({ conversationKey: 'a' }, task('hold', 40));
const queued = saturated.run({ conversationKey: 'a' }, task('queued', 5));
await assert.rejects(() => saturated.run({ conversationKey: 'b' }, task('rejected')), RuntimeOverloadError);
await Promise.all([hold, queued]);

console.log(JSON.stringify({ ok: true, checks: ['meta_signature', 'telegram_secret', 'bounded_memory', 'queue_order', 'inflight_dedupe', 'deadline_context', 'overload'] }));
