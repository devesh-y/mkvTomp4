#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
PID_FILE="$SCRIPT_DIR/.mkvTomp4-dev.pid"

close_terminal_window() {
  # Close the Terminal window opened by this .command file.
  osascript -e 'tell application "Terminal" to if front window is not missing value then close front window' >/dev/null 2>&1 || true
}

close_terminal_window_after_exit() {
  (
    sleep 0.4
    close_terminal_window
  ) >/dev/null 2>&1 &
}

stop_pid() {
  local pid="$1"
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return 1
  fi

  echo "Stopping process $pid ..."
  kill "$pid" >/dev/null 2>&1 || true

  for _ in {1..20}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done

  echo "Process $pid did not exit quickly; forcing stop."
  kill -9 "$pid" >/dev/null 2>&1 || true
  ! kill -0 "$pid" >/dev/null 2>&1
}

STOPPED_ANY=0

if [ -f "$PID_FILE" ]; then
  PID="$(tr -d '[:space:]' < "$PID_FILE")"
  if [ -n "$PID" ] && [[ "$PID" =~ ^[0-9]+$ ]]; then
    if stop_pid "$PID"; then
      STOPPED_ANY=1
    fi
  fi
  rm -f "$PID_FILE"
fi

PIDS_ON_PORTS="$(lsof -tiTCP:5173 -sTCP:LISTEN 2>/dev/null || true; lsof -tiTCP:8787 -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$PIDS_ON_PORTS" ]; then
  for pid in ${(u)${(f)PIDS_ON_PORTS}}; do
    if [ -n "$pid" ] && [[ "$pid" =~ ^[0-9]+$ ]]; then
      if stop_pid "$pid"; then
        STOPPED_ANY=1
      fi
    fi
  done
fi

if [ "$STOPPED_ANY" -eq 1 ]; then
  echo "Server stopped."
else
  echo "No running server process found."
fi

close_terminal_window_after_exit
