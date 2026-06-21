# Runbook: One-Prompt OpenClaw/Codex Deployment

## Goal

From one prompt, OpenClaw/Codex should create a runnable Instagram DM assistant by:

- scaffolding all required files from this repo,
- syncing workflow JSON into n8n,
- validating Supabase-native RAG,
- and making a test inbox loop operational without touching host/network infra.

## Input prompt pattern

Use a single deterministic instruction block:

- configure repository credentials in `.env`,
- sync and activate:
  - `Demo: RAG in n8n`
  - `Knowledge Upload to Supabase`,
- wire webhook URLs in Meta,
 - run smoke tests for knowledge ingest and ask flow,
 - and report the result with workflow execution IDs.

## One-shot success criteria (what an operator should report)

When complete, report exactly:

- workflows synchronized by name (`Demo: RAG in n8n`, `Knowledge Upload to Supabase`)
- webhook verification GET returns the raw `hub.challenge`
- knowledge upload inserted at least one row into `public.documents`
- ask flow created both user/assistant rows in `public.conversation_events`
- outbound reply path returned an OK-like outcome from IG API
- `execution mode` for `Demo: RAG in n8n` is active only after verification pass

## Runtime flow (n8n workflow path)

1. Instagram DM webhook event arrives at `instagram-webhook`.
2. Webhook Trigger accepts `GET` verification and `POST` message payloads.
3. Event is normalized into canonical fields (`tenant_id`, `thread_id`, `message_id`, `sender_id`, `intent`).
4. Intent branches:
   - `ask` -> embedding -> vector retrieval -> grounding -> generation -> reply.
   - `human_handoff` -> escalation reply and event log.
   - `other` -> default fallback message.
5. Both user and assistant turns are logged in `public.conversation_events`.
6. Retrieval and answer traces include match ids, similarity, model, latency fields.

## One-prompt onboarding objective

- one command path, deterministic result,
- stable names for re-installation:
  - Workflow: `Demo: RAG in n8n`
  - KB flow: `Knowledge Upload to Supabase`
- no host-level changes (SSH, SSL/TLS certs, WireGuard, firewall, DNS, Nginx, system services).

## Platform behavior notes (verified from n8n docs)

- The n8n Webhook node exposes dedicated URLs and is intended for GET/POST inbound requests from services like Meta.
- In this workflow, verification uses GET `hub.mode=subscribe` + `hub.challenge`; production traffic requires:
  - workflow `active=true` in n8n
  - Meta webhook subscription targeting the production callback URL
- For scale, n8n queue mode moves webhook-triggered production executions to workers via Redis (`EXECUTIONS_MODE=queue` and queue/bull settings).  
  Queue mode is documented in n8n scaling docs and is the production pattern for bursty traffic.

## Required credentials for `.env`

## Supabase schema bootstrap (first-run requirement)

Before any runtime flow can execute end-to-end, these schema objects must exist in Postgres:

- `public.documents`
- `public.conversation_events`
- `public.tenant_settings`
- `rpc.get_tenant_settings`
- `rpc.get_thread_context`
- `rpc.match_documents`
- `rpc.match_documents_with_context`

Run this once:

```bash
./scripts/apply-supabase-schema.sh
```

If this machine cannot connect to Postgres, the script prints a manual Supabase SQL Editor fallback:

- Open `https://app.supabase.com/project/<your-supabase-project-ref>/sql/new`
- Paste `schemas/supabase.sql` and execute.
- Re-run workflow smoke tests only after object creation succeeds.

Minimum required for runtime:

