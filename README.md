# Multi-channel n8n RAG Bot Template

Public starter for a reusable AI assistant that receives customer messages from Instagram, Telegram, WhatsApp, or an internal test endpoint, retrieves company knowledge from Supabase `pgvector`, generates a grounded answer with OpenAI, logs memory, and respects escalation state.

This repository is a template. It must not contain company-private knowledge, customer data, or live credentials.

## Architecture

Runtime flow:

```text
Channel webhook
-> channel adapter normalization
-> shared RAG bot core
-> Supabase tenant settings, thread state, conversation memory, vector retrieval
-> OpenAI response generation
-> channel adapter outbound send
-> Supabase logging and escalation analytics
```

Current workflow exports:

- `workflows/demo-rag-instagram-supabase.json` - Instagram adapter plus shared bot flow.
- `workflows/telegram-rag-channel-adapter.json` - Telegram adapter into the shared core.
- `workflows/whatsapp-rag-channel-adapter.json` - WhatsApp Cloud API adapter into the shared core.
- `workflows/internal-rag-bot-test-harness.json` - fast internal smoke-test endpoint without any external channel.
- `workflows/knowledge-upload-to-supabase.json` - company knowledge upload and embedding pipeline.

Supabase is the only vector store and memory source in this template. Do not use AWS/S3 vector wrappers or external vector services for RAG.

## Required services

- n8n self-hosted or cloud instance.
- Supabase project with `vector` extension enabled.
- OpenAI API key for embeddings and chat completion.
- At least one channel credential: Instagram, Telegram, or WhatsApp.

## Required environment variables

Keep real values in `.env` only. Commit placeholders only.

```bash
N8N_BASE_URL=https://your-n8n-domain.example
N8N_API_KEY=replace_me
INTERNAL_TEST_TOKEN=replace_me

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=replace_me
OPENAI_API_KEY=replace_me

IG_WEBHOOK_VERIFY_TOKEN=replace_me
IG_ACCESS_TOKEN=replace_me
IG_ENABLE_LIVE_SEND=false

TELEGRAM_BOT_TOKEN=replace_me

WHATSAPP_WEBHOOK_VERIFY_TOKEN=replace_me
WHATSAPP_ACCESS_TOKEN=replace_me
WHATSAPP_PHONE_NUMBER_ID=replace_me
META_GRAPH_VERSION=v25.0
```

## Setup

1. Apply `schemas/supabase.sql` to the Supabase project.
2. Import the workflow JSON files into n8n, or run `scripts/sync-workflows.sh` with `N8N_BASE_URL` and `N8N_API_KEY` set.
3. Activate the workflows.
4. Configure channel webhooks:

```text
Instagram: https://your-n8n-domain.example/webhook/instagram-rag-webhook
Telegram: use the Telegram trigger/adapter workflow for the bot token
WhatsApp: https://your-n8n-domain.example/webhook/whatsapp-rag-webhook
Knowledge upload: https://your-n8n-domain.example/webhook/knowledge-upload
Internal test: https://your-n8n-domain.example/webhook/internal-rag-test
```

5. Upload company knowledge through the knowledge workflow before judging answer quality.
6. Run the internal test endpoint first, then test live channels.

## Bot behavior contract

The shared core should:

- Preserve context across turns using Supabase conversation memory.
- Retrieve knowledge semantically through Supabase vectors.
- Answer naturally in the customer's language.
- Use USD by default unless the customer requests another currency or the local context clearly requires one.
- Sell consultatively: discover needs, connect them to relevant automation/AI/CRM/support/content workflows, and propose the next step.
- Avoid canned templates and repeated generic replies.
- Escalate only when needed, then stay silent until an operator resets the thread state.

## Public-template boundary

Company-specific prompts, prices, offers, policies, and knowledge belong in Supabase documents or tenant settings for that company. They do not belong hard-coded in this public repo.
