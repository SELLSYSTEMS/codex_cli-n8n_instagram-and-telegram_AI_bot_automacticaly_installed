#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

for command_name in node npm codex; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf "missing required command: %s\n" "$command_name" >&2
    exit 1
  }
done

node_major="$(node -p "process.versions.node.split('.')[0]")"
if (( node_major < 22 )); then
  printf "Node.js 22 or newer is required; found %s\n" "$(node --version)" >&2
  exit 1
fi

if [[ -z "${LOCAL_POSTGRES_URL:-}" ]]; then
  printf "LOCAL_POSTGRES_URL is required; legacy database URL aliases are not accepted.\n" >&2
  exit 1
fi

case "$LOCAL_POSTGRES_URL" in
  postgres://*|postgresql://*) ;;
  *)
    printf "LOCAL_POSTGRES_URL must use postgres:// or postgresql://.\n" >&2
    exit 1
    ;;
esac

printf "runtime prerequisites ok: node=%s npm=%s codex=%s database=LOCAL_POSTGRES_URL\n" \
  "$(node --version)" "$(npm --version)" "$(codex --version | head -n 1)"
