# Operator installation

## Fast deterministic path

Use this order. Do not skip ahead or rebuild a downstream layer while an earlier gate is failing.

1. Read `AGENTS.md`, `config/source-of-truth.default.json`, `config/data-ownership.default.json`, `config/project-layout.default.json`, and this guide.
2. Record the tenant, channels, tools, and storage choice outside the public repository. Local PostgreSQL with pgvector is the default.
3. Populate the ignored `.env`, apply the canonical schema, and verify the database inventory.
4. Start the Brain API and verify health, ownership, data-boundary, and model-route audits.
5. Pass channel-free memory, RAG, escalation, tool, multilingual, and fallback tests.
6. Generate or import only the selected thin channel adapters.
7. Prove one complete inbound and outbound smoke path for each selected channel.
8. Run `npm run order:audit`, inspect the staged diff, and publish only when every gate passes.

A webhook HTTP 200 proves only receipt. Completion evidence must cover channel receipt, normalization, Brain processing, PostgreSQL persistence, action decision, and outbound delivery. When a gate fails, fix the first failing layer in this order: configuration and secrets, database, Brain API, channel-free tests, channel adapters. Never rewrite later layers to hide an earlier failure.

n8n execution data is operational evidence, not conversational source of truth. The Brain API and canonical `agent.*` database remain authoritative.

## 1. Confirm intent

Record selected channels, tenant key, private knowledge source, required tools, and storage choice. If the operator did not explicitly request Supabase, choose local PostgreSQL.

## 2. Prepare private configuration

Create an ignored .env file. Use docs/credentials.md as the variable inventory. Never place values in workflow exports or documentation.

## 3. Prepare PostgreSQL

Install PostgreSQL and pgvector. Create a dedicated database and least-privilege runtime role. Set LOCAL_POSTGRES_URL and run npm run db:apply.

## 4. Configure models

Review config/model-routes.default.json. Codex CLI routes are enabled by default. API routes are disabled until the operator supplies a credential, approves activation, and runs a controlled provider test.

## 5. Load tenant knowledge

Keep source documents outside this repository. Ingest them with explicit tenant ownership and source identifiers. Re-ingestion must be idempotent.

## 6. Validate the brain

Run health, memory continuity, tenant isolation, RAG grounding, escalation silence/reset, tool authorization, multilingual, adversarial, and provider-fallback tests without any channel.

## 7. Add channels

Import only selected workflows. Configure credentials in n8n, map the account to the tenant, register production webhooks, and run one inbound and outbound smoke test.

## 8. Publish safely

Run npm run template:audit and inspect the staged diff before pushing.


## Optional HubSpot operator projection

After the Brain database is initialized, set the CRM variables in the ignored `.env`, then run:

```bash
npm run db:apply
npm run crm:setup
npm run crm:verify
npm run crm:backfill
```

The adapter is optional. Leave `CRM_SYNC_ENABLED=false` and `CRM_PROVIDER=none` for installations without a CRM. Full behavior and replacement rules are documented in `docs/crm-integration.md`.
