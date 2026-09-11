import pg from 'pg';

const { Pool } = pg;

const databaseUrl = process.env.LOCAL_POSTGRES_URL;

if (!databaseUrl) {
  throw new Error('LOCAL_POSTGRES_URL is required');
}

const pool = new Pool({
  ...(databaseUrl ? { connectionString: databaseUrl } : {}),
  application_name: 'multichannel-brain-inbound-store',
  max: 2,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

const TERMINAL_STATUSES = new Set(['completed', 'failed']);
const MAX_RESPONSE_BYTES = Number(process.env.BRAIN_INBOUND_RESULT_MAX_BYTES || 65_536);

export class InboundIdentityConflictError extends Error {
  constructor(message = 'provider event identity was reused with different content') {
    super(message);
    this.name = 'InboundIdentityConflictError';
  }
}

function required(value, name, maxBytes) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  if (maxBytes && Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw new Error(`${name} exceeds ${maxBytes} bytes`);
  }
  return normalized;
}

function normalizedClaim(input) {
  const requestHash = required(input.requestHash, 'requestHash', 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(requestHash)) {
    throw new Error('requestHash must be a lowercase SHA-256 digest');
  }
  return {
    tenantKey: required(input.tenantKey, 'tenantKey', 256),
    conversationKey: required(input.conversationKey, 'conversationKey', 1_024),
    channel: required(input.channel, 'channel', 64).toLowerCase(),
    providerEventId: required(input.providerEventId, 'providerEventId', 512),
    requestHash,
  };
}

function boundedResponse(response) {
  const normalized = response ?? null;
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error(`inbound result exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  return normalized;
}

export async function claimInboundEvent(input) {
  const claim = normalizedClaim(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO agent.inbound_events (
         tenant_key,
         conversation_key,
         channel,
         provider_event_id,
         request_hash
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_key, channel, provider_event_id) DO NOTHING
       RETURNING id, status, response, error_code`,
      [
        claim.tenantKey,
        claim.conversationKey,
        claim.channel,
        claim.providerEventId,
        claim.requestHash,
      ],
    );

    if (inserted.rowCount === 1) {
      await client.query('COMMIT');
      return {
        claimed: true,
        eventId: inserted.rows[0].id,
        status: inserted.rows[0].status,
      };
    }

    const existing = await client.query(
      `SELECT id, request_hash, status, response, error_code
         FROM agent.inbound_events
        WHERE tenant_key = $1
          AND channel = $2
          AND provider_event_id = $3
        FOR SHARE`,
      [claim.tenantKey, claim.channel, claim.providerEventId],
    );
    if (existing.rowCount !== 1) {
      throw new Error('inbound event conflict resolved without an existing row');
    }
    const row = existing.rows[0];
    if (row.request_hash !== claim.requestHash) {
      throw new InboundIdentityConflictError();
    }
    await client.query('COMMIT');
    return {
      claimed: false,
      eventId: row.id,
      status: row.status,
      response: row.response,
      errorCode: row.error_code,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function completeInboundEvent({ eventId, status, response = null, errorCode = null }) {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (!TERMINAL_STATUSES.has(normalizedStatus)) {
    throw new Error('inbound completion status must be completed or failed');
  }
  const normalizedResponse = boundedResponse(response);
  const normalizedError = errorCode ? required(errorCode, 'errorCode', 128) : null;
  const result = await pool.query(
    `UPDATE agent.inbound_events
        SET status = $2,
            response = $3::jsonb,
            error_code = $4,
            completed_at = clock_timestamp(),
            updated_at = clock_timestamp()
      WHERE id = $1
        AND status = 'processing'
      RETURNING id, status, response, error_code`,
    [eventId, normalizedStatus, JSON.stringify(normalizedResponse), normalizedError],
  );

  if (result.rowCount === 1) return result.rows[0];

  const existing = await pool.query(
    `SELECT id, status, response, error_code
       FROM agent.inbound_events
      WHERE id = $1`,
    [eventId],
  );
  if (existing.rowCount !== 1) throw new Error('inbound event does not exist');
  if (existing.rows[0].status !== normalizedStatus) {
    throw new Error(`inbound event is already ${existing.rows[0].status}`);
  }
  return existing.rows[0];
}

export async function closeInboundMemoryStore() {
  await pool.end();
}
