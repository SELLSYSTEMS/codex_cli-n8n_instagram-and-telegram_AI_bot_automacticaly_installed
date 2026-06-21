# OpenClaw/Codex one-shot bootstrap prompt

Use this exact onboarding prompt structure for future AI agents:

> You are an automation setup agent. Your objective is to create a reproducible Instagram DM RAG assistant in `/path/to/your/workspace` using files in this repo and local `.env`.

### Deterministic bootstrap contract

1. Keep all secrets only in `.env` and do not write real values to tracked files.
2. Keep workflow names stable:
   - `Demo: RAG in n8n`
   - `Knowledge Upload to Supabase`
3. Keep webhook paths stable:
   - `https://<your-n8n-domain>/webhook/instagram-webhook`
   - `https://<your-n8n-domain>/webhook/knowledge-upload`
4. Use Supabase-native pgvector only for memory/retrieval.
5. Do not introduce AWS/S3 vector wrappers.
6. Activate production message flow only after the webhook challenge succeeds.
7. Keep `.env` entries local; `.env` must be in `.gitignore`.
8. Keep local install state in `.obsidian/SESSION_MEMORY.md` (repo-local only, ignored).

### Required environment bootstrap

```bash
set -a
source .env
set +a

./scripts/sync-workflows.sh
```

Then run this preflight and stop on first missing value:

```bash
for var in \
  N8N_BASE_URL \
  N8N_API_KEY \
  SUPABASE_ORG_SLUG \
  SUPABASE_PROJECT_ID \
  SUPABASE_REST_URL \
  SUPABASE_SECRET_KEY \
  SUPABASE_PROJECT_PASSWORD \
  SUPABASE_JWT_CURRENT_KEY \
  SUPABASE_MATCH_COUNT \
  SUPABASE_MIN_SIMILARITY \
  RAG_CONFIDENCE_THRESHOLD \
  OPENAI_API_KEY \
  OPENAI_EMBEDDING_MODEL \
  OPENAI_CHAT_MODEL \
  IG_VERIFY_TOKEN \
  IG_ACCESS_TOKEN \
  IG_GRAPH_API_VERSION \
  IG_MESSAGES_BASE_URL \
  IG_INSTAGRAM_BUSINESS_ACCOUNT_ID \
  IG_APP_ID_1 \
  IG_APP_SECRET_1; do
  if [ -z "${!var:-}" ]; then
    echo "MISSING: $var"
    exit 1
  fi
done
echo "preflight-ok"
```

### Required `.env` keys

- N8N
  - `N8N_BASE_URL`
  - `N8N_API_KEY`
- Supabase
  - `SUPABASE_ORG_SLUG`
  - `SUPABASE_PROJECT_ID`
  - `SUPABASE_PROJECT_PASSWORD`
  - `SUPABASE_REST_URL`
  - `SUPABASE_PUBLISHABLE_KEY` or `SUPABASE_SECRET_KEY` (secret preferred)
  - `SUPABASE_JWT_CURRENT_KEY`
  - `SUPABASE_JWT_PREVIOUS_KEY`
  - `SUPABASE_MATCH_COUNT`
  - `SUPABASE_MIN_SIMILARITY`
  - `RAG_CONFIDENCE_THRESHOLD`
- OpenAI
  - `OPENAI_API_KEY`
  - `OPENAI_EMBEDDING_MODEL`
  - `OPENAI_CHAT_MODEL`
- Instagram
  - `IG_VERIFY_TOKEN`
  - `IG_ACCESS_TOKEN`
  - `IG_GRAPH_API_VERSION`
  - `IG_MESSAGES_BASE_URL`
  - `IG_MESSAGES_ENDPOINT` (optional override; defaults to `v{IG_GRAPH_API_VERSION}/{IG_INSTAGRAM_BUSINESS_ACCOUNT_ID}/messages`)
  - `IG_INSTAGRAM_BUSINESS_ACCOUNT_ID`
  - `IG_APP_ID_1`
  - `IG_APP_SECRET_1`
  - `IG_APP_ID_2`
  - `IG_APP_SECRET_2` (optional secondary app)
- `IG_CLIENT_TOKEN` (optional when app requires it)
  - `IG_CLIENT_TOKEN` and optional secondary app pair are explicitly optional. Do not fail bootstrap on missing values.

### Research clarifications for this repository

- For this workflow, use Graph messaging endpoint format:
  - `{{IG_MESSAGES_BASE_URL}}/{{IG_GRAPH_API_VERSION}}/{{IG_INSTAGRAM_BUSINESS_ACCOUNT_ID}}/messages`
- Do not use Facebook Conversions API for RAG DM reply path.
- Do not introduce AWS/S3/Vector wrappers; pgvector-native retrieval functions are the single memory source.

### Activation gate

- Never activate `Demo: RAG in n8n` until all required keys are present and the Meta webhook GET verification challenge works.
- Keep `Knowledge Upload to Supabase` inactive until knowledge ingestion is explicitly requested.

### Smoke test sequence

1. run `curl` challenge for webhook GET verification challenge:
   - expect raw `hub.challenge` when mode=`subscribe`.
2. run one knowledge-upload test:
   - verify row inserted in `public.documents`.
3. run one simulated inbound IG payload:
   - verify `public.conversation_events` has both user and assistant rows.
4. confirm one outbound send call path returns success-like message.

### Credentials still needed for production

- `N8N_API_KEY`
- `SUPABASE_SECRET_KEY` (or publishable key for test)
- `SUPABASE_PROJECT_PASSWORD`
- `SUPABASE_JWT_CURRENT_KEY`
- `OPENAI_API_KEY`
- `IG_VERIFY_TOKEN`
- `IG_ACCESS_TOKEN`
- `IG_INSTAGRAM_BUSINESS_ACCOUNT_ID`
- `IG_APP_ID_1`/`IG_APP_SECRET_1`

### Operational acceptance

- `docs/architecture.md`, `schemas/supabase.sql`, and both workflow JSON files are present and synced.
- `runbook` smoke checks pass with `conversation_events` writes.
- No secret values are committed to git.
- Workflow labels and node paths remain stable for OpenClaw reinstallers.

### Project anchors to preserve across agents

- GitHub repo: `<your-github-owner>/<your-repo-name>`
- n8n domain: `https://<your-n8n-domain>`
- Supabase project URL: `https://<your-project-ref>.supabase.co`
- Supabase project id/ref: `<your-supabase-project-ref>`
- Supabase region: `us-west-2`
- Instagram app label: `NDRD_i+api-IG`
