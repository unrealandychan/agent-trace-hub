#!/bin/sh
# fast-trace.sh - Ultra-low latency telemetry hook for AGY, Claude Code, Pi Agent, and Cursor.
# Synchronous atomic append < 0.2ms overhead + optional background HTTP post.

AGENT="${1:-unknown}"
EVENT="${2:-tool_event}"
COLLECTOR_LOG="${AGENT_TRACE_FILE:-/tmp/agent-traces.jsonl}"
COLLECTOR_URL="${AGENT_TRACE_URL:-}"

# Read stdin immediately
PAYLOAD=$(cat 2>/dev/null)
if [ -z "$PAYLOAD" ]; then
  PAYLOAD="{}"
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")

# Atomic append to local JSONL log (deterministic, ~0.1ms overhead)
printf '{"agent":"%s","event":"%s","timestamp":"%s","raw":%s}\n' \
  "$AGENT" "$EVENT" "$TIMESTAMP" "$PAYLOAD" >> "$COLLECTOR_LOG" 2>/dev/null

# Detached background HTTP post only if explicitly requested
if [ -n "$AGENT_TRACE_URL" ]; then
  (
    curl -s -m 0.2 -X POST "$COLLECTOR_URL" \
      -H "Content-Type: application/json" \
      -d "{\"agent\":\"$AGENT\",\"event\":\"$EVENT\",\"timestamp\":\"$TIMESTAMP\",\"raw\":$PAYLOAD}" >/dev/null 2>&1
  ) >/dev/null 2>&1 &
fi

# Return required empty JSON stdout immediately for AGY/Claude hooks
printf "{}"
exit 0
