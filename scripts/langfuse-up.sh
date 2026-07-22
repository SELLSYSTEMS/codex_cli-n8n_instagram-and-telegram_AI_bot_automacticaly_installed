#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
RUNTIME_DIR="${ROOT_DIR}/.runtime/langfuse"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}" >&2
  exit 1
fi

if ! systemctl cat langfuse-native-web.service >/dev/null 2>&1; then
  "${ROOT_DIR}/scripts/install-langfuse-native.sh"
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

REDIS_AUTH="${LANGFUSE_REDIS_AUTH:-${LANGFUSE_REDIS_PASSWORD:-}}"
if [[ -z "${REDIS_AUTH}" ]]; then
  echo "LANGFUSE_REDIS_PASSWORD is required" >&2
  exit 1
fi

wait_http() {
  local name="$1"
  local url="$2"
  local attempts="$3"
  local auth="${4:-}"
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if [[ -n "${auth}" ]]; then
      if curl -fsS --max-time 4 -u "${auth}" "${url}" >/dev/null 2>&1; then
        return 0
      fi
    elif curl -fsS --max-time 4 "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "${name} did not become healthy: ${url}" >&2
  return 1
}

systemctl start langfuse-native-clickhouse.service
systemctl start langfuse-native-redis.service
systemctl start langfuse-native-minio.service

wait_http "ClickHouse" "http://127.0.0.1:8123/ping" 60 "${LANGFUSE_CLICKHOUSE_USER}:${LANGFUSE_CLICKHOUSE_PASSWORD}" || {
  journalctl -u langfuse-native-clickhouse.service -n 120 --no-pager >&2
  exit 1
}
wait_http "MinIO" "http://127.0.0.1:9000/minio/health/live" 60 || {
  journalctl -u langfuse-native-minio.service -n 120 --no-pager >&2
  exit 1
}

for _ in $(seq 1 60); do
  if chroot "${RUNTIME_DIR}/redis" /usr/local/bin/redis-cli \
    -h 127.0.0.1 -p 6379 -a "${REDIS_AUTH}" --no-auth-warning ping 2>/dev/null | rg -q '^PONG$'; then
    break
  fi
  sleep 1
done
if ! chroot "${RUNTIME_DIR}/redis" /usr/local/bin/redis-cli \
  -h 127.0.0.1 -p 6379 -a "${REDIS_AUTH}" --no-auth-warning ping 2>/dev/null | rg -q '^PONG$'; then
  journalctl -u langfuse-native-redis.service -n 120 --no-pager >&2
  exit 1
fi

MC_BIN="${RUNTIME_DIR}/bin/mc"
if [[ ! -x "${MC_BIN}" ]]; then
  mkdir -p "$(dirname "${MC_BIN}")"
  curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o "${MC_BIN}"
  chmod 0755 "${MC_BIN}"
fi
"${MC_BIN}" alias set langfuse-local http://127.0.0.1:9000 \
  "${LANGFUSE_MINIO_ROOT_USER}" "${LANGFUSE_MINIO_ROOT_PASSWORD}" >/dev/null
"${MC_BIN}" mb --ignore-existing "langfuse-local/${LANGFUSE_MINIO_BUCKET}" >/dev/null

systemctl start langfuse-native-web.service
if ! wait_http "Langfuse web" "http://127.0.0.1:${LANGFUSE_PORT:-8110}/api/public/health" 150; then
  journalctl -u langfuse-native-web.service -n 180 --no-pager >&2
  exit 1
fi

systemctl start langfuse-native-worker.service
sleep 3
for unit in clickhouse redis minio web worker; do
  if ! systemctl is-active --quiet "langfuse-native-${unit}.service"; then
    journalctl -u "langfuse-native-${unit}.service" -n 180 --no-pager >&2
    exit 1
  fi
done

echo "Langfuse is healthy at ${LANGFUSE_BASE_URL:-http://127.0.0.1:${LANGFUSE_PORT:-8110}}"
