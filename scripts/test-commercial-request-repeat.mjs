import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { pool } from './db.mjs';

const client = await pool.connect();
let transactionOpen = false;

try {
  await client.query('begin');
  transactionOpen = true;

  const suffix = randomUUID().replaceAll('-', '');
  const tenantKey = `internal_test_repeat_${suffix}`;
  const externalThreadId = `scenario_test_${suffix}`;

  const tenantResult = await client.query(
    `insert into agent.tenants (tenant_key, display_name, config)
     values ($1, $2, $3::jsonb)
     returning id`,
    [tenantKey, 'Commercial idempotency test', JSON.stringify({ synthetic: true })],
  );
  const tenantId = tenantResult.rows[0].id;

  const contactResult = await client.query(
    `insert into agent.contacts (tenant_id, display_name, profile)
     values ($1::uuid, $2, $3::jsonb)
     returning id`,
    [tenantId, 'Synthetic buyer', JSON.stringify({ synthetic: true })],
  );
  const contactId = contactResult.rows[0].id;

  const conversationResult = await client.query(
    `insert into agent.conversations (
       tenant_id,
       contact_id,
       channel,
       external_thread_id,
       metadata
     ) values ($1::uuid, $2::uuid, $3, $4, $5::jsonb)
     returning id`,
    [
      tenantId,
      contactId,
      'internal-test',
      externalThreadId,
      JSON.stringify({ synthetic: true, environment: 'internal-test' }),
    ],
  );
  const conversationId = conversationResult.rows[0].id;

  const messageResult = await client.query(
    `insert into agent.messages (
       tenant_id,
       conversation_id,
       contact_id,
       channel,
       direction,
       role,
       external_message_id,
       content,
       payload
     ) values (
       $1::uuid,
       $2::uuid,
       $3::uuid,
       $4,
       'inbound',
       'user',
       $5,
       $6,
       $7::jsonb
     )
     returning id`,
    [
      tenantId,
      conversationId,
      contactId,
      'internal-test',
      `repeat-${suffix}`,
      'I confirm the agreed scope and want the proposal now.',
      JSON.stringify({ synthetic: true }),
    ],
  );
  const sourceMessageId = messageResult.rows[0].id;

  const actionId = 'request_custom_proposal';
  const lifecycleKey = 'active_custom_proposal';
  const idempotencyKey = `proposal:${conversationId}:${lifecycleKey}`;
  const attempts = [];

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await client.query(
      `select request_id, request_status, created
       from agent.claim_commercial_request(
         $1::uuid,
         $2::uuid,
         $3::text,
         $4::text,
         $5::text,
         $6::text,
         $7::uuid,
         $8::uuid[],
         $9::text,
         $10::jsonb,
         $11::boolean
       )`,
      [
        tenantId,
        conversationId,
        actionId,
        lifecycleKey,
        idempotencyKey,
        'Customer explicitly requested the agreed custom proposal.',
        sourceMessageId,
        [sourceMessageId],
        'Confirmed synthetic scope for an isolated idempotency test.',
        JSON.stringify({
          synthetic: true,
          environment: 'internal-test',
          attempt: attempt + 1,
        }),
        true,
      ],
    );
    assert.equal(result.rowCount, 1);
    attempts.push(result.rows[0]);
  }

  const requestIds = new Set(attempts.map((attempt) => attempt.request_id));
  assert.equal(requestIds.size, 1, 'all repeats must reuse one request');
  assert.equal(
    attempts.filter((attempt) => attempt.created === true).length,
    1,
    'exactly one attempt must create the request',
  );

  const countResult = await client.query(
    `select count(*)::integer as request_count
     from agent.commercial_requests
     where tenant_id = $1::uuid
       and conversation_id = $2::uuid
       and action_id = $3
       and lifecycle_key = $4
       and status in ('requested', 'pending', 'open')`,
    [tenantId, conversationId, actionId, lifecycleKey],
  );
  assert.equal(
    countResult.rows[0].request_count,
    1,
    'five readiness repeats must leave exactly one active request',
  );

  await client.query('rollback');
  transactionOpen = false;

  console.log(JSON.stringify({
    ok: true,
    attempts: attempts.length,
    unique_requests: requestIds.size,
    created_attempts: attempts.filter((attempt) => attempt.created === true).length,
    persisted_active_rows_before_rollback: countResult.rows[0].request_count,
    production_rows_written: 0,
  }));
} catch (error) {
  if (transactionOpen) {
    await client.query('rollback');
  }
  throw error;
} finally {
  client.release();
  await pool.end();
}