- `N8N_BASE_URL`  
- `N8N_API_KEY`
- `SUPABASE_REST_URL`
- `SUPABASE_SECRET_KEY` (preferred) or `SUPABASE_PUBLISHABLE_KEY` fallback
- `SUPABASE_MATCH_COUNT`
- `SUPABASE_MIN_SIMILARITY`
- `RAG_CONFIDENCE_THRESHOLD`
- `OPENAI_API_KEY`
- `OPENAI_EMBEDDING_MODEL`
- `OPENAI_CHAT_MODEL`
- `IG_VERIFY_TOKEN`
- `IG_ACCESS_TOKEN`
- `IG_GRAPH_API_VERSION`
- `IG_MESSAGES_BASE_URL`
- `IG_INSTAGRAM_BUSINESS_ACCOUNT_ID`
- `IG_APP_ID_1` and `IG_APP_SECRET_1` (primary), plus optional `_2` pair.
- `SUPABASE_ORG_SLUG` and `SUPABASE_PROJECT_ID` for repo traceability.

Before any runtime attempt, run:

```bash
./scripts/check-runtime-prereqs.sh
# Optional early pass without IG tokens:
# ./scripts/check-runtime-prereqs.sh --skip-ig
```

This is the canonical checklist gate.

Use `docs/credentials-checklist.md` as the canonical credential source.

### Runtime minimum missing in many installs

- `N8N_API_KEY`
- `IG_VERIFY_TOKEN`
- `IG_ACCESS_TOKEN`
- `IG_INSTAGRAM_BUSINESS_ACCOUNT_ID`
- `OPENAI_API_KEY`

If these are missing, the onboarding flow should pause and explicitly prompt the operator before activation.

## Instagram / Meta production setup requirements (high confidence)

For production messaging on Instagram, operator must provide credentials from the same app used for webhooks:

- `IG_ACCESS_TOKEN` tied to the business-connected IG account.
- `IG_INSTAGRAM_BUSINESS_ACCOUNT_ID` for the send target.
- Matching `IG_VERIFY_TOKEN` used in Meta Webhooks subscription.
- Required app permissions in Meta for messaging + business messaging features (app state must allow sending/receiving messages).
- Business verification for advanced access (already noted as verified for your org in your input).
- If real-user traffic behaves differently than test payloads, verify app is in Live mode, required permissions are granted, and Business Verification/product approval status is current.

- Research notes (for accurate configuration):
  - Instagram messaging is exposed through Graph APIs, not legacy endpoints. In this repo the send URL is configured as:
    - `https://graph.instagram.com/{IG_GRAPH_API_VERSION}/{IG_INSTAGRAM_BUSINESS_ACCOUNT_ID}/messages`
  - Instagram webhook verification remains the standard `hub.mode=subscribe` + `hub.challenge` round trip expected from Meta Webhooks configuration.
  - This repo has no path that uses `api.instagram.com`; do not substitute non-IG Graph API send endpoints.
  - n8n queue mode scales webhook-driven production workloads by receiving webhook requests on main + enqueueing production executions to workers via Redis.
  - Do not use binary-only local storage assumptions in queue mode unless a compatible external object store strategy is configured explicitly.

Webhook path expected by this repo:

- `https://<your-n8n-domain>/webhook/instagram-webhook`

Meta webhook verification behavior is:

- `hub.mode=subscribe` + challenge query must return the raw `hub.challenge` when verify token matches.

If verification or message sends fail, do not activate production path until the Meta app configuration and token scope are corrected.

### Clarifications requested by operator (important)

- **Conversions API** is not required for this workflow’s core RAG DM path. It is separate from Instagram DM webhook + send.
- **Supabase S3 wrapper** must not be used for vectors in this repo. `pgvector` retrieval is required (`match_documents_with_context` RPC path).
- `IG_CLIENT_TOKEN` and secondary app keypair are optional. Keep them in `.env` only if you intentionally run dual app fallback.

## n8n scaling recommendation for webhook growth

For bursty inbound message traffic, align with n8n docs:

- enable queue mode for production webhook executions (`EXECUTIONS_MODE=queue`),
- keep Postgres + Redis available in queue mode,
- optionally enable production concurrency limit (for example `N8N_CONCURRENCY_PRODUCTION_LIMIT=20`),
- configure `N8N_AI_TIMEOUT_MAX` for longer OpenAI calls if needed.

