#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$ROOT_DIR/deploy/systemd/multichannel-brain.service.in"
UNIT_NAME="${BRAIN_SYSTEMD_UNIT:-multichannel-brain.service}"
UNIT_PATH="/etc/systemd/system/$UNIT_NAME"
RUN_USER="${BRAIN_SERVICE_USER:-$(id -un)}"
RUN_GROUP="${BRAIN_SERVICE_GROUP:-$(id -gn)}"

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
