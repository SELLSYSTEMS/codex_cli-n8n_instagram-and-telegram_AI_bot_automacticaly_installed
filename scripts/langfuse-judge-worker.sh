#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$ROOT/.runtime/langfuse-judge"
PID_FILE="$RUNTIME/worker.pid"
LOG_FILE="$RUNTIME/worker.log"

mkdir -p "$RUNTIME"

running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

case "${1:-status}" in
  start)
    if running; then
      echo "Langfuse judge worker already running: PID $(cat "$PID_FILE")"
      exit 0
    fi
    cd "$ROOT"
    nohup node scripts/langfuse-judge-worker.mjs --daemon >>"$LOG_FILE" 2>&1 &
    echo "$!" >"$PID_FILE"
    echo "Langfuse judge worker started: PID $!"
    ;;
  stop)
    if running; then
      kill "$(cat "$PID_FILE")"
      echo "Langfuse judge worker stopped"
    else
      echo "Langfuse judge worker is not running"
    fi
    rm -f "$PID_FILE"
    ;;
  restart)
    bash "$0" stop
    bash "$0" start
    ;;
  once)
    cd "$ROOT"
    exec node scripts/langfuse-judge-worker.mjs "${@:2}"
    ;;
  status)
    if running; then
      echo "running PID=$(cat "$PID_FILE") log=$LOG_FILE"
    else
      echo "stopped log=$LOG_FILE"
      exit 1
    fi
    ;;
  log)
    tail -n "${2:-50}" "$LOG_FILE"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|once|status|log}"
    exit 2
    ;;
esac
