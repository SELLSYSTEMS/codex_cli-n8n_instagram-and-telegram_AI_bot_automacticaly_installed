---
skill: n8n-instagram-rag-bot
title: Instagram DM + Supabase RAG workflow pack
owner: SELLSYSTEMS
repo: codex_cli-n8n_instagram_AI_bot_automacticaly_installed
runtime:
  platform: n8n
  data_store: Supabase pgvector
  message_channel: Instagram DM webhook
---

# Skill: Instagram DM + RAG (n8n)

## Goal

From one input prompt, configure a working Instagram DM assistant that:

- normalizes Meta webhook messages,
- retrieves relevant context from Supabase vector embeddings,
- generates grounded replies with OpenAI,
- escalates when confidence is low,
- logs every turn in `conversation_events`.
- keeps all retrieval and retrieval persistence inside Supabase pgvector.

## Required inputs

- `N8N_BASE_URL`
- `N8N_API_KEY`
- `SUPABASE_REST_URL`
- `SUPABASE_SECRET_KEY` or `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_MATCH_COUNT`
- `SUPABASE_MIN_SIMILARITY`
- `RAG_CONFIDENCE_THRESHOLD`
- `OPENAI_API_KEY`
- `OPENAI_EMBEDDING_MODEL`
- `OPENAI_CHAT_MODEL`
- `IG_VERIFY_TOKEN`
- `IG_ACCESS_TOKEN`
- `IG_INSTAGRAM_BUSINESS_ACCOUNT_ID`
- `IG_APP_ID_1` and `IG_APP_SECRET_1`
- `SUPABASE_ORG_SLUG`
- `SUPABASE_PROJECT_ID`
- `IG_APP_NAME` (default label: `NDRD_i+api-IG`)

## One-prompt execution contract

1. Save runtime values into `.env`.
2. Keep secrets only in `.env` and in `.gitignore`.
3. Run `./scripts/sync-workflows.sh`.
4. Verify or activate these workflow names:
   - `Demo: RAG in n8n`
   - `Knowledge Upload to Supabase`
5. Before activation, run a preflight on all required runtime keys and block on any missing token.
6. Configure Meta webhooks (verify mode + message subscription) and run smoke tests:
   - webhook GET challenge
   - one document ingest
   - one simulated DM ask flow
7. Return a short run report with execution IDs and DB insert confirmations.
7. Preserve workflow names and webhook paths for future reinstallers and future AI agents.

## One-shot installation payload

For OpenClaw-like onboarding, invoke the runbook-style prompt in:
- `docs/openclaw-onboarding-prompt.md`

Use this as the deterministic output contract:
- `workflow names`: `Demo: RAG in n8n`, `Knowledge Upload to Supabase`
- `webhook endpoints`: `.../webhook/instagram-webhook`, `.../webhook/knowledge-upload`
- `artifacts`: `workflows/`, `schemas/`, `docs/`, `scripts/`, `.gitignore`, `SKILL.md`
- `result`: workflow sync completed, verification command succeeds, and smoke tests show expected rows.

## Webhook endpoints

- `https://n8nlandingtmplfgma.sellsystems.agency/webhook/instagram-webhook`
- `https://n8nlandingtmplfgma.sellsystems.agency/webhook/knowledge-upload`

## Operational guardrails

- Do not edit SSH/SSL/Wireguard/firewall/system services from this repo.
- Keep vectors in Supabase only; do not introduce AWS/S3 vector wrappers.
- Keep all user-facing workflow names and labels stable.

## Escalation state requirement

For production Instagram DM bots, do not rely only on message-level logs for escalation. Add a current-state table such as `thread_states` and enforce this behavior:

1. The first escalation sends one handoff message.
2. The thread is marked `escalated`.
3. Later inbound messages are logged but receive no bot reply.
4. A human operator must call `reset_thread_escalation` before the bot can answer that thread again.

## Internal bot testing rule

Before debugging Instagram or Telegram delivery, run a channel-free bot-brain test. Use `scripts/internal-bot-test.mjs` with `channel=internal_test` so Supabase RAG, OpenAI generation, conversation logging, and escalation markers can be validated without sending external messages.
