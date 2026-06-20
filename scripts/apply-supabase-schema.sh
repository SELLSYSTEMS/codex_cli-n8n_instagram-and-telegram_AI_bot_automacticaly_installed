#!/usr/bin/env bash
set -euo pipefail
set -o pipefail

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

: "${SUPABASE_DIRECT_CONNECTION_URL:?Set SUPABASE_DIRECT_CONNECTION_URL in .env}"
: "${SUPABASE_PROJECT_PASSWORD:?Set SUPABASE_PROJECT_PASSWORD in .env}"

SCHEMA_FILE="${1:-schemas/supabase.sql}"

if [ ! -f "$SCHEMA_FILE" ]; then
  echo "SCHEMA_FILE_NOT_FOUND: ${SCHEMA_FILE}" >&2
  exit 1
fi

attempt_with_npx_supabase() {
  local db_url="$1"
  echo "Trying: npx supabase db query --db-url \"${db_url}\" ... "
  if npx --yes supabase db query --db-url "$db_url" \
    --file "$SCHEMA_FILE" >/tmp/supabase-schema-apply.log 2>&1; then
    echo "supabase-cli-schema-apply-ok"
    return 0
  fi
  echo "supabase-cli-schema-apply-failed"
}

attempt_with_psql() {
  if ! command -v psql >/dev/null 2>&1; then
    return 1
  fi

  local host_url="$1"
  echo "Trying: psql \"${host_url}\""
  if psql "$host_url" -f "$SCHEMA_FILE" >/tmp/psql-schema-apply.log 2>&1; then
    echo "psql-schema-apply-ok"
    return 0
  fi
  echo "psql-schema-apply-failed"
}

RESULT=""
if RESULT="$(attempt_with_npx_supabase "$SUPABASE_DIRECT_CONNECTION_URL")"; then
  if [[ "$RESULT" == "supabase-cli-schema-apply-ok" ]]; then
    echo "Supabase schema applied from local SQL file."
    exit 0
  fi
fi

if [[ "$RESULT" == "supabase-cli-schema-apply-failed" ]]; then
  if [[ -f /tmp/supabase-schema-apply.log ]]; then
    echo "supabase-cli output (last 30 lines):"
    tail -n 30 /tmp/supabase-schema-apply.log
  fi
fi

if RESULT="$(attempt_with_psql "$SUPABASE_DIRECT_CONNECTION_URL" )"; then
  if [[ "$RESULT" == "psql-schema-apply-ok" ]]; then
    echo "Supabase schema applied via psql."
    exit 0
  fi
fi

if [[ "$RESULT" == "psql-schema-apply-failed" ]] && [[ -f /tmp/psql-schema-apply.log ]]; then
  echo "psql output (last 30 lines):"
  tail -n 30 /tmp/psql-schema-apply.log
fi

cat <<EOF
Automatic SQL application failed from this machine.
Apply the SQL manually in Supabase SQL Editor with these steps:

1) Open https://app.supabase.com/project/mqyqmudbyypnxhwwkisc/sql/new
2) Paste the content of ${SCHEMA_FILE}
3) Run query
4) Confirm tables/RPCs exist:
   - public.documents
   - public.conversation_events
   - public.tenant_settings
   - public.match_documents
   - public.match_documents_with_context
   - public.get_tenant_settings
   - public.get_thread_context

EXIT=1
EOF
exit 1
