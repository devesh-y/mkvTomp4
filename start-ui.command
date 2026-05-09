#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
LOG_FILE="$SCRIPT_DIR/.mkvTomp4-dev.log"
PID_FILE="$SCRIPT_DIR/.mkvTomp4-dev.pid"

close_terminal_window() {
  # Close the Terminal window opened by this .command file.
  osascript -e 'tell application "Terminal" to if front window is not missing value then close front window' >/dev/null 2>&1 || true
}

close_terminal_window_after_exit() {
  # Delay close slightly so this shell exits first (avoids terminate prompt).
  (
    sleep 0.4
    close_terminal_window
  ) >/dev/null 2>&1 &
}

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not installed or not in PATH."
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required but not available in PATH."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

if lsof -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1 && lsof -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Frontend and backend already appear to be running."
  open "http://localhost:5173"
  close_terminal_window_after_exit
  exit 0
fi

echo "Starting frontend + backend..."
nohup npm run dev >"$LOG_FILE" 2>&1 < /dev/null &
DEV_PID=$!
disown "$DEV_PID" 2>/dev/null || true
echo "$DEV_PID" >"$PID_FILE"

echo "Waiting for UI at http://localhost:5173 ..."
for _ in {1..120}; do
  if curl -sf "http://localhost:5173" >/dev/null 2>&1; then
    open "http://localhost:5173"
    echo "Browser opened."
    close_terminal_window_after_exit
    exit 0
  fi
  if ! kill -0 "$DEV_PID" >/dev/null 2>&1; then
    echo "Startup process exited early. Check $LOG_FILE"
    exit 1
  fi
  sleep 1
done

echo "UI did not become ready in time. Check $LOG_FILE"
exit 1
