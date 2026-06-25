#!/usr/bin/env bash
set -euo pipefail
set -o pipefail

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

: "${N8N_API_KEY:?Set N8N_API_KEY in .env}"
: "${N8N_BASE_URL:?Set N8N_BASE_URL in .env}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_cmd curl
require_cmd jq
require_cmd node

BASE_URL="${N8N_BASE_URL%/}"
API_URL="${BASE_URL}/api/v1/workflows"
AUTH=(-H "X-N8N-API-KEY: ${N8N_API_KEY}")

check_n8n_auth() {
  local response
  local status
  local body

  response="$(curl -sS -w '\n%{http_code}' "${AUTH[@]}" -H "Content-Type: application/json" "${BASE_URL}/api/v1/workflows?limit=1" || true)"
  status="$(printf '%s' "$response" | tail -n 1)"
  body="$(printf '%s' "$response" | sed '$d')"

  if [ "$status" = "000" ] || [ -z "$status" ]; then
    echo "FAILED: could not reach n8n at ${BASE_URL}." >&2
    return 1
  fi

  if [ "$status" = "401" ]; then
    local message
    message="$(printf '%s' "$body" | jq -r '.message // empty' 2>/dev/null || true)"
    if [ -z "$message" ]; then
      message="unauthorized"
    fi
    echo "FAILED: n8n unauthorized (HTTP 401). ${message}" >&2
    return 1
  fi

  if [ "$status" != "200" ]; then
    echo "FAILED: n8n API check returned HTTP ${status} for ${BASE_URL}." >&2
    echo "Response: ${body}" >&2
    return 1
  fi
}

list_workflows() {
  curl -sS "${AUTH[@]}" -H "Content-Type: application/json" "${API_URL}" \
    | jq '.data // []'
}

api_post_put() {
  local method="$1"
  local url="$2"
  local payload="${3-}"
  local response
  local http_code
  local payload_file

  if [[ -n "$payload" ]]; then
    payload_file="$(mktemp)"
    printf '%s' "$payload" > "$payload_file"
    response="$(curl -sS -w '\n%{http_code}' -X "$method" "${AUTH[@]}" -H "Content-Type: application/json" "$url" --data-binary "@${payload_file}")"
    rm -f "$payload_file"
  else
    response="$(curl -sS -w '\n%{http_code}' -X "$method" "${AUTH[@]}" -H "Content-Type: application/json" "$url")"
  fi
  http_code="$(printf '%s' "$response" | tail -n 1)"
  response="$(printf '%s' "$response" | sed '$d')"

  if [[ "$http_code" == "401" ]]; then
    echo "FAILED: n8n unauthorized (HTTP 401). Check N8N_API_KEY in .env." >&2
    return 1
  fi

  if [[ -z "$response" ]]; then
    echo "FAILED: empty response from n8n API (${method} ${url})." >&2
    return 1
  fi

  local message
  message="$(printf '%s' "$response" | jq -r '.message // empty' 2>/dev/null || true)"
  if [[ "$message" == "unauthorized" ]]; then
    echo "FAILED: n8n unauthorized response while calling ${method} ${url}." >&2
    return 1
  fi

  printf '%s' "$response"
}

upsert_workflow() {
  local file_path="$1"
  local workflow_json
  workflow_json="$(node scripts/render-runtime-workflow.js "${file_path}")"
  local name
  name="$(printf '%s' "$workflow_json" | jq -r '.name')"

  if [[ -z "$name" || "$name" == "null" ]]; then
    echo "Skipping ${file_path}: workflow name missing in JSON."
    return 1
  fi

  local payload
  payload="$(printf '%s' "$workflow_json" | jq '. + {settings:{executionOrder:"v1"}} | del(.id, .active, .versionId, .triggerCount, .createdAt, .updatedAt, .shared, .tags, .meta)')"

  local existing_id
  existing_id="$(list_workflows | jq -r --arg name "$name" '.[] | select(.name == $name) | .id' | head -n 1)"

  if [[ -n "$existing_id" && "$existing_id" != "null" ]]; then
    local update_response
    local updated_id
    update_response="$(api_post_put PUT "${API_URL}/${existing_id}" "${payload}")"
    updated_id="$(printf '%s' "$update_response" | jq -r '.id // empty')"
    if [[ -z "$updated_id" || "$updated_id" == "null" ]]; then
      echo "FAILED: unexpected response while updating ${name}: response did not include workflow id." >&2
      return 1
    fi
    echo "Updated: ${name} (${updated_id})"
  else
    local new_id
    local create_response
    create_response="$(api_post_put POST "${API_URL}" "${payload}")"
    new_id="$(printf '%s' "$create_response" | jq -r '.id // empty')"
    if [[ -z "$new_id" || "$new_id" == "null" ]]; then
      echo "FAILED: unexpected response while creating ${name}: response did not include workflow id." >&2
      return 1
    fi
    echo "Created: ${name} (${new_id})"
  fi
}

check_n8n_auth

upsert_workflow workflows/demo-rag-instagram-supabase.json
upsert_workflow workflows/knowledge-upload-to-supabase.json
upsert_workflow workflows/internal-rag-bot-test-harness.json
upsert_workflow workflows/telegram-rag-channel-adapter.json
upsert_workflow workflows/whatsapp-rag-channel-adapter.json
