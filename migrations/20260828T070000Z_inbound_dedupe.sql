BEGIN;

CREATE SCHEMA IF NOT EXISTS agent;

CREATE TABLE IF NOT EXISTS agent.inbound_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_key text NOT NULL,
  conversation_key text NOT NULL,
  channel text NOT NULL,
  provider_event_id text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  response jsonb,
  error_code text,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT inbound_events_status_check
    CHECK (status IN ('processing', 'completed', 'failed')),
  CONSTRAINT inbound_events_request_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT inbound_events_provider_event_id_size_check
    CHECK (octet_length(provider_event_id) BETWEEN 1 AND 512),
  CONSTRAINT inbound_events_conversation_key_size_check
    CHECK (octet_length(conversation_key) BETWEEN 1 AND 1024),
  CONSTRAINT inbound_events_terminal_state_check
    CHECK (
      (status = 'processing' AND completed_at IS NULL)
      OR (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS inbound_events_provider_identity_uidx
  ON agent.inbound_events (tenant_key, channel, provider_event_id);

CREATE INDEX IF NOT EXISTS inbound_events_conversation_created_idx
  ON agent.inbound_events (tenant_key, conversation_key, created_at DESC);

CREATE INDEX IF NOT EXISTS inbound_events_processing_idx
  ON agent.inbound_events (claimed_at)
  WHERE status = 'processing';

COMMENT ON TABLE agent.inbound_events IS
  'Durable pre-model inbound idempotency claims. Stores hashes and bounded results, never raw prompts.';

COMMIT;
