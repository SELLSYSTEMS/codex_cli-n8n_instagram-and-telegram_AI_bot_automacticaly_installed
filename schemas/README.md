# Database schema contract

## Canonical schema

`local-postgres-brain.sql` is the public, idempotent bootstrap for the default local PostgreSQL plus pgvector profile. Runtime tables belong to the `agent` schema.

The expected canonical tables are:

- `contacts`
- `commercial_requests`
- `conversations`
- `crm_contact_links`
- `crm_sync_outbox`
- `delivery_events`
- `identities`
- `knowledge_chunks`
- `knowledge_documents`
- `messages`
- `model_runs`
- `tenants`

## Rules

- Do not add new `public.bot_*` objects.
- Do not make n8n workflows query application tables directly.
- Keep vectors in PostgreSQL/pgvector unless an installation explicitly selects Supabase.
- Keep bootstrap SQL idempotent.
- Treat destructive migrations as separate, operator-approved maintenance work with backup and rollback instructions.
- Update `scripts/inventory-database-layout.mjs` whenever the canonical table contract changes.

## Commands

`npm run database:inventory` produces a read-only JSON inventory.

`npm run database:audit` additionally fails when canonical tables are missing or legacy `public.bot_*` objects remain.

Neither command changes the database.
## Migration discipline

`local-postgres-brain.sql` is the idempotent bootstrap for a new local PostgreSQL installation. Existing installations are upgraded by the ordered SQL files in `schemas/migrations/`.

- Name migrations with a contiguous three-digit prefix, for example `001_tenant_scoped_crm_constraints.sql`.
- Keep every migration idempotent because the installer safely reapplies the ordered set.
- Do not include `BEGIN` or `COMMIT`; the installer owns each migration transaction and a process-wide advisory lock.
- Update the bootstrap schema and add a migration in the same change whenever an existing installation must converge to the new structure.
- Run `node scripts/apply-local-postgres-schema.mjs`, then `npm run database:audit` and `npm run hygiene:audit`.
