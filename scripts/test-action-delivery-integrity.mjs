import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  beginTurn,
  closeDatabase,
  pool,
} from './db.mjs';
import {
  claimCommercialRequest,
  claimDelivery,
  closeRuntimeStore,
  completeDelivery,
} from './runtime-store.mjs';

function value(row, ...keys) {
  for (const key of keys) {
    if (row?.[key] !== undefined) return row[key];
  }
  return undefined;
}

test('commercial requests and outbound delivery are claimed exactly once', async (t) => {
  const runId = randomUUID();
  const tenantKey = 'internal-test-runtime-integrity';
  const channel = 'internal-test';
  const lifecycleKey = `proposal-${runId}`;
  const commercialIdempotencyKey = `commercial-${runId}`;
  const deliveryIdempotencyKey = `delivery-${runId}`;
  const createdRequestIds = new Set();
  const createdDeliveryIds = new Set();

  t.after(async () => {
    if (createdDeliveryIds.size > 0) {
      await pool.query(
        'delete from agent.delivery_events where id = any($1::uuid[])',
        [[...createdDeliveryIds]],
      );
    }
    if (createdRequestIds.size > 0) {
      await pool.query(
        'delete from agent.commercial_requests where id = any($1::uuid[])',
        [[...createdRequestIds]],
      );
    }
    await closeRuntimeStore();
    await closeDatabase();
  });

  const turn = await beginTurn({
    tenantKey,
    channel,
    externalUserId: 'action-delivery-integrity-user',
    externalThreadId: 'action-delivery-integrity-thread',
    externalMessageId: `action-delivery-integrity-${runId}`,
    text: 'Synthetic internal integrity check. No external delivery.',
    metadata: {
      synthetic: true,
      environment: 'internal-test',
      test_run_id: runId,
    },
  });

  assert.equal(turn.duplicate, false);
  const tenantId = turn.tenant.id;
  const conversationId = turn.conversation.id;
  const sourceInboundMessageId = turn.inboundMessage.id;
  const evidenceIds = [sourceInboundMessageId];

  const commercialInput = {
    tenantId,
    conversationId,
    action: 'request_custom_proposal',
    lifecycleKey,
    idempotencyKey: commercialIdempotencyKey,
    customerCommitment: 'Customer explicitly requested a proposal.',
    sourceInboundMessageId,
    evidenceIds,
    confirmedScopeSummary: 'Bounded synthetic proposal scope for integrity testing.',
    context: {
      objective: 'Verify atomic commercial request persistence.',
      synthetic: true,
      test_run_id: runId,
    },
    testOnly: true,
  };

  const commercialClaims = await Promise.all(
    Array.from({ length: 5 }, () => claimCommercialRequest(commercialInput)),
  );
  for (const claim of commercialClaims) {
    createdRequestIds.add(value(claim, 'requestId', 'request_id'));
  }

  assert.equal(createdRequestIds.size, 1, 'all commercial claims must reuse one row');
  assert.equal(
    commercialClaims.filter((claim) => value(claim, 'created') === true).length,
    1,
    'exactly one commercial claim may report creation',
  );

  const repeatedCommercialClaim = await claimCommercialRequest(commercialInput);
  assert.equal(
    value(repeatedCommercialClaim, 'requestId', 'request_id'),
    [...createdRequestIds][0],
  );
  assert.equal(value(repeatedCommercialClaim, 'created'), false);

  const commercialRows = await pool.query(
    `select id, action_id, status, customer_commitment, source_inbound_message_id,
            evidence_ids, confirmed_scope_summary, lifecycle_key, idempotency_key,
            test_only, context
       from agent.commercial_requests
      where tenant_id = $1 and conversation_id = $2 and lifecycle_key = $3`,
    [tenantId, conversationId, lifecycleKey],
  );

  assert.equal(commercialRows.rowCount, 1);
  const commercialRow = commercialRows.rows[0];
  assert.equal(commercialRow.action_id, 'request_custom_proposal');
  assert.equal(commercialRow.status, 'requested');
  assert.equal(commercialRow.source_inbound_message_id, sourceInboundMessageId);
  assert.deepEqual(commercialRow.evidence_ids, evidenceIds);
  assert.equal(commercialRow.lifecycle_key, lifecycleKey);
  assert.equal(commercialRow.idempotency_key, commercialIdempotencyKey);
  assert.equal(commercialRow.test_only, true);
  assert.equal(commercialRow.context.synthetic, true);
  assert.ok(commercialRow.customer_commitment.length <= 1_000);
  assert.ok(commercialRow.confirmed_scope_summary.length <= 2_000);

  const deliveryInput = {
    tenantId,
    conversationId,
    channel,
    idempotencyKey: deliveryIdempotencyKey,
    externalMessageId: `synthetic-outbound-${runId}`,
    payload: {
      synthetic: true,
      test_run_id: runId,
      destination: 'mock-provider-only',
    },
  };

  const deliveryClaims = await Promise.all(
    Array.from({ length: 5 }, () => claimDelivery(deliveryInput)),
  );
  for (const claim of deliveryClaims) {
    createdDeliveryIds.add(value(claim, 'deliveryId', 'delivery_id'));
  }

  assert.equal(createdDeliveryIds.size, 1, 'all delivery claims must reuse one row');
  assert.equal(
    deliveryClaims.filter((claim) => value(claim, 'shouldSend', 'should_send') === true).length,
    1,
    'exactly one claimant may call the provider',
  );

  const deliveryId = [...createdDeliveryIds][0];
  const completedDelivery = await completeDelivery({
    deliveryId,
    status: 'sent',
    outcomeCertainty: 'confirmed_sent',
    providerMessageId: `mock-provider-${runId}`,
    providerResult: {
      synthetic: true,
      accepted: true,
    },
  });
  assert.equal(value(completedDelivery, 'status'), 'sent');
  assert.equal(
    value(completedDelivery, 'outcomeCertainty', 'outcome_certainty'),
    'confirmed_sent',
  );

  const replayedDeliveryClaim = await claimDelivery(deliveryInput);
  assert.equal(value(replayedDeliveryClaim, 'deliveryId', 'delivery_id'), deliveryId);
  assert.equal(value(replayedDeliveryClaim, 'shouldSend', 'should_send'), false);
  assert.equal(value(replayedDeliveryClaim, 'deliveryStatus', 'delivery_status'), 'sent');

  const deliveryRows = await pool.query(
    `select id, status, outcome_certainty, provider_message_id, payload
       from agent.delivery_events
      where tenant_id = $1 and channel = $2 and idempotency_key = $3`,
    [tenantId, channel, deliveryIdempotencyKey],
  );

  assert.equal(deliveryRows.rowCount, 1);
  assert.equal(deliveryRows.rows[0].id, deliveryId);
  assert.equal(deliveryRows.rows[0].status, 'sent');
  assert.equal(deliveryRows.rows[0].outcome_certainty, 'confirmed_sent');
  assert.equal(deliveryRows.rows[0].provider_message_id, `mock-provider-${runId}`);
  assert.equal(deliveryRows.rows[0].payload.provider_result.accepted, true);
});
