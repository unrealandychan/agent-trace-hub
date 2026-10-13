#!/usr/bin/env bash
# start.sh - Launch AgentTrace Hub
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-4100}"

echo "Starting AgentTrace Hub on port $PORT..."
chmod +x "$DIR/hooks/fast-trace.sh" || true

exec node "$DIR/server.js"
