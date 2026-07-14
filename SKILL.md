---
name: multichannel-ai-bot-installer
description: Install a company-neutral multichannel conversational AI brain with local PostgreSQL, pgvector, model fallback, internal tests, and replaceable n8n channel adapters.
---

# Multichannel AI Bot Installer

## Operator intent

Before changing infrastructure, extract and confirm:

- selected channels;
- tenant identity and private knowledge location;
- required business tools;
- model providers and priority;
- whether the operator explicitly requested Supabase.

If Supabase is not explicitly requested, use local PostgreSQL.

## Installation sequence

1. Inspect AGENTS.md and docs/operator-installation.md.
2. Keep all tenant data and credentials outside the public tree.
3. Apply schemas/local-postgres-brain.sql.
4. Configure the Brain API contract from docs/brain-api.md.
5. Configure model routes. API providers remain disabled until their credentials and operator approval are present.
6. Ingest private company knowledge into the selected tenant only.
7. Run channel-free memory, RAG, escalation, multilingual, sales, and safety tests.
8. Import only the required n8n channel adapters.
9. Run channel smoke tests.
10. Run the public-template safety audit before committing.

## Behavioral invariant

Use the LLM for semantic interpretation and response strategy. Use deterministic code only for operational correctness: authentication, validation, tenancy, idempotency, persistence, rate limits, tool permissions, model fallback, escalation state, and delivery.
