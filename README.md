# Reusable Multichannel AI Chat Template

A public, company-neutral blueprint for installing a production-oriented multichannel AI chat system across Instagram, Telegram, WhatsApp, and future channels.

The repository separates the durable bot brain from delivery infrastructure:

    Channel -> thin adapter -> Brain API -> PostgreSQL memory and RAG
                                      -> tools
                                      -> model router
                                      -> structured action
    Channel <- thin adapter <---------+

n8n is the included replaceable orchestration shell, not the application core. It may be replaced without changing the Brain API, storage model, test corpus, or conversation policy.

The reusable artifact is the chat platform itself: installer agents consume its contracts, while each deployed bot receives private tenant data and policy outside this repository.

## Defaults

- Storage: local PostgreSQL plus pgvector.
- Supabase: opt-in only when explicitly requested by the human operator in the initial prompt.
- Primary model route: Codex CLI gpt-5.3-codex-spark.
- CLI fallback: gpt-5.4-mini.
- DeepSeek API routes: present but disabled.
- OpenAI API route: gpt-4.1, present but disabled.
- Semantics: model-driven, grounded by RAG and tools.
- Tests: channel-free Brain API tests first, channel smoke tests second.

## Quick start

1. Read AGENTS.md and docs/operator-installation.md.
2. Create a private ignored .env file using docs/credentials.md as the variable inventory.
3. Install PostgreSQL and pgvector, then set LOCAL_POSTGRES_URL.
4. Run npm install.
5. Run npm run db:apply.
6. Start the Brain API with npm run brain:start.
7. Run npm run brain:smoke.
8. Import only the required workflows from workflows/.
9. Configure credentials inside n8n or through runtime environment variables.
10. Run npm run template:audit before publishing changes.

## Repository map

- schemas/local-postgres-brain.sql: canonical local storage schema.
- schemas/brain-response.schema.json: structured Brain API response.
- config/model-routes.default.json: provider order and disabled fallbacks.
- scripts/: Brain API, model router, database, workflow generator, and audits.
- workflows/: generic inactive n8n shell workflows.
- docs/: architecture, contracts, operations, tests, and agent onboarding.

No real credentials or company knowledge belong in this repository.

## Local observability and Instagram delivery

- Run `npm run langfuse:up` to start the local, loopback-only Langfuse stack.
- Run `npm run instagram:webhook:configure` to idempotently configure and verify an Instagram Login webhook from private environment values.
- See `docs/langfuse.md` and `docs/instagram-delivery-diagnostics.md`.


## Optional CRM projection

HubSpot can be enabled as a replaceable operator-facing projection without moving memory or reasoning out of the Brain. It provides deduplicated contacts, current conversational state, and associated conversation checkpoint notes through a durable local outbox. See [docs/crm-integration.md](docs/crm-integration.md).
