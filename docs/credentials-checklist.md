# Runtime credentials checklist

Use this file as the single source of truth for onboarding credentials for this repo.

## Required before activating `Demo: RAG in n8n`

- `N8N_API_KEY`
  - Admin/API token from your n8n instance.
- `SUPABASE_SECRET_KEY` (preferred) or `SUPABASE_PUBLISHABLE_KEY`
  - Supabase API key for table/RPC writes.
- `SUPABASE_PROJECT_PASSWORD`
  - Password for `postgres` connection string (`postgresql://postgres:...`).
- `SUPABASE_JWT_CURRENT_KEY`
- `SUPABASE_JWT_PREVIOUS_KEY`
  - Required for JWT key rotation support.
- `IG_VERIFY_TOKEN`
  - Value sent by Meta in `hub.verify_token` during webhook challenge.
- `IG_ACCESS_TOKEN`
  - Instagram Messaging API access token with messaging permissions for your business account.
- `IG_INSTAGRAM_BUSINESS_ACCOUNT_ID`
  - IG business account ID used in send endpoint path.
- `IG_APP_ID_1` and `IG_APP_SECRET_1`
  - Primary app credentials used for Meta app context.
- `OPENAI_API_KEY`
  - Required for embeddings + completions.

## Required constants / non-secret values

- `N8N_BASE_URL=https://<your-n8n-domain>`
- `SUPABASE_ORG_SLUG=xpfdvfkwzqvmwfxmcqrr`
- `SUPABASE_PROJECT_ID=<your-supabase-project-ref>`
- `SUPABASE_REST_URL=https://<your-project-ref>.supabase.co/rest/v1`
- `IG_MESSAGES_BASE_URL=https://graph.instagram.com`
- `IG_GRAPH_API_VERSION=v21.0`

## Optional but recommended

- `IG_APP_NAME` (label; non-secret)
- `IG_CLIENT_TOKEN`
- `IG_APP_ID_2`, `IG_APP_SECRET_2` (failover app pair)
- `SUPABASE_MATCH_COUNT`
- `SUPABASE_MIN_SIMILARITY`
- `RAG_CONFIDENCE_THRESHOLD`

## Research-backed clarifications

- This repo’s reply path is Graph API send for Instagram DMs:  
  `{{IG_MESSAGES_BASE_URL}}/{{IG_GRAPH_API_VERSION}}/{{IG_INSTAGRAM_BUSINESS_ACCOUNT_ID}}/messages`
- Meta webhook verification behavior is `hub.mode=subscribe` + `hub.verify_token` + raw `hub.challenge`.
- The Instagram Conversions API (`ads-commerce/conversions-api`) is separate and **not required** for this DM flow.
- S3/vector-wrapper extensions are intentionally not used. `public.documents` + pgvector RPCs are the canonical retrieval path.

## One command validation before deploy

```bash
./scripts/check-runtime-prereqs.sh
./scripts/check-runtime-prereqs.sh --skip-ig
```

`./scripts/check-runtime-prereqs.sh` now validates:
- n8n key + base URL connectivity (must return HTTP 200),
- required variables (or skips IG variables with `--skip-ig`),
- Supabase/OpenAI keys required by this repo.

If it prints `MISSING_RUNTIME_VARIABLES` or `N8N_API_KEY_INVALID`, do not activate workflow until those are fixed.

## Quick security rule

- Keep all secret values in local `.env` only.
- `.env` is ignored by git via `.gitignore`.
- No AWS/S3 vector wrappers are part of this architecture.
