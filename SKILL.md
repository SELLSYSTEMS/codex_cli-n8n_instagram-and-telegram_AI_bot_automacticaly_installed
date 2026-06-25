---
name: n8n-multichannel-rag-bot
description: Configure and operate a reusable n8n + Supabase pgvector + OpenAI multi-channel RAG bot template for Instagram, Telegram, WhatsApp, internal testing, knowledge upload, escalation state, and public-template-safe deployment.
---

# n8n multi-channel RAG bot

Use this skill when setting up or maintaining this repo's reusable chatbot template.

## Operating rules

1. Keep real secrets in `.env` only. Never commit live tokens, API keys, customer data, or company-private knowledge.
2. Keep public workflow exports and docs generic. Company-specific offers, prices, rules, and memories belong in Supabase.
3. Use Supabase native Postgres/`pgvector` for documents, embeddings, conversation memory, tenant settings, and thread state.
4. Do not add AWS/S3 vector wrappers or external vector services to the RAG path.
5. Keep every channel adapter normalized into the shared message contract: `tenant_id`, `channel`, `thread_id`, `sender_id`, `sender_name`, `message_id`, `message_text`, and `raw_event`.
6. Test the shared core through `Internal: RAG Bot Test Harness` before testing Instagram, Telegram, or WhatsApp.
7. Preserve deterministic escalation state outside the LLM: if a thread is escalated or muted, the bot must stay silent until an operator resets it.
8. Make bot behavior semantic and multilingual. Do not hard-code sales logic by language; use customer meaning, history, retrieved knowledge, and tenant settings.
9. Prefer concise, consultative answers with one clear next step and no generic templates.

## Standard workflow set

- `Demo: RAG in n8n`
- `Knowledge Upload to Supabase`
- `Internal: RAG Bot Test Harness`
- `Telegram: RAG Channel Adapter`
- `WhatsApp: RAG Channel Adapter`

## Safe implementation sequence

1. Apply `schemas/supabase.sql`.
2. Load `.env` locally or in the n8n runtime.
3. Sync/import workflow JSON.
4. Activate workflows.
5. Upload company knowledge.
6. Run internal two-turn memory and retrieval tests.
7. Test channel adapters one by one.
8. Only enable live outbound sends after the shared core produces acceptable answers.
