#!/usr/bin/env bash
set -euo pipefail
set -o pipefail

SKIP_IG=0
if [ "${1:-}" = "--skip-ig" ]; then
  SKIP_IG=1
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_cmd curl
require_cmd jq

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

if [ -z "${N8N_BASE_URL-}" ] || [ -z "${N8N_API_KEY-}" ]; then
  echo "MISSING_RUNTIME_VARIABLES"
  [ -z "${N8N_BASE_URL-}" ] && echo "- N8N_BASE_URL"
  [ -z "${N8N_API_KEY-}" ] && echo "- N8N_API_KEY"
  echo
  echo "Stop: fill missing variables in .env before activating workflows."
  exit 1
fi

N8N_RESPONSE="$(curl -sS -w '\n%{http_code}' -H "X-N8N-API-KEY: ${N8N_API_KEY}" "${N8N_BASE_URL%/}/api/v1/workflows?limit=1" || true)"
N8N_STATUS="$(printf '%s' "$N8N_RESPONSE" | tail -n 1)"
N8N_BODY="$(printf '%s' "$N8N_RESPONSE" | sed '$d')"

if [ "$N8N_STATUS" = "401" ] || [ "$N8N_STATUS" = "403" ]; then
  echo "N8N_API_KEY_INVALID"
  echo " - HTTP ${N8N_STATUS}"
  echo " - Body: ${N8N_BODY}"
  echo
  echo "Stop: provide a fresh n8n API key for ${N8N_BASE_URL}."
  exit 1
fi

if [ "$N8N_STATUS" != "200" ]; then
  echo "N8N_PRECHECK_FAILED"
  echo " - HTTP ${N8N_STATUS}"
  echo " - Body: ${N8N_BODY}"
  echo
  echo "Stop: n8n precheck did not pass."
  exit 1
fi

required_vars=(
  "N8N_BASE_URL"
  "N8N_API_KEY"
  "SUPABASE_ORG_SLUG"
  "SUPABASE_PROJECT_ID"
  "SUPABASE_REST_URL"
  "SUPABASE_PROJECT_PASSWORD"
  "SUPABASE_JWT_CURRENT_KEY"
  "SUPABASE_JWT_PREVIOUS_KEY"
  "SUPABASE_MATCH_COUNT"
  "SUPABASE_MIN_SIMILARITY"
  "RAG_CONFIDENCE_THRESHOLD"
  "OPENAI_API_KEY"
  "OPENAI_EMBEDDING_MODEL"
  "OPENAI_CHAT_MODEL"
  "IG_GRAPH_API_VERSION"
  "IG_MESSAGES_BASE_URL"
  "IG_APP_ID_1"
  "IG_APP_SECRET_1"
)

if [ "$SKIP_IG" -eq 0 ]; then
  required_vars+=(
    "IG_VERIFY_TOKEN"
    "IG_ACCESS_TOKEN"
    "IG_INSTAGRAM_BUSINESS_ACCOUNT_ID"
  )
fi

missing=()

for var in "${required_vars[@]}"; do
  if [ -z "${!var-}" ]; then
    missing+=("$var")
  fi
done

if [ -z "${SUPABASE_SECRET_KEY-}" ] && [ -z "${SUPABASE_PUBLISHABLE_KEY-}" ]; then
  missing+=("SUPABASE_SECRET_KEY or SUPABASE_PUBLISHABLE_KEY")
fi

if [ ${#missing[@]} -ne 0 ]; then
  echo "MISSING_RUNTIME_VARIABLES"
  for item in "${missing[@]}"; do
    echo "- ${item}"
  done
  echo
  echo "Stop: fill missing variables in .env before activating workflows."
  exit 1
fi

echo "Runtime preflight passed."
echo "N8N: $N8N_BASE_URL"
echo "Workflow project: $SUPABASE_PROJECT_ID"
echo "Tenant defaults: org=$SUPABASE_ORG_SLUG"
echo "IG app: $IG_APP_ID_1"
echo "Embedding model: $OPENAI_EMBEDDING_MODEL"
echo "Chat model: $OPENAI_CHAT_MODEL"
echo "RAG threshold: $RAG_CONFIDENCE_THRESHOLD (count=$SUPABASE_MATCH_COUNT, min_similarity=$SUPABASE_MIN_SIMILARITY)"
