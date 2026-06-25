# Runbook

## Public repo rules

- Do not commit `.env` or real credentials.
- Use placeholders in workflow exports and docs.
- Keep company-specific knowledge in Supabase, not in this repo.
- Keep Supabase native `pgvector` as the only vector store.

## Bootstrap

1. Create or select a Supabase project.
2. Run `schemas/supabase.sql` once in the Supabase SQL editor or through a trusted database connection.
3. Create `.env` from the documented variables in `README.md`.
4. Import or sync all workflows:

```bash
set -a
. ./.env
set +a
./scripts/sync-workflows.sh
```

5. Activate these workflows in n8n:

```text
Demo: RAG in n8n
Knowledge Upload to Supabase
Internal: RAG Bot Test Harness
Telegram: RAG Channel Adapter
WhatsApp: RAG Channel Adapter
```

## Internal smoke test

Use this before testing Instagram, Telegram, or WhatsApp:

```bash
curl -sS -X POST "$N8N_BASE_URL/webhook/internal-rag-test" \
  -H "Content-Type: application/json" \
  -H "x-internal-test-token: $INTERNAL_TEST_TOKEN" \
  --data '{
    "tenant_id":"demo",
    "channel":"internal_test",
    "thread_id":"smoke-001",
    "sender_name":"Alex",
    "message_text":"Hi, I need help automating Instagram leads and follow-ups. What can you do?"
  }'
```

Expected result:

- `ok=true`
- `status=answered`
- non-empty `response`
- `memory_debug.user_logged=true`
- retrieved documents after knowledge has been uploaded

Run a second message with the same `thread_id` and confirm the bot remembers the previous turn.

## Instagram setup

- Callback URL: `https://your-n8n-domain.example/webhook/instagram-rag-webhook`
- Verify token: `IG_WEBHOOK_VERIFY_TOKEN`
- Required token: Page/Instagram token in `IG_ACCESS_TOKEN`
- Required permission for Instagram DMs: `instagram_manage_messages`
- Keep `IG_ENABLE_LIVE_SEND=false` until internal and webhook tests pass.

## Telegram setup

- Set `TELEGRAM_BOT_TOKEN` in `.env`.
- Activate `Telegram: RAG Channel Adapter`.
- Send `/start`, then a normal business question.
- Remember that Telegram only uses one active webhook per bot token, so avoid testing two n8n workflows against the same bot token at the same time.

## WhatsApp setup

- Callback URL: `https://your-n8n-domain.example/webhook/whatsapp-rag-webhook`
- Verify token: `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- Subscribe the WhatsApp webhook field `messages`.
- Required outbound variables:

```bash
WHATSAPP_ACCESS_TOKEN=replace_me
WHATSAPP_PHONE_NUMBER_ID=replace_me
META_GRAPH_VERSION=v25.0
```

For production, use a Meta Business system-user access token rather than a short-lived temporary token.

## Knowledge upload smoke test

```bash
curl -sS -X POST "$N8N_BASE_URL/webhook/knowledge-upload" \
  -H "Content-Type: application/json" \
  --data '{
    "tenant_id":"demo",
    "source":"company-overview.md",
    "title":"Company overview",
    "content":"Describe offers, pricing, qualification rules, handoff rules, and FAQs here."
  }'
```

Then run the internal smoke test again and confirm retrieval returns relevant rows.

## Escalation reset

If the bot handed off to a human and should start replying again, reset the thread state in Supabase:

```sql
update public.thread_states
set status = 'bot_active',
    is_escalated = false,
    escalation_reason = null,
    escalated_at = null,
    updated_at = now()
where tenant_id = 'demo'
  and channel = 'telegram'
  and thread_id = 'telegram:123456789';
```

Use the actual `tenant_id`, `channel`, and `thread_id` from `conversation_events`.
