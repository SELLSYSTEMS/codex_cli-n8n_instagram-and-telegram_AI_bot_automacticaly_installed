# Operator installation

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