Because this repository has no binary-heavy DM attachments currently, this architecture remains queue-mode compatible.

### Runtime readiness preflight (must pass before activation)

Run this exact check locally before turning on `Demo: RAG in n8n`:

```bash
set -a
source .env
set +a

for var in \
  N8N_BASE_URL \
  N8N_API_KEY \
  SUPABASE_REST_URL \
  SUPABASE_MATCH_COUNT \
  SUPABASE_MIN_SIMILARITY \
  RAG_CONFIDENCE_THRESHOLD \
  OPENAI_API_KEY \
  OPENAI_EMBEDDING_MODEL \
  OPENAI_CHAT_MODEL \
  IG_VERIFY_TOKEN \
  IG_ACCESS_TOKEN \
  IG_INSTAGRAM_BUSINESS_ACCOUNT_ID \
  IG_GRAPH_API_VERSION \
  IG_MESSAGES_BASE_URL; do
  if [ -z "${!var:-}" ]; then
    echo "MISSING: $var"
    exit 1
  fi
done
if [ -z "${SUPABASE_SECRET_KEY:-}" ] && [ -z "${SUPABASE_PUBLISHABLE_KEY:-}" ]; then
  echo "MISSING: SUPABASE_SECRET_KEY or SUPABASE_PUBLISHABLE_KEY"
  exit 1
fi
echo "preflight-ok"
```

Notes:

- For runtime, `SUPABASE_SECRET_KEY` is preferred.
- `SUPABASE_PUBLISHABLE_KEY` is a fallback only for limited debugging.
- Keep `SUPABASE_MATCH_COUNT`, `SUPABASE_MIN_SIMILARITY`, and `RAG_CONFIDENCE_THRESHOLD` aligned with your test intent mix.

### Project identity values used by this repo (non-secret)

- Supabase project URL `https://<your-project-ref>.supabase.co`
- Supabase project ref/id `<your-supabase-project-ref>`
- Supabase project name `<your-supabase-project-name>`
- Supabase org slug `xpfdvfkwzqvmwfxmcqrr`
- Supabase region `us-west-2`

### Security rule

Do not copy secret or credential values into tracked docs or scripts.  
Store all tokens, keys, and password values only in local `.env` (untracked).

In `.env`, this repo expects:

- `SUPABASE_SECRET_KEY` (preferred) or `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_JWT_CURRENT_KEY`
- `SUPABASE_JWT_PREVIOUS_KEY`
- `SUPABASE_PROJECT_PASSWORD`
- `IG_APP_ID_1`, `IG_APP_SECRET_1`
- `IG_APP_ID_2`, `IG_APP_SECRET_2`
- `IG_CLIENT_TOKEN`

## What this session already has from your provided inputs

- Repository/project IDs and non-secret references are already fixed:
  - repo: `<your-github-owner>/<your-repo-name>`
  - n8n domain: `https://<your-n8n-domain>`
  - workflow names and webhook paths as defined in this repo
  - Supabase project ref/ID: `<your-supabase-project-ref>`
  - Supabase URL: `https://<your-project-ref>.supabase.co`
  - Supabase region: `us-west-2`
- Supabase vector wrapper policy for this repo is settled: **pgvector only, no AWS/S3 vector path**.

## Required secrets still needed before production

- `N8N_API_KEY`
- `IG_VERIFY_TOKEN`
- `IG_ACCESS_TOKEN`
- `IG_INSTAGRAM_BUSINESS_ACCOUNT_ID`
- `OPENAI_API_KEY`

If any item above is missing, do not activate production traffic yet.

- n8n:
  - base URL `https://<your-n8n-domain>`.

### Still required from you before production

- `N8N_API_KEY` (n8n admin/API token).
- `IG_VERIFY_TOKEN` (must match Meta webhook verify token).
- `IG_ACCESS_TOKEN` (valid token with messaging capabilities for your business/IG connected account).
- `IG_INSTAGRAM_BUSINESS_ACCOUNT_ID` (the IG user id used in `/messages` path).
- `OPENAI_API_KEY`.
- App mode/access review state:
  - verify required permissions are in live mode for real users,
  - keep development/test role users separate from production traffic until live mode is ready.
