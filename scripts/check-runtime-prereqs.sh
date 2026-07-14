#!/usr/bin/env bash
set -euo pipefail
command -v node >/dev/null
command -v npm >/dev/null
command -v codex >/dev/null
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
test -n "${LOCAL_POSTGRES_URL:-${DATABASE_URL:-${POSTGRES_URL:-}}}"
printf 'runtime prerequisites ok\n'
