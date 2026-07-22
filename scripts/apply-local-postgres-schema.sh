#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
set -a
. "$ROOT/.env"
set +a
: "$LOCAL_POSTGRES_URL"
psql "$LOCAL_POSTGRES_URL" -v ON_ERROR_STOP=1 -f "$ROOT/schemas/local-postgres-brain.sql"
printf '%s\n' "Local PostgreSQL agent schema applied."
