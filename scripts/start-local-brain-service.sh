#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
PID_FILE="$RUNTIME_DIR/brain-service.pid"
LOG_FILE="$RUNTIME_DIR/brain-service.log"
ENV_FILE="$ROOT_DIR/.env"
ACTION="${1:-start}"

mkdir -p "$RUNTIME_DIR"

load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Missing $ENV_FILE" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  BRAIN_HOST="${BRAIN_HOST:-127.0.0.1}"
  BRAIN_PORT="${BRAIN_PORT:-8789}"
  BRAIN_API_URL="${BRAIN_API_URL:-http://${BRAIN_HOST}:${BRAIN_PORT}}"
}

pid_value() {
  [[ -s "$PID_FILE" ]] && cat "$PID_FILE" || true
}

is_our_process() {
  local pid
  pid="$(pid_value)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q 'scripts/brain-service.mjs'
}

is_healthy() {
  curl --fail --silent --show-error --max-time 2 "$BRAIN_API_URL/health" >/dev/null 2>&1
}

start_service() {
  load_env
  if is_our_process && is_healthy; then
    echo "brain service already healthy (pid $(pid_value))"
    return 0
  fi

  if [[ -e "$PID_FILE" ]]; then
    rm -f "$PID_FILE"
  fi
  : >"$LOG_FILE"

  (
    cd "$ROOT_DIR"
    exec nohup setsid node scripts/brain-service.mjs
  ) </dev/null >>"$LOG_FILE" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"

  for _ in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "brain service exited during startup" >&2
      tail -n 40 "$LOG_FILE" >&2 || true
      rm -f "$PID_FILE"
      return 1
    fi
    if is_healthy; then
      sleep 1
      if ! kill -0 "$pid" 2>/dev/null || ! is_healthy; then
        continue
      fi
      echo "brain service healthy (pid $pid, $BRAIN_API_URL)"
      return 0
    fi
    sleep 0.5
  done

  echo "brain service failed its health check" >&2
  tail -n 40 "$LOG_FILE" >&2 || true
  kill "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  return 1
}

stop_service() {
  if ! is_our_process; then
    rm -f "$PID_FILE"
    echo "brain service is not running"
    return 0
  fi

  local pid
  pid="$(pid_value)"
  kill "$pid"
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid"
  fi
  rm -f "$PID_FILE"
  echo "brain service stopped"
}

status_service() {
  load_env
  if is_our_process && is_healthy; then
    echo "brain service healthy (pid $(pid_value), $BRAIN_API_URL)"
    return 0
  fi
  echo "brain service is not healthy"
  return 1
}

case "$ACTION" in
  start) start_service ;;
  stop) stop_service ;;
  restart)
    stop_service
    start_service
    ;;
  status) status_service ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}" >&2
    exit 2
    ;;
esac
