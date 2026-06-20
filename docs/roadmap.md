# Roadmap

## Phase 1: Instagram proof of concept

- Keep one production workflow: `Demo: RAG in n8n`.
- Use Supabase as the only memory and vector store.
- Use `documents` for curated company knowledge chunks.
- Use `conversation_events` for immutable chat audit.
- Use `thread_states` for routing state such as escalation silence.
- Keep all credentials in runtime `.env` only.
- Keep public repo docs and workflow exports secret-free.

## Phase 2: Public installer-quality repo

- Make the repo usable by an agent such as OpenClaw plus Codex CLI.
- Document required accounts, tokens, setup order, and smoke tests.
- Provide schema, workflow exports, runbooks, and skill instructions.
- Keep company-specific memory out of the public template.
- Provide placeholders and clear environment variable names instead of secrets.

## Phase 3: Private bot memory and evaluation

- Ingest only curated, customer-safe company knowledge into `documents`.
- Keep operator-only policies out of customer-facing retrieval unless retrieval filters are implemented.
- Add evaluation prompts for sales, support, pricing, handoff, and refusal cases.
- Review conversation logs weekly and update the curated pack rather than raw notes.

## Phase 4: Telegram and multi-channel expansion

- Add a channel adapter layer.
- Reuse Supabase tenant/thread/document architecture.
- Store channel-specific IDs in channel-specific fields or metadata.
- Keep one canonical company memory layer across channels.
- Add channel-specific style rules only where needed.

## Phase 5: Template productization

- Separate public template assets from private Sell.Systems runtime memory.
- Provide a bootstrap checklist for new users to connect their own Meta/Supabase/n8n/OpenAI accounts.
- Provide ingestion contracts for customer-owned company memory.
- Provide operator reset, escalation, and monitoring playbooks.
