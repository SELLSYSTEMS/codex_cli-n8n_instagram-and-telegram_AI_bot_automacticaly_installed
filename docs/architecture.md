# Architecture

## Goal

Provide a reusable n8n + Supabase + OpenAI assistant template that can be installed by future AI agents and adapted for any company. The public repo contains workflow structure, schema, runbooks, and safe placeholders only. Company data lives in Supabase and environment variables.

## Runtime topology

```text
Instagram / Telegram / WhatsApp / internal test
-> channel adapter
-> normalized message contract
-> shared RAG bot core
-> Supabase memory + state + vector retrieval
-> OpenAI generation
-> outbound channel adapter
-> Supabase event log
```

## Normalized message contract

Every channel adapter should send the shared core these fields:

```json
{
  "tenant_id": "demo",
  "channel": "instagram|telegram|whatsapp|internal_test",
  "thread_id": "stable-channel-thread-id",
  "sender_id": "external-user-id",
  "sender_name": "optional display name",
  "message_id": "external-message-id",
  "message_text": "customer text",
  "raw_event": {}
}
```

This keeps the bot brain channel-independent and makes internal testing faster than repeatedly sending live DMs.

## Supabase responsibilities

Supabase is the system of record for:

- `documents` - RAG chunks and `pgvector` embeddings.
- `conversation_events` - user/assistant messages and analytics.
- `tenant_settings` - company-level runtime settings.
- `thread_states` - escalation/mute/bot-active state per tenant/channel/thread.

Use native Supabase/Postgres `pgvector`. Do not add AWS/S3 vector wrappers to this flow.

## Escalation behavior

`thread_states` controls whether the bot should answer.

- `bot_active`: normal autonomous replies.
- `escalated`: bot stays silent after handoff until reset by an operator.
- `muted`: bot does not reply.

Operator reset should update the thread back to `bot_active` and clear escalation metadata. This prevents the bot from repeating the same handoff message every time the customer writes again.

## n8n AI Agent direction

n8n's native AI Agent and LangChain nodes are useful for future versions because they support tools, memory, and direct vector-store connections. The current template still keeps an explicit shared core with HTTP/OpenAI/Supabase calls because it gives us:

- deterministic channel-independent input/output contracts;
- direct Supabase RPC control for tenant filters and escalation state;
- simple internal smoke tests without a live channel;
- workflow exports that are easy for another AI agent to import and patch;
- a clean migration path to native AI Agent nodes once behavior parity is proven.

Recommended next native-agent migration:

1. Keep the channel adapters unchanged.
2. Replace the current LLM generation section inside the shared core with an AI Agent node.
3. Attach Supabase Vector Store as a retrieval tool.
4. Attach Postgres/Supabase-backed memory with a stable session key of `tenant_id:channel:thread_id`.
5. Keep explicit `thread_states` checks outside the agent so escalation safety is deterministic.

## Scaling notes

- n8n queue mode can scale webhook and worker execution with Redis.
- Supabase vector indexes should be tenant-filtered and monitored as document volume grows.
- Keep channel send nodes isolated so failures in Instagram/Telegram/WhatsApp do not corrupt core memory.
