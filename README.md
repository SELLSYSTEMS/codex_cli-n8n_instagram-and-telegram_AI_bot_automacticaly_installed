# Reusable Multichannel AI Chat Template

A public, company-neutral installation template for production-oriented conversational AI across Instagram, Telegram, WhatsApp, web chat, and future channels.

The reusable product is the chatbot platform, not one company's bot. Installer agents use this repository to create a private deployment; each company supplies its own credentials, knowledge, policies, tools, and conversation data outside version control.

## Architecture

```text
Channel -> thin adapter -> Brain API -> PostgreSQL memory and RAG
                                     -> business tools
                                     -> model router
                                     -> structured actions
Channel <- thin adapter <------------+
```

The Brain API is the source of conversational behavior. n8n is an included, replaceable channel and operations shell; replacing n8n must not require replacing memory, RAG, model routing, tests, or conversation policy.

Architectural invariants:

- Use local PostgreSQL with pgvector by default.
- Use Supabase only when the human operator explicitly requests it in the initial installation prompt.
- Keep channel adapters thin and free of tenant-specific sales logic.
- Let the language model reason about language, intent, objections, sales progression, and escalation semantically.
- Do not replace model reasoning with brittle keyword trees or hard-coded dialogue branches.
- Keep authentication, schema checks, idempotency, rate limits, delivery checks, and action dispatch deterministic.
- Keep company knowledge, prompts, runtime overrides, credentials, and customer data private.

## Included capabilities

- A channel-neutral Brain API and structured response contract.
- Durable conversation memory, semantic retrieval, escalation state, and reset behavior.
- Local PostgreSQL and pgvector schema with tenant and conversation isolation.
- Configurable model routing with explicit provider priority and fallback behavior.
- Generic n8n shell workflows and deterministic workflow generation/deployment scripts.
- Channel-free smoke, scenario, consultative-sales, language, routing, and evaluation tests.
- Optional Langfuse observability and replaceable CRM projection.
- Documentation for installation, operations, ownership, testing, and agent handoff.

## Shipped defaults

- Storage: local PostgreSQL plus pgvector.
- Supabase: disabled unless explicitly selected by the operator.
- Primary model route: Codex CLI `gpt-5.3-codex-spark`.
- CLI fallback: `gpt-5.4-mini`.
- DeepSeek API routes: included but disabled.
- OpenAI API route: `gpt-4.1`, included but disabled.
- Semantics: model-driven and grounded by private RAG and tools.
- Validation: channel-free Brain tests first, selected channel smoke tests second.

The canonical routing configuration is [`config/model-routes.default.json`](config/model-routes.default.json). Treat that file, rather than prose copied elsewhere, as the source of truth for shipped model order.

## Prerequisites

Required for the default local deployment:

- A Linux host for the provided operational scripts.
- Node.js, npm, Bash, `curl`, `jq`, and PostgreSQL client tools.
- A reachable PostgreSQL database and a role allowed to install/use pgvector and apply the Brain schema.
- Access to at least one enabled model provider or CLI route.
- An ignored private `.env` file populated from the inventory in [`docs/credentials.md`](docs/credentials.md).

Required only for selected features:

- n8n URL and API credentials when using the included n8n shell.
- Credentials and webhook administration access for each enabled channel.
- Docker/Compose for the included local Langfuse stack.
- CRM credentials when enabling a CRM projection.
- Supabase project credentials only when Supabase was explicitly selected instead of the default local storage profile.

## Public template versus private deployment

| Safe in this public repository | Must remain deployment-private |
| --- | --- |
| API and tool contracts | Real credentials, tokens, cookies, and private keys |
| Generic PostgreSQL schemas and migrations | Tenant prompts, commercial policies, and runtime overrides |
| Disabled example model routes | Company documents, pricing, payment details, and private URLs |
| Generic workflow generators and inactive shell workflows | Production channel, account, CRM, tenant, and customer IDs |
| Synthetic scenario and evaluation fixtures | Real conversations, contacts, traces, exports, and evaluation data |
| Installation and operations documentation | Provider-specific secrets and production model configuration |

Private tenant packages should be reproducible, backed up separately, ignored by git, and loaded through documented contracts rather than copied into workflow nodes.

## Decisions required for every new chatbot

Before deployment, the human operator and installer agent must define:

1. Storage profile: local PostgreSQL by default, or explicitly requested Supabase.
2. Tenant boundary: tenant identifier, private knowledge package, policies, tone, supported claims, and data retention rules.
3. Model routing: enabled providers, priority, reasoning settings, timeout, retry, quota, and fallback policy.
4. Channels: which adapters are enabled and which account identifiers belong to each tenant.
5. Contact identity: channel identifiers, deduplication rules, cross-channel linking policy, and consent boundaries.
6. Tools: allowed business actions, validation requirements, idempotency keys, and approval boundaries.
7. Escalation: destination, semantic handoff policy, silence-after-handoff behavior, and operator reset procedure.
8. Observability: trace storage, redaction policy, evaluation criteria, alerting, and retention.
9. Operations: deployment owner, backup/restore process, incident path, and rollback procedure.

Do not guess missing production values. Leave optional integrations disabled until their requirements are supplied and verified.