- Ensure `IG_MESSAGES_ENDPOINT` (if set) points to an Instagram messaging endpoint and does not use legacy/fallbacks.

Official reference URLs for final human verification:
- Webhooks: https://developers.facebook.com/docs/messenger-platform/instagram/overview/
- Webhooks fields configuration: https://developers.facebook.com/docs/messenger-platform/instagram/features/webhooks/
- Message send reference: https://developers.facebook.com/docs/messenger-platform/reference/send-api/
- Messaging setup/get-started: https://developers.facebook.com/docs/messenger-platform/instagram/get-started/
- n8n queue mode: https://docs.n8n.io/hosting/scaling/queue-mode/
- n8n queue mode env vars: https://docs.n8n.io/hosting/configuration/environment-variables/queue-mode/

## Delivery artifacts

- `workflows/demo-rag-instagram-supabase.json` (main bot flow)
- `workflows/knowledge-upload-to-supabase.json` (document ingest)
- `schemas/supabase.sql` (pgvector + schema)

## One-command deployment

If your n8n environment exposes API and `.env` is loaded:

```bash
set -a
source .env
set +a
./scripts/sync-workflows.sh
```

This updates:

- `Demo: RAG in n8n`
- `Knowledge Upload to Supabase`

## Deployment sequence

1. Apply `schemas/supabase.sql` in Supabase SQL editor.
2. Confirm extensions and functions:
   - `vector`
   - `match_documents`
   - `match_documents_with_context`
3. Import/sync both workflow JSON files with the known names.
4. Activate `Demo: RAG in n8n` only after webhook verification test passes.
5. Configure Meta webhook callback to:
   `https://<your-n8n-domain>/webhook/instagram-webhook`
6. Configure knowledge ingest endpoint:
   `https://<your-n8n-domain>/webhook/knowledge-upload`
7. Run smoke tests and confirm execution rows in n8n + Supabase insertions.

## Architecture guardrails

- Do not use external vector stores in this repo.
- Supabase `documents` owns vector memory and retrieval context.
- `conversation_events` is the audit/log table for every LLM turn and escalation decision.
- Use `.env` as the authoritative secret store.
- All setup and run commands should work under the stable workflow names and paths.

## Supabase native vector schema checklists

- `documents` table:
  - `tenant_id`, `source_key`, `chunk_index`, `chunk_text`, `embedding vector(1536)`.
- `match_documents_with_context` function is used by the bot runtime for retrieval traceability.
- `tenant_settings` supports per-tenant guardrails and style tuning.

## Smoke tests (curl)

```bash
# 1) Knowledge upload
curl -s -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "tenant_id": "example-tenant",
    "source_key": "playbook-intro",
    "source_text": "{{COMPANY_NAME}} offers 24/7 Instagram support and automates response workflows for SMB accounts."
  }' \
  "https://<your-n8n-domain>/webhook/knowledge-upload"

# 2) Webhook verification challenge
curl -s "https://<your-n8n-domain>/webhook/instagram-webhook?hub.mode=subscribe&hub.challenge=verify-ok&hub.verify_token=$IG_VERIFY_TOKEN"

# 3) Simulate inbound IG message
curl -s -X POST \
  -H 'Content-Type: application/json' \
  -d '{
    "object":"instagram",
    "entry":[
      {
        "id":"example-tenant",
        "changes":[
          {
            "field":"messages",
            "value":{
              "messaging_product":"instagram",
              "messages":[
                {
                  "from":{"id":"user-id-123"},
                  "to":{"id":"biz-id-999"},
                  "mid":"mid.test.1",
                  "text":{"text":"What are your support hours?"},
                  "type":"text"
                }
              ],
              "from":{"id":"user-id-123"},
              "to":{"id":"biz-id-999"}
            }
          }
        ]
      }
    ]
  }' \
  "https://<your-n8n-domain>/webhook/instagram-webhook"
```

