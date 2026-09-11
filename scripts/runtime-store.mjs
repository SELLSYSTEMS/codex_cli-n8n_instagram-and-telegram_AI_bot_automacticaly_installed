import pg from 'pg';

const { Pool } = pg;

let runtimePool;

function pool() {
  if (!runtimePool) {
    const connectionString = process.env.LOCAL_POSTGRES_URL;
    if (!connectionString) throw new Error('LOCAL_POSTGRES_URL is required');
    runtimePool = new Pool({
      connectionString,
      max: Number(process.env.RUNTIME_STORE_POOL_MAX || 2),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'multichannel-brain-runtime-integrity',
    });
  }
  return runtimePool;
}

function boundedText(value, max = 2000) {
  if (value === null || value === undefined) return null;
  return String(value).trim().slice(0, max) || null;
}

function boundedUuidList(value, max = 32) {
  return Array.from(new Set(Array.isArray(value) ? value.filter(Boolean).map(String) : [])).slice(0, max);
}

export async function claimCommercialRequest(input) {
  const idempotencyKey = boundedText(input.idempotencyKey, 300);
  if (!idempotencyKey) throw new Error('Commercial request idempotencyKey is required');
  const result = await pool().query(
    `select * from agent.claim_commercial_request($1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::text,$7::uuid,$8::uuid[],$9::text,$10::jsonb,$11::boolean)`,
    [
      input.tenantId,
      input.conversationId,
      input.action || 'request_custom_proposal',
      boundedText(input.lifecycleKey, 300),
      idempotencyKey,
      boundedText(input.customerCommitment, 1000),
      input.sourceInboundMessageId || null,
      boundedUuidList(input.evidenceIds),
      boundedText(input.confirmedScopeSummary, 2000),
      input.context && typeof input.context === 'object' ? input.context : {},
      Boolean(input.testOnly),
    ],
  );
  return result.rows[0];
}

export async function claimDelivery(input) {
  const idempotencyKey = boundedText(input.idempotencyKey, 300);
  if (!idempotencyKey) throw new Error('Delivery idempotencyKey is required');
  const payload = input.payload && typeof input.payload === 'object'
    ? { ...input.payload }
    : {};
  if (input.externalMessageId) payload.external_message_id = boundedText(input.externalMessageId, 500);
  const result = await pool().query(
    `select * from agent.claim_delivery_event($1::uuid,$2::uuid,$3::text,$4::text,$5::jsonb)`,
    [
      input.tenantId || null,
      input.conversationId || null,
      input.channel,
      idempotencyKey,
      payload,
    ],
  );
  return result.rows[0];
}

export async function completeDelivery(input) {
  const result = await pool().query(
    `select * from agent.complete_delivery_event($1::uuid,$2::text,$3::text,$4::text,$5::text,$6::jsonb)`,
    [
      input.deliveryId,
      input.status,
      input.outcomeCertainty,
      input.providerMessageId || null,
      input.providerStatus || null,
      input.providerResult && typeof input.providerResult === 'object' ? input.providerResult : {},
    ],
  );
  return result.rows[0];
}

export async function closeRuntimeStore() {
  if (!runtimePool) return;
  const current = runtimePool;
  runtimePool = undefined;
  await current.end();
}
