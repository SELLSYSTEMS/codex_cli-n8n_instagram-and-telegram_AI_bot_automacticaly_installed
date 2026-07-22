#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
RUNTIME_DIR="$ROOT_DIR/.runtime/langfuse"
STATE_DIR="$RUNTIME_DIR/state"

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Run as root: sudo $0" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is required to extract official Langfuse images" >&2; exit 1; }
command -v psql >/dev/null || { echo "postgresql-client is required" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
mkdir -p "$RUNTIME_DIR" "$STATE_DIR/minio"

env_has() { grep -qE "^$1=" "$ENV_FILE"; }
env_add() { env_has "$1" || printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; }
hex() { openssl rand -hex "$1"; }

env_add LANGFUSE_ENABLED true
env_add LANGFUSE_BASE_URL http://127.0.0.1:8110
env_add LANGFUSE_PUBLIC_URL "${LANGFUSE_PUBLIC_URL:-${LANGFUSE_BASE_URL:-http://127.0.0.1:8110}}"
env_add LANGFUSE_PORT "${LANGFUSE_PORT:-8110}"
env_add LANGFUSE_POSTGRES_USER langfuse
env_add LANGFUSE_POSTGRES_PASSWORD "$(hex 24)"
env_add LANGFUSE_POSTGRES_DB langfuse
env_add LANGFUSE_CLICKHOUSE_USER default
env_add LANGFUSE_CLICKHOUSE_PASSWORD "$(hex 24)"
env_add LANGFUSE_REDIS_PASSWORD "$(hex 24)"
env_add LANGFUSE_MINIO_ROOT_USER langfuse
env_add LANGFUSE_MINIO_ROOT_PASSWORD "$(hex 24)"
env_add LANGFUSE_MINIO_BUCKET langfuse
env_add LANGFUSE_INIT_ORG_ID local-org
env_add LANGFUSE_INIT_ORG_NAME Local
env_add LANGFUSE_INIT_PROJECT_ID local-brain
env_add LANGFUSE_INIT_PROJECT_NAME Brain
env_add LANGFUSE_INIT_PROJECT_PUBLIC_KEY "pk-lf-$(hex 16)"
env_add LANGFUSE_INIT_PROJECT_SECRET_KEY "sk-lf-$(hex 24)"
env_add LANGFUSE_INIT_USER_EMAIL admin@example.com
env_add LANGFUSE_INIT_USER_NAME LocalAdmin
env_add LANGFUSE_INIT_USER_PASSWORD "$(hex 18)"
env_add LANGFUSE_SALT "$(hex 32)"
env_add LANGFUSE_ENCRYPTION_KEY "$(hex 32)"
env_add LANGFUSE_AUTH_SECRET "$(hex 32)"
env_add LANGFUSE_TELEMETRY_ENABLED false

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

env_add LANGFUSE_PUBLIC_KEY "$LANGFUSE_INIT_PROJECT_PUBLIC_KEY"
env_add LANGFUSE_SECRET_KEY "$LANGFUSE_INIT_PROJECT_SECRET_KEY"

for value in LANGFUSE_POSTGRES_USER LANGFUSE_POSTGRES_DB; do
  [[ ${!value} =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "$value must be a simple PostgreSQL identifier" >&2; exit 1; }
done
for value in LANGFUSE_POSTGRES_PASSWORD LANGFUSE_CLICKHOUSE_PASSWORD LANGFUSE_REDIS_PASSWORD LANGFUSE_MINIO_ROOT_USER LANGFUSE_MINIO_ROOT_PASSWORD; do
  [[ ${!value} =~ ^[A-Za-z0-9_-]+$ ]] || { echo "$value must contain only A-Z, a-z, 0-9, _ or -" >&2; exit 1; }
done

extract_image() {
  local image="$1" destination="$2" marker="$2/.extracted-image"
  [[ -f "$marker" ]] && return 0
  docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
  local cid
  cid="$(docker create "$image")"
  rm -rf "$destination"
  mkdir -p "$destination"
  if ! docker export "$cid" | tar -x -C "$destination"; then
    docker rm "$cid" >/dev/null
    return 1
  fi
  docker rm "$cid" >/dev/null
  printf '%s\n' "$image" > "$marker"
}

extract_image "${LANGFUSE_WEB_IMAGE:-langfuse/langfuse:3}" "$RUNTIME_DIR/web"
extract_image "${LANGFUSE_WORKER_IMAGE:-langfuse/langfuse-worker:3}" "$RUNTIME_DIR/worker"
extract_image "${LANGFUSE_CLICKHOUSE_IMAGE:-clickhouse/clickhouse-server:24.12}" "$RUNTIME_DIR/clickhouse"
extract_image "${LANGFUSE_REDIS_IMAGE:-redis:7.2-alpine}" "$RUNTIME_DIR/redis"
extract_image "${LANGFUSE_MINIO_IMAGE:-minio/minio:latest}" "$RUNTIME_DIR/minio"

# Prisma launches a bare `node` executable while applying migrations. The
# official image only exposes Node under /usr/local/bin, so provide the
# conventional /usr/bin entrypoint inside both extracted chroots.
mkdir -p "$RUNTIME_DIR/web/usr/bin" "$RUNTIME_DIR/worker/usr/bin"
ln -sfn /usr/local/bin/node "$RUNTIME_DIR/web/usr/bin/node"
ln -sfn /usr/local/bin/node "$RUNTIME_DIR/worker/usr/bin/node"

mkdir -p "$RUNTIME_DIR/redis/data" "$RUNTIME_DIR/clickhouse/etc/clickhouse-server/users.d"
mkdir -p "$RUNTIME_DIR/clickhouse/var/lib/clickhouse" "$RUNTIME_DIR/clickhouse/var/log/clickhouse-server"
# Docker image extraction preserves the image's numeric clickhouse UID. On an
# LXD host that UID may map to an unrelated local user, and ClickHouse refuses
# to run when the data owner differs from the systemd service user (root).
chown -R root:root "$RUNTIME_DIR/clickhouse/var/lib/clickhouse" "$RUNTIME_DIR/clickhouse/var/log/clickhouse-server"

prepare_chroot_runtime() {
  local rootfs="$1"
  install -d -m 0755 "$rootfs/etc"
  for host_file in resolv.conf hosts nsswitch.conf; do
    if [[ -e "/etc/$host_file" ]]; then
      cp -L "/etc/$host_file" "$rootfs/etc/$host_file"
    fi
  done
}

for component in clickhouse redis web worker; do
  prepare_chroot_runtime "$RUNTIME_DIR/$component"
done

cat > "$RUNTIME_DIR/clickhouse/etc/clickhouse-server/users.d/langfuse.xml" <<EOF
<clickhouse>
  <users>
    <default>
      <password>${LANGFUSE_CLICKHOUSE_PASSWORD}</password>
      <networks><ip>::/0</ip></networks>
      <access_management>1</access_management>
    </default>
  </users>
</clickhouse>
EOF

if ! command -v mc >/dev/null; then
  curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc
  chmod 755 /usr/local/bin/mc
fi

role_exists="$(runuser -u postgres -- psql -Atqc "select 1 from pg_roles where rolname='${LANGFUSE_POSTGRES_USER}'")"
if [[ "$role_exists" != 1 ]]; then
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c "create role \"${LANGFUSE_POSTGRES_USER}\" login password '${LANGFUSE_POSTGRES_PASSWORD}'"
else
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c "alter role \"${LANGFUSE_POSTGRES_USER}\" password '${LANGFUSE_POSTGRES_PASSWORD}'"
fi
db_exists="$(runuser -u postgres -- psql -Atqc "select 1 from pg_database where datname='${LANGFUSE_POSTGRES_DB}'")"
if [[ "$db_exists" != 1 ]]; then
  runuser -u postgres -- createdb --owner "$LANGFUSE_POSTGRES_USER" "$LANGFUSE_POSTGRES_DB"
fi

write_unit() {
  local component="$1" after="$2" requires="$3"
  cat > "/etc/systemd/system/langfuse-native-${component}.service" <<EOF
[Unit]
Description=Local Langfuse ${component}
After=${after}
Requires=${requires}

[Service]
Type=simple
WorkingDirectory=${ROOT_DIR}
ExecStart=${ROOT_DIR}/scripts/run-langfuse-native-component.sh ${component}
Restart=on-failure
RestartSec=3
TimeoutStartSec=0
LimitNOFILE=262144

[Install]
WantedBy=multi-user.target
EOF
}

write_unit clickhouse network.target network.target
write_unit redis network.target network.target
write_unit minio network.target network.target
write_unit web "postgresql.service langfuse-native-clickhouse.service langfuse-native-redis.service langfuse-native-minio.service" "langfuse-native-clickhouse.service langfuse-native-redis.service langfuse-native-minio.service"
write_unit worker "postgresql.service langfuse-native-web.service" "langfuse-native-web.service"
systemctl daemon-reload
systemctl enable langfuse-native-clickhouse.service langfuse-native-redis.service langfuse-native-minio.service langfuse-native-web.service langfuse-native-worker.service >/dev/null
echo "Native Langfuse runtime installed."
