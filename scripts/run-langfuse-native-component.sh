#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime/langfuse"
STATE_DIR="$RUNTIME_DIR/state"
set -a
# shellcheck disable=SC1091
source "$ROOT_DIR/.env"
set +a

component="${1:?component is required}"

run_extracted_node() {
  local root="$1"
  local prisma_engine
  shift

  prisma_engine="$(find "$root/app" -type f -name 'libquery_engine-linux-musl-openssl-3.0.x.so.node' -print -quit)"
  if [[ -n "$prisma_engine" ]]; then
    export PRISMA_QUERY_ENGINE_LIBRARY="$prisma_engine"
  fi

  cd "$root/app"
  exec "$root/lib/ld-musl-x86_64.so.1" \
    --library-path "$root/lib:$root/usr/lib:$root/usr/local/lib" \
    "$root/usr/local/bin/node" "$@"
}

: "${LANGFUSE_DATABASE_URL:?LANGFUSE_DATABASE_URL is required}"
export DATABASE_URL="$LANGFUSE_DATABASE_URL"
export DIRECT_URL="${LANGFUSE_DIRECT_URL:-$LANGFUSE_DATABASE_URL}"
export SALT="$LANGFUSE_SALT"
export ENCRYPTION_KEY="$LANGFUSE_ENCRYPTION_KEY"
export NEXTAUTH_URL="${LANGFUSE_PUBLIC_URL:-$LANGFUSE_BASE_URL}"
export NEXTAUTH_SECRET="$LANGFUSE_AUTH_SECRET"
export AUTH_SECRET="$LANGFUSE_AUTH_SECRET"
export TELEMETRY_ENABLED="false"
export LANGFUSE_ENABLE_EXPERIMENTAL_FEATURES="false"
export CLICKHOUSE_MIGRATION_URL="clickhouse://${LANGFUSE_CLICKHOUSE_USER}:${LANGFUSE_CLICKHOUSE_PASSWORD}@127.0.0.1:9002/default"
export CLICKHOUSE_URL="http://127.0.0.1:8123"
export CLICKHOUSE_USER="$LANGFUSE_CLICKHOUSE_USER"
export CLICKHOUSE_PASSWORD="$LANGFUSE_CLICKHOUSE_PASSWORD"
export CLICKHOUSE_CLUSTER_ENABLED="false"
export REDIS_HOST="127.0.0.1"
export REDIS_PORT="6379"
export REDIS_AUTH="$LANGFUSE_REDIS_PASSWORD"
export REDIS_TLS_ENABLED="false"
export LANGFUSE_S3_EVENT_UPLOAD_BUCKET="$LANGFUSE_MINIO_BUCKET"
export LANGFUSE_S3_EVENT_UPLOAD_REGION="auto"
export LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID="$LANGFUSE_MINIO_ROOT_USER"
export LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY="$LANGFUSE_MINIO_ROOT_PASSWORD"
export LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT="http://127.0.0.1:9000"
export LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE="true"
export LANGFUSE_S3_EVENT_UPLOAD_PREFIX="events/"
export LANGFUSE_S3_MEDIA_UPLOAD_BUCKET="$LANGFUSE_MINIO_BUCKET"
export LANGFUSE_S3_MEDIA_UPLOAD_REGION="auto"
export LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID="$LANGFUSE_MINIO_ROOT_USER"
export LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY="$LANGFUSE_MINIO_ROOT_PASSWORD"
export LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT="http://127.0.0.1:9000"
export LANGFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE="true"
export LANGFUSE_S3_MEDIA_UPLOAD_PREFIX="media/"
export LANGFUSE_S3_BATCH_EXPORT_ENABLED="false"
export NODE_ENV="production"
export CHECKPOINT_DISABLE="1"
export PRISMA_HIDE_UPDATE_MESSAGE="1"

export PORT="${LANGFUSE_PORT:-8110}"
export HOSTNAME="${LANGFUSE_HOSTNAME:-0.0.0.0}"

case "$component" in
  clickhouse)
    CLICKHOUSE_ROOT="$RUNTIME_DIR/clickhouse"
    CLICKHOUSE_DATA="$CLICKHOUSE_ROOT/var/lib/clickhouse"
    CLICKHOUSE_LOG="$CLICKHOUSE_ROOT/var/log/clickhouse-server"
    mkdir -p "$CLICKHOUSE_DATA/tmp" "$CLICKHOUSE_DATA/user_files" "$CLICKHOUSE_DATA/format_schemas" "$CLICKHOUSE_LOG"
    exec "$CLICKHOUSE_ROOT/usr/bin/clickhouse" server \
      --config-file="$CLICKHOUSE_ROOT/etc/clickhouse-server/config.xml" -- \
      --path="$CLICKHOUSE_DATA/" \
      --tmp_path="$CLICKHOUSE_DATA/tmp/" \
      --user_files_path="$CLICKHOUSE_DATA/user_files/" \
      --format_schema_path="$CLICKHOUSE_DATA/format_schemas/" \
      --logger.log="$CLICKHOUSE_LOG/clickhouse-server.log" \
      --logger.errorlog="$CLICKHOUSE_LOG/clickhouse-server.err.log" \
      --users_config="$CLICKHOUSE_ROOT/etc/clickhouse-server/users.xml" \
      --listen_host=127.0.0.1 \
      --http_port=8123 \
      --tcp_port=9002 \
      --interserver_http_port=9010 \
      --logger.console=1
    ;;
  redis)
    exec chroot "$RUNTIME_DIR/redis" /usr/local/bin/redis-server \
      --bind 127.0.0.1 --protected-mode yes --port 6379 --dir /data \
      --appendonly yes --requirepass "$LANGFUSE_REDIS_PASSWORD"
    ;;
  minio)
    export MINIO_ROOT_USER="$LANGFUSE_MINIO_ROOT_USER"
    export MINIO_ROOT_PASSWORD="$LANGFUSE_MINIO_ROOT_PASSWORD"
    exec "$RUNTIME_DIR/minio/usr/bin/minio" server "$STATE_DIR/minio" \
      --address 127.0.0.1:9000 --console-address 127.0.0.1:9001
    ;;
  web)
    run_extracted_node "$RUNTIME_DIR/web" \
      "$RUNTIME_DIR/web/app/web/server.js" --keepAliveTimeout 110000
    ;;
  worker)
    run_extracted_node "$RUNTIME_DIR/worker" \
      "$RUNTIME_DIR/worker/app/worker/dist/index.js"
    ;;
  *)
    echo "Unknown component: $component" >&2
    exit 64
    ;;
esac
