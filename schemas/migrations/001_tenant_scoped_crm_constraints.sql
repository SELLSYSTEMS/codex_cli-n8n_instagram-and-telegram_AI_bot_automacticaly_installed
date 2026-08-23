DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM agent.crm_contact_links
    WHERE external_contact_id IS NOT NULL
    GROUP BY tenant_id, provider, external_contact_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce tenant-scoped CRM contact uniqueness: duplicate rows exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM agent.crm_sync_outbox
    GROUP BY tenant_id, provider, dedupe_key
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce tenant-scoped CRM outbox uniqueness: duplicate rows exist';
  END IF;
END
$$;

ALTER TABLE agent.crm_contact_links
  DROP CONSTRAINT IF EXISTS crm_contact_links_provider_external_contact_id_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'agent.crm_contact_links'::regclass
      AND conname = 'crm_contact_links_tenant_provider_external_contact_key'
  ) THEN
    ALTER TABLE agent.crm_contact_links
      ADD CONSTRAINT crm_contact_links_tenant_provider_external_contact_key
      UNIQUE (tenant_id, provider, external_contact_id);
  END IF;
END
$$;

DROP INDEX IF EXISTS agent.crm_contact_links_external_idx;

ALTER TABLE agent.crm_sync_outbox
  DROP CONSTRAINT IF EXISTS crm_sync_outbox_provider_dedupe_key_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'agent.crm_sync_outbox'::regclass
      AND conname = 'crm_sync_outbox_tenant_provider_dedupe_key'
  ) THEN
    ALTER TABLE agent.crm_sync_outbox
      ADD CONSTRAINT crm_sync_outbox_tenant_provider_dedupe_key
      UNIQUE (tenant_id, provider, dedupe_key);
  END IF;
END
$$;