## Quick start

Read the repository contract and installation guide first:

1. Read [`AGENTS.md`](AGENTS.md).
2. Read [`docs/operator-installation.md`](docs/operator-installation.md).
3. Select the storage profile using [`docs/storage-profiles.md`](docs/storage-profiles.md).
4. Create the ignored private environment and tenant package described in the installation guide.
5. Enable only the model routes, tools, and channels that have complete private configuration.

Bootstrap and validate the Brain before connecting channels:

```bash
npm install
npm run db:apply
npm run brain:start
npm run brain:status
npm run brain:router:test
npm run brain:smoke
```

After private knowledge, n8n access, and selected channel credentials are configured:

```bash
npm run knowledge:ingest
npm run workflows:generate
npm run workflows:deploy
npm run channels:configure
npm run runtime:verify
npm run runtime:test
```

For a fully configured deployment, the corresponding aggregate command is:

```bash
npm run runtime:deploy
```

Before publishing template changes:

```bash
npm run order:audit
npm run template:audit
```

## Definition of done

An installation is not complete merely because a webhook returns HTTP 200. It is complete only when evidence confirms all applicable gates:

- PostgreSQL schema and pgvector are applied to the selected database.
- Brain API health and structured response contract pass.
- Tenant, contact, thread, and conversation memory are isolated correctly.
- Knowledge ingestion and grounded retrieval return the expected tenant data.
- Tool calls are authorized, validated, idempotent, and auditable.
- Escalation is persisted, duplicate handoffs are suppressed, and operator reset resumes the bot.
- Primary model routing and configured fallback behavior are exercised successfully.
- Channel-free smoke and scenario suites pass against the deployed Brain.
- Every selected channel passes inbound, outbound, duplicate-delivery, and retry smoke tests.
- Observability records the route, input/output metadata, latency, errors, tool actions, and evaluation result under the configured redaction policy.
- Backup, restore, rollback, and operator handoff instructions match the deployed runtime.
- `npm run template:audit` passes before anything is published.

## Canonical reading path

Use these documents in order instead of reconstructing architecture from workflow JSON:

1. [`docs/architecture.md`](docs/architecture.md) and [`docs/source-of-truth.md`](docs/source-of-truth.md)
2. [`docs/operator-installation.md`](docs/operator-installation.md), [`docs/credentials.md`](docs/credentials.md), and [`docs/storage-profiles.md`](docs/storage-profiles.md)
3. [`docs/brain-api.md`](docs/brain-api.md), [`docs/conversation-quality.md`](docs/conversation-quality.md), and [`docs/model-routing.md`](docs/model-routing.md)
4. [`docs/escalation.md`](docs/escalation.md), [`docs/data-lifecycle.md`](docs/data-lifecycle.md), and [`docs/operations-and-data-ownership.md`](docs/operations-and-data-ownership.md)
5. [`docs/channel-adapters.md`](docs/channel-adapters.md) and [`docs/n8n-shell.md`](docs/n8n-shell.md)
6. [`docs/testing.md`](docs/testing.md), [`docs/evaluation.md`](docs/evaluation.md), and [`docs/langfuse.md`](docs/langfuse.md)
7. [`docs/public-template-safety.md`](docs/public-template-safety.md) and [`docs/agent-handoff.md`](docs/agent-handoff.md)

## Repository map

- [`schemas/local-postgres-brain.sql`](schemas/local-postgres-brain.sql): canonical default storage schema.
- [`schemas/brain-response.schema.json`](schemas/brain-response.schema.json): structured Brain API response contract.
- [`config/model-routes.default.json`](config/model-routes.default.json): public-safe model routing defaults.
- `scripts/`: Brain API, model router, database, workflow, channel, CRM, evaluation, and audit tooling.
- `workflows/`: generic inactive n8n shell workflows.
- `tests/`: synthetic channel-free contracts, scenarios, and regression fixtures.
- `docs/`: detailed architecture, installation, operations, and handoff guidance.

## Optional integrations

- Langfuse: run `npm run langfuse:up`; see [`docs/langfuse.md`](docs/langfuse.md).
- Instagram diagnostics: run `npm run instagram:webhook:configure`; see [`docs/instagram-delivery-diagnostics.md`](docs/instagram-delivery-diagnostics.md).
- HubSpot projection: see [`docs/crm-integration.md`](docs/crm-integration.md). CRM remains an operator-facing projection, not the source of conversational memory.

## Reuse rules for installer agents

- Inspect the target host and existing deployment state before changing anything.
- Keep private deployment inputs outside this repository and record only non-secret installation evidence.
- Apply schemas and configuration through idempotent scripts rather than manual hidden steps.
- Generate or import thin channel shells; do not rebuild the Brain inside n8n.
- Put tenant behavior in private prompts, RAG, and tool policy behind the Brain API.
- Preserve generic contracts so n8n, channels, model providers, storage profiles, CRM, and observability can be replaced independently.
- Run channel-free tests before spending time or quota on external channel tests.
- Never publish production exports as reusable examples; convert lessons into synthetic fixtures and generic documentation.

No real credentials, private company knowledge, production identifiers, or customer data belong in this repository.