Checklist after each call:

- knowledge ingest should insert rows into `documents`.
- ask flow should insert:
  - one user row in `conversation_events`
  - one assistant row in `conversation_events`
  - one outbound HTTP call from `Send Instagram Reply` branch.

## Operational policy for future installs

- Preserve workflow names and path conventions exactly.
- Preserve canonical field names in logs (`tenant_id`, `thread_id`, `message_id`, `intent`).
- Never switch to a non-Supabase vector backend in this repository.

## Meta runtime behavior checklist

1. Workflow must be active before real webhook traffic.
2. Verify endpoint response for subscription is raw `hub.challenge`.
3. Confirm `tenant_id`/`thread_id` are inferred and not blank.
4. Confirm `IG_ACCESS_TOKEN` and `IG_INSTAGRAM_BUSINESS_ACCOUNT_ID` produce a 200 success from IG send branch.
5. Confirm escalation path writes `escalated=true` and uses fallback messaging.

## Verified smoke-test state - 2026-06-18

Validated on `https://<your-n8n-domain>`:

- Workflow `Demo: RAG in n8n` is active.
- Workflow `Knowledge Upload to Supabase` is active.
- Supabase Data API is reachable.
- Tables `public.documents`, `public.conversation_events`, and `public.tenant_settings` exist.
- RPCs `get_tenant_settings`, `get_thread_context`, `match_documents`, and `match_documents_with_context` return successfully.
- Knowledge upload smoke test inserted a document chunk into `public.documents`.
- Instagram webhook GET verification returned the expected challenge.
- Synthetic Instagram DM POST completed successfully in dry-run mode.
- Latest successful main execution ended at `Dry Run Handoff Reply`, proving normalization, classification, embedding creation, Supabase retrieval, escalation, and event logging are working.

Live Instagram sending is not enabled until all three are true:

- `IG_ACCESS_TOKEN` is set in `.env`.
- `IG_INSTAGRAM_BUSINESS_ACCOUNT_ID` is set in `.env`.
- `IG_ENABLE_LIVE_SEND=true` is set in `.env` and workflows are resynced.

After enabling live send, test with a real inbound Instagram DM event rather than a synthetic placeholder recipient ID.

## Instagram live-mode readiness note

Meta app Live/published mode is required, but it is not enough by itself. The Page access token used for webhook management must include `pages_manage_metadata` in addition to messaging permissions.

Current required Meta check before production DM testing:
- App Dashboard must have Instagram Webhooks subscribed for the messaging events used by this workflow.
- If managing subscription through Graph, regenerate/re-authorize a user/Page token with at least `pages_manage_metadata`, `pages_show_list`, `pages_messaging`, and `instagram_manage_messages`.
- If using the Dashboard setup tool, set the callback URL to the n8n production webhook and use the `IG_WEBHOOK_VERIFY_TOKEN` value from `.env`.

Do not commit Page tokens, user tokens, app secrets, Supabase service keys, or OpenAI keys.

## Escalation silence smoke test

1. Trigger or simulate a message that causes handoff/escalation.
2. Confirm Supabase `thread_states.status = 'escalated'` for the Instagram thread.
3. Send another DM in the same thread.
4. Confirm n8n ends at `Silent: Already Escalated` and sends no Instagram reply.
5. Reset the marker:

```sql
select public.reset_thread_escalation('demo', 'instagram', 'THREAD_ID', 'operator', 'ready for bot again');
```

6. Send another DM and confirm normal bot routing resumes.


## Autonomous regression gate

Run this before live Instagram or Telegram testing:

```bash
node scripts/internal-bot-regression-suite.mjs --thread local-regression
```

Expected result: `ok: true`. This validates sales behavior, USD pricing, multilingual answers, off-topic redirect, escalation silence, and operator reset without sending external channel replies.
