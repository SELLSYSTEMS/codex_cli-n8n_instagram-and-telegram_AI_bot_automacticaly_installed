#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT/.runtime"
PID_FILE="$RUNTIME_DIR/deepseek-evaluator-proxy.pid"
LOG_FILE="$RUNTIME_DIR/deepseek-evaluator-proxy.log"
COMMAND="${1:-status}"

mkdir -p "$RUNTIME_DIR"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

HOST="${DEEPSEEK_EVALUATOR_PROXY_HOST:-127.0.0.1}"
PORT="${DEEPSEEK_EVALUATOR_PROXY_PORT:-8791}"
SERVICE_NAME="${DEEPSEEK_EVALUATOR_PROXY_SERVICE:-multichannel-deepseek-evaluator-proxy.service}"

is_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

health_check() {
  curl -fsS "http://${HOST}:${PORT}/health" >/dev/null
}

service_installed() {
  command -v systemctl >/dev/null 2>&1 &&
    systemctl cat "$SERVICE_NAME" >/dev/null 2>&1
}

wait_for_health() {
  for _ in $(seq 1 60); do
    if health_check; then
      return 0
    fi
    sleep 1
  done
  return 1
}

report_service_failure() {
  systemctl --no-pager --full status "$SERVICE_NAME" >&2 || true
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2 || true
}

run_proxy() {
  : "${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY is required}"
  exec node "$ROOT/scripts/deepseek-evaluator-proxy.mjs"
}

start_legacy_proxy() {
  if is_running && health_check; then
    echo "DeepSeek evaluator proxy is already running"
    return
  fi

  if is_running; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"

  : "${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY is required}"
  nohup node "$ROOT/scripts/deepseek-evaluator-proxy.mjs" >>"$LOG_FILE" 2>&1 &
  echo "$!" >"$PID_FILE"

  for _ in $(seq 1 30); do
    if is_running && health_check; then
      echo "DeepSeek evaluator proxy started"
      return
    fi
    sleep 1
  done

  echo "DeepSeek evaluator proxy failed to start" >&2
  tail -n 20 "$LOG_FILE" >&2 || true
  return 1
}

start_proxy() {
  if health_check; then
    echo "DeepSeek evaluator proxy is already running"
    return
  fi

  if service_installed; then
    systemctl start "$SERVICE_NAME"
    if wait_for_health; then
      echo "DeepSeek evaluator proxy started via $SERVICE_NAME"
      return
    fi
    echo "DeepSeek evaluator proxy service failed health check" >&2
    report_service_failure
    return 1
  fi

  start_legacy_proxy
}

stop_proxy() {
  if service_installed; then
    systemctl stop "$SERVICE_NAME"
    rm -f "$PID_FILE"
    echo "DeepSeek evaluator proxy stopped"
    return
  fi

  if ! is_running; then
    rm -f "$PID_FILE"
    echo "DeepSeek evaluator proxy is stopped"
    return
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid"
  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "DeepSeek evaluator proxy stopped"
      return
    fi
    sleep 0.25
  done

  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "DeepSeek evaluator proxy stopped"
}

restart_proxy() {
  if service_installed; then
    systemctl restart "$SERVICE_NAME"
    if wait_for_health; then
      echo "DeepSeek evaluator proxy restarted via $SERVICE_NAME"
      return
    fi
    echo "DeepSeek evaluator proxy service failed health check" >&2
    report_service_failure
    return 1
  fi

  stop_proxy
  start_proxy
}

case "$COMMAND" in
  run)
    run_proxy
    ;;
  start)
    start_proxy
    ;;
  stop)
    stop_proxy
    ;;
  restart)
    restart_proxy
    ;;
  status)
    if health_check; then
      echo "DeepSeek evaluator proxy is running"
    elif service_installed && systemctl is-active --quiet "$SERVICE_NAME"; then
      echo "DeepSeek evaluator proxy service is active but health check failed" >&2
      exit 1
    else
      echo "DeepSeek evaluator proxy is stopped"
      exit 1
    fi
    ;;
  *)
    echo "Usage: $0 {run|start|stop|restart|status}" >&2
    exit 2
    ;;
esac
