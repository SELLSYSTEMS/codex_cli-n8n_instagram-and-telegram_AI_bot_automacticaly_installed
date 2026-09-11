#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$ROOT_DIR/deploy/systemd/multichannel-brain.service.in"
UNIT_NAME="${BRAIN_SYSTEMD_UNIT:-multichannel-brain.service}"
UNIT_PATH="/etc/systemd/system/$UNIT_NAME"
RUN_USER="${BRAIN_SERVICE_USER:-multichannel-brain}"
RUN_GROUP="${BRAIN_SERVICE_GROUP:-$RUN_USER}"

if [[ "$RUN_USER" == "root" || "$RUN_GROUP" == "root" ]]; then
  echo "Refusing to install Brain with root runtime ownership" >&2
  exit 1
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

if [[ ! -f "$TEMPLATE" ]]; then
  echo "Missing systemd template: $TEMPLATE" >&2
  exit 1
fi

if [[ ! -f "$ROOT_DIR/.env" ]]; then
  echo "Missing runtime environment: $ROOT_DIR/.env" >&2
  exit 1
fi

if ! id "$RUN_USER" >/dev/null 2>&1; then
  echo "Brain service user does not exist: $RUN_USER" >&2
  exit 1
fi

if ! getent group "$RUN_GROUP" >/dev/null 2>&1; then
  echo "Brain service group does not exist: $RUN_GROUP" >&2
  exit 1
fi

for config_file in \
  "$ROOT_DIR/config/commercial-actions.default.json" \
  "$ROOT_DIR/config/model-routes.default.json"; do
  if [[ ! -f "$config_file" ]]; then
    echo "Missing public runtime config: $config_file" >&2
    exit 1
  fi
  chmod 0644 "$config_file"
  if ! runuser -u "$RUN_USER" -- test -r "$config_file"; then
    echo "Brain service user cannot read public runtime config: $config_file" >&2
    exit 1
  fi
done

# Router health and circuit state are mutable runtime data. Keep only this
# directory writable by the service and retain private file permissions.
runtime_state_dir="$ROOT_DIR/.runtime"
install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 0750 "$runtime_state_dir"
runtime_state_files=(
  "$runtime_state_dir/model-health.json"
  "$runtime_state_dir/model-circuit-state.json"
  "$runtime_state_dir/model-route-state.json"
  "$runtime_state_dir/model-routes-cache.json"
  "$runtime_state_dir/model-routes.json"
  "$runtime_state_dir/model-provider-routes.jsonl"
  "$runtime_state_dir/codex-model-routes.jsonl"
)
for runtime_file in "${runtime_state_files[@]}"; do
  if [[ -e "$runtime_file" ]]; then
    chown "$RUN_USER:$RUN_GROUP" "$runtime_file"
    chmod 0600 "$runtime_file"
  fi
done
if ! runuser -u "$RUN_USER" -- test -w "$runtime_state_dir"; then
  echo "Brain service user cannot write runtime state directory: $runtime_state_dir" >&2
  exit 1
fi

# Private tenant runtime is optional for the public template. When it is
# installed, grant the Brain service group access only to the exact runtime
# directories and files the process consumes; do not expose the rest of the
# private tree.
if [[ -d "$ROOT_DIR/.private/active" ]]; then
  private_runtime_dirs=(
    "$ROOT_DIR/.private"
    "$ROOT_DIR/.private/active"
    "$ROOT_DIR/.private/active/commercial"
    "$ROOT_DIR/.private/active/knowledge"
  )
  private_runtime_files=(
    "$ROOT_DIR/.private/active/commercial/commercial-actions.json"
    "$ROOT_DIR/.private/active/knowledge/company-brain.md"
    "$ROOT_DIR/.private/active/knowledge/runtime-consultative-sales-policy.md"
  )

  for private_dir in "${private_runtime_dirs[@]}"; do
    if [[ ! -d "$private_dir" ]]; then
      echo "Missing private runtime directory: $private_dir" >&2
      exit 1
    fi
    chgrp "$RUN_GROUP" "$private_dir"
    chmod 0750 "$private_dir"
  done

  for private_file in "${private_runtime_files[@]}"; do
    if [[ ! -f "$private_file" ]]; then
      echo "Missing private runtime file: $private_file" >&2
      exit 1
    fi
    chgrp "$RUN_GROUP" "$private_file"
    chmod 0640 "$private_file"
    if ! runuser -u "$RUN_USER" -- test -r "$private_file"; then
      echo "Brain service user cannot read private runtime file: $private_file" >&2
      exit 1
    fi
  done
fi

escape_sed() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

tmp_file="$(mktemp)"
trap 'rm -f "$tmp_file"' EXIT

sed \
  -e "s|@@ROOT_DIR@@|$(escape_sed "$ROOT_DIR")|g" \
  -e "s|@@RUN_USER@@|$(escape_sed "$RUN_USER")|g" \
  -e "s|@@RUN_GROUP@@|$(escape_sed "$RUN_GROUP")|g" \
  "$TEMPLATE" >"$tmp_file"

install -m 0644 "$tmp_file" "$UNIT_PATH"
systemctl daemon-reload
systemctl enable "$UNIT_NAME"
systemctl restart "$UNIT_NAME"

echo "Installed and started $UNIT_NAME"
