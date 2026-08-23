#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${BRAIN_ENV_FILE:-$ROOT_DIR/.env}"
PID_FILE="${BRAIN_PID_FILE:-$ROOT_DIR/.runtime/brain-service.pid}"
LOG_FILE="${BRAIN_LOG_FILE:-$ROOT_DIR/.runtime/brain-service.log}"
SYSTEMD_UNIT="${BRAIN_SYSTEMD_UNIT:-multichannel-brain.service}"
HOST="${BRAIN_HOST:-127.0.0.1}"
PORT="${BRAIN_PORT:-8789}"
HEALTH_URL="${BRAIN_HEALTH_URL:-http://$HOST:$PORT/health}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"

has_systemd_unit() {
  command -v systemctl >/dev/null 2>&1 &&
    systemctl cat "$SYSTEMD_UNIT" >/dev/null 2>&1
}

is_healthy() {
  curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1
}

wait_for_health() {
  local attempt
  for attempt in $(seq 1 60); do
    if is_healthy; then
      return 0
    fi
    sleep 1
  done
  echo "Brain service did not become healthy at $HEALTH_URL" >&2
  return 1
}

systemd_main_pid() {
  systemctl show "$SYSTEMD_UNIT" --property=MainPID --value 2>/dev/null || true
}

discover_standalone_pid() {
  local proc cmdline
  for proc in /proc/[0-9]*; do
    [[ -r "$proc/cmdline" ]] || continue
    cmdline="$(tr '\0' ' ' <"$proc/cmdline" 2>/dev/null || true)"
    if [[ "$cmdline" == *"node "*"scripts/brain-service.mjs"* ]] &&
      [[ "$cmdline" == *"$ROOT_DIR"* || "$(readlink -f "$proc/cwd" 2>/dev/null || true)" == "$ROOT_DIR" ]]; then
      basename "$proc"
      return 0
    fi
  done
  return 1
}

remember_pid() {
  local pid="${1:-}"
  if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s\n' "$pid" >"$PID_FILE"
  else
    rm -f "$PID_FILE"
  fi
}

start_standalone() {
  local pid
  pid="$(discover_standalone_pid || true)"
  if [[ -n "$pid" ]] && is_healthy; then
    remember_pid "$pid"
    echo "Brain service is already healthy (pid=$pid)"
    return 0
  fi

  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null || true
    sleep 1
  fi

  (
    cd "$ROOT_DIR"
    nohup setsid node scripts/brain-service.mjs >>"$LOG_FILE" 2>&1 </dev/null &
    remember_pid "$!"
  )
  wait_for_health
  pid="$(discover_standalone_pid || cat "$PID_FILE" 2>/dev/null || true)"
  remember_pid "$pid"
  echo "Brain service started in standalone mode (pid=$pid)"
}

stop_standalone() {
  local pid
  pid="$(discover_standalone_pid || cat "$PID_FILE" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "Brain service stopped in standalone mode"
}

start_service() {
  local pid
  if has_systemd_unit; then
    systemctl start "$SYSTEMD_UNIT"
    wait_for_health
    pid="$(systemd_main_pid)"
    remember_pid "$pid"
    echo "Brain service is healthy under systemd unit $SYSTEMD_UNIT (pid=$pid)"
  else
    start_standalone
  fi
}

stop_service() {
  if has_systemd_unit; then
    systemctl stop "$SYSTEMD_UNIT"
    rm -f "$PID_FILE"
    echo "Brain service stopped under systemd unit $SYSTEMD_UNIT"
  else
    stop_standalone
  fi
}

restart_service() {
  local pid
  if has_systemd_unit; then
    systemctl restart "$SYSTEMD_UNIT"
    wait_for_health
    pid="$(systemd_main_pid)"
    remember_pid "$pid"
    echo "Brain service restarted under systemd unit $SYSTEMD_UNIT (pid=$pid)"
  else
    stop_standalone
    start_standalone
  fi
}

status_service() {
  local pid
  if has_systemd_unit; then
    pid="$(systemd_main_pid)"
    if systemctl is-active --quiet "$SYSTEMD_UNIT" && is_healthy; then
      remember_pid "$pid"
      echo "Brain service is healthy under systemd unit $SYSTEMD_UNIT (pid=$pid)"
      return 0
    fi
    echo "Brain service is not healthy under systemd unit $SYSTEMD_UNIT (pid=${pid:-unknown})" >&2
    return 1
  fi

  pid="$(discover_standalone_pid || true)"
  if [[ -n "$pid" ]] && is_healthy; then
    remember_pid "$pid"
    echo "Brain service is healthy in standalone mode (pid=$pid)"
    return 0
  fi
  echo "Brain service is not healthy in standalone mode" >&2
  return 1
}

run_foreground() {
  exec node "$ROOT_DIR/scripts/brain-service.mjs"
}

case "${1:-start}" in
  run)
    run_foreground
    ;;
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    restart_service
    ;;
  status)
    status_service
    ;;
  *)
    echo "Usage: $0 {run|start|stop|restart|status}" >&2
    exit 2
    ;;
esac
