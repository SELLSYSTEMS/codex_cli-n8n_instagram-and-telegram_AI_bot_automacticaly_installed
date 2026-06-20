# Architecture: Instagram DM RAG in n8n

## Stable artifact naming

- Bot workflow: `Demo: RAG in n8n`
- Ingest workflow: `Knowledge Upload to Supabase`
- Webhook paths:
  - `instagram-webhook`
  - `knowledge-upload`

## Components

- `Demo: RAG in n8n`
  - Webhook trigger at path `/webhook/instagram-webhook`
  - Message normalization + intent routing
  - Embedding + pgvector retrieval via RPC
  - Grounded LLM generation
  - Instagram send path + conversation logging
- `Knowledge Upload to Supabase`
  - Ingest endpoint at `/webhook/knowledge-upload`
  - Payload normalization and chunking
  - OpenAI embedding generation
  - Upsert into `documents`

## Supabase-native memory architecture

- `documents`
  - raw chunk text and `vector(1536)` embeddings
  - metadata and tenant scope
- `conversation_events`
  - message-level logs for user + assistant turns
  - confidence and escalation flags
- `tenant_settings`
  - per-tenant policy/style/config
- SQL functions:
  - `match_documents`
  - `match_documents_with_context`
- No S3/AWS vector wrapper path is used in this repo.

## Data boundaries

- Tenant context is propagated on every row as `tenant_id`.
- No user raw payload is persisted outside of execution logs:
  - OpenAI receives content for inference
  - Instagram receives only generated reply payload

## Scaling notes

- `Webhook` trigger supports queue mode in n8n worker mode for production.
- Indexing pattern targets `ivfflat (embedding vector_cosine_ops)` in PostgreSQL for vector lookup.
- Keep chunk size/overlap under control through env-driven values.

## Security / safety

- All secrets in `.env` only.
- No host or network infra modifications inside this repo.
- Vector retrieval is fully inside Supabase `pgvector` + PostgREST/RPC boundaries.

## API endpoints in scope

- Meta verification + inbound:
  - `https://n8nlandingtmplfgma.sellsystems.agency/webhook/instagram-webhook`
- KB upload:
  - `https://n8nlandingtmplfgma.sellsystems.agency/webhook/knowledge-upload`

## Why this architecture for agent reuse

- Deterministic workflow names and clear environment bindings make reinstallation and diff-driven updates predictable.
- Supabase-only vector operations remove third-party wrapper complexity and keep the source of memory truth centralized.

## Runtime delivery gate - 2026-06-18

Outbound Instagram delivery is split into two explicit branches:

- `IG_ENABLE_LIVE_SEND=false`: the workflow executes all RAG and logging steps, then ends in a dry-run delivery node. This is the default for public demos, synthetic webhook tests, and future agent onboarding.
- `IG_ENABLE_LIVE_SEND=true`: the workflow calls the Instagram Messaging API. This requires a real `IG_ACCESS_TOKEN` and `IG_INSTAGRAM_BUSINESS_ACCOUNT_ID` in `.env` before syncing to n8n.

This keeps the public workflow runnable without leaking credentials or sending accidental real DMs. Supabase remains the only memory/vector backend: tenant settings, conversation history, knowledge chunks, embeddings, retrieval RPCs, and analytics events all live in Postgres/pgvector.

## Escalation state architecture

The bot uses two Supabase layers for escalation:

- `conversation_events` stores immutable events and audit history.
- `thread_states` stores the current routing state for one tenant/channel/thread.

When a handoff or low-confidence escalation happens, n8n calls `mark_thread_escalated`. The next inbound message in the same Instagram thread goes through `Escalation Silence Gate`; if the state is still `escalated`, the message is logged and no Instagram reply is sent.

A human operator resumes automation by calling `reset_thread_escalation` after reviewing the thread.
