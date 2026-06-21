# Instagram DM + RAG n8n Starter

This repo documents and stores the OpenClaw/Codex-CLI workflow pack for a production-ready Instagram DM assistant using n8n + Supabase vector memory.

## Purpose

- Keep everything needed for fast re-installation by future AI agents.
- Store clear n8n workflow artifacts for:
  - Instagram DM intake + RAG response flow
  - documentation/knowledge upload flow
- Keep credentials in `.env` only (not committed).
- Keep all vector memory in Supabase-native `pgvector` only (no AWS/S3 wrapper path in this architecture).

## Quick start

1. Create a local `.env` file with required runtime values. Do not commit it.
2. Import both workflow exports into n8n:
   - `workflows/demo-rag-instagram-supabase.json`
   - `workflows/knowledge-upload-to-supabase.json`
3. Configure environment bindings in n8n (or n8n container env) for:
   - OpenAI
   - Supabase access via REST (if using API calls)
4. Run `schemas/supabase.sql` in your Supabase SQL editor and verify Postgres objects exist.
5. Configure webhook URLs in Meta for `instagram-webhook` and `knowledge-upload` paths.
6. Use `docs/architecture.md` and `docs/runbook.md` for the implementation/ops sequence.
7. If your n8n instance allows API-based deployment, run:
   - `./scripts/sync-workflows.sh`

## One-shot OpenClaw/Codex onboarding

The intended bootstrap flow is:

1. one deterministic prompt to OpenClaw/Codex,
2. local `.env` values loaded,
3. `./scripts/sync-workflows.sh` executes,
4. Meta webhook GET challenge is validated,
5. smoke tests pass,
6. `Demo: RAG in n8n` is activated only after successful verification.

## Required domains and names

- n8n URL: `https://n8nlandingtmplfgma.sellsystems.agency`
- Workflow target name: `Demo: RAG in n8n`
- KB workflow name: `Knowledge Upload to Supabase`
- Webhook endpoints:
  - `https://n8nlandingtmplfgma.sellsystems.agency/webhook/instagram-webhook`
  - `https://n8nlandingtmplfgma.sellsystems.agency/webhook/knowledge-upload`

## Hard constraints

- Do not touch host infrastructure in this repository scope (SSH, SSL certs, WireGuard, firewall/service config).
- Do not store real secrets in git.
- Supabase is the only vector store and source of truth for memory.
- No external vector services for RAG in this repo (including AWS/S3 wrappers).
- Keep user-facing workflow labels, names, and paths stable across re-installs.
- Do not add AWS/S3 vector wrappers; Supabase pgvector is the only RAG memory backend.

## Repository structure

- `workflows/`  
  n8n workflow JSON exports used for imports.
- `schemas/`  
  Supabase schema SQL for pgvector + conversation memory.
- `docs/`  
  Operational playbooks and architecture notes.
- `AGENTS.md`  
  Repo-specific guardrails and safety constraints.
- `SKILL.md`  
  Deterministic automation instructions for OpenClaw/Codex re-install.

## Local secret handling contract

- Populate local `.env` with runtime secrets only (do not commit).
- `.env` must remain ignored by git (`.env` and `.env.*` are already in `.gitignore`).
- `.obsidian/SESSION_MEMORY.md` is local working-memory only (also ignored via `.obsidian/`).

## OpenClaw/Codex one-shot contract

- Use one bootstrap instruction block:
  - `scripts/sync-workflows.sh`
  - `./scripts/check-runtime-prereqs.sh`
  - webhook verify on `Demo: RAG in n8n`
  - one knowledge upload smoke test
  - one simulated inbound DM smoke test
- Do not activate `Demo: RAG in n8n` until verification + smoke tests pass.

## Current runtime status - 2026-06-18

The public demo is configured for safe smoke testing by default. `Demo: RAG in n8n` is active and the Instagram webhook path runs the full inbound path through normalization, intent classification, OpenAI embeddings, Supabase pgvector retrieval, escalation logic, and Supabase conversation logging.

Live Instagram sending is gated by `IG_ENABLE_LIVE_SEND`. Keep it set to `false` for repository demos and synthetic webhook tests. Set it to `true` only after `IG_ACCESS_TOKEN` and `IG_INSTAGRAM_BUSINESS_ACCOUNT_ID` are configured in `.env`, then resync the workflow with `./scripts/sync-workflows.sh`.

Verified state:
- Supabase schema and RPCs are applied in project `mqyqmudbyypnxhwwkisc`.
- Knowledge upload webhook writes chunks into `public.documents` using native pgvector.
- Main Instagram workflow writes user and assistant events into `public.conversation_events`.
- No AWS/S3 vector path is used for RAG.

## Current setup guides

- `docs/instagram-setup.md` documents the Instagram-first production path.
- `docs/operator-escalation.md` documents the one-time escalation marker and reset flow.
- `docs/roadmap.md` documents the path from private proof of concept to public template.
- `docs/public-template-strategy.md` documents what belongs in the public repo versus private runtime memory.

Repository rename note: the intended public repo name is `SELLSYSTEMS/codex_cli-n8n_instagram-and-telegram_AI_bot_automacticaly_installed`, with Instagram as the first completed channel and Telegram as a later roadmap channel.

## Internal bot testing

Use the channel-free bot test harness before testing Instagram or Telegram:

```bash
node scripts/internal-bot-test.mjs --thread local-sales-test-001 --message "What can you build for Instagram automation?"
```

Run the full autonomous regression suite before live channel QA:

```bash
node scripts/internal-bot-regression-suite.mjs --thread local-regression
```

See `docs/internal-bot-testing.md` and `docs/autonomous-testing.md` for escalation silence tests, reset commands, and regression criteria.

Reusable import/export artifacts are documented in `docs/import-export.md`.
