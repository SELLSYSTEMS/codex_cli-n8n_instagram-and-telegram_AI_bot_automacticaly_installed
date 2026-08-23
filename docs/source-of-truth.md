# Project source of truth

This repository has three deliberately separate layers. Mixing them is the main source of duplicate tables, stale workflows, leaked tenant data, and contradictory operating instructions.

## Canonical layers

| Layer | Canonical location | May contain | Must not contain |
| --- | --- | --- | --- |
| Public reusable template | Repository files outside `.private/` and `.env` | Generic Brain API, PostgreSQL schema, thin channel workflows, install scripts, tests, public documentation | Credentials, private domains, production IDs, customer data, tenant prompts, company knowledge |
| Private tenant overlay | Ignored `.private/` and local `.env` | Tenant knowledge, runtime policy, test fixtures, secret references, local continuity notes | Public-template defaults or files required for a generic installation |
| Live runtime | Local PostgreSQL, Brain API, n8n, external channel and CRM APIs | Operational state, messages, identities, model runs, delivery state | Competing business logic or a second source of conversation truth |

## Canonical runtime ownership

| Concern | Owner |
| --- | --- |
| Conversation semantics and response generation | Brain API |
| Conversation and identity memory | Local PostgreSQL `agent` schema |
| RAG documents, chunks, and vectors | Local PostgreSQL `agent` schema |
| Escalation state and reset | Brain API plus `agent` schema |
| Model routing and fallback | Brain API |
| Channel receipt and delivery | Thin n8n channel adapters |
| Human-facing operational controls | n8n operator workflows |
| Tenant-specific behavior and knowledge | Ignored private overlay |

Supabase is an optional installation profile only when the operator explicitly requests it in the initial installation prompt. It is not a second default datastore.

## Canonical database

`schemas/local-postgres-brain.sql` is the only public bootstrap schema. New runtime code must use the `agent` schema.

The old `public.bot_*` tables and related `bot_*` functions are legacy objects. They are not canonical, must receive no new integrations, and must not be deleted until the private retirement plan has been completed with a backup and reconciliation evidence.

## Canonical workflows

The public template contains exactly these replaceable n8n shells:

1. `Channel - Instagram - Shared AI Brain`
2. `Channel - WhatsApp - Shared AI Brain`
3. `Channel - Telegram - Shared AI Brain`
4. `Internal - Brain Test Harness`
5. `Operator - Knowledge Ingest`
6. `Operator - Escalation Reset`
7. `Operator - Model Route Control`
8. `Operator - Cross-channel Identity Link`

Public workflow exports remain inactive and contain placeholders only. Activation, credentials, webhook registration, and production IDs belong to installation/runtime operations.

## Change rules

1. Change the owning layer, not a downstream copy.
2. Do not put sales reasoning, language routing, objection handling, or escalation policy in channel workflows.
3. Do not create a parallel table or workflow when a canonical owner already exists.
4. Make all external writes idempotent and observable.
5. Add or update an audit whenever the canonical structure changes.
6. Record tenant-only decisions in `.private/`; record reusable contracts in public docs.
7. Run `npm run template:audit` before publication.
8. Run `npm run database:inventory` before any database retirement work.

## Current cleanup boundary

The repository structure and database inventory are normalized by documentation and read-only audits first. Legacy database objects and historical private archives are quarantined by policy, not deleted automatically.
