# Cursor Zero-Overhead Tracing Guide

AgentTrace Hub provides **three non-invasive options** to trace Cursor Agent alongside AGY, Claude Code, and Pi Agent.

---

## Option 1: Native Transcript Streaming (Zero-Config, 0.0ms Overhead)

Cursor natively logs every turn, query, and tool execution (`read_file`, `edit_file`, `new_file`, `grep_search`, `run_terminal_command`) as structured JSON Lines into:

```
~/.cursor/projects/<project-slug>/agent-transcripts/<session-uuid>/<session-uuid>.jsonl
```

**AgentTrace Hub automatically tails this directory** every second. 
- **Latency overhead on Cursor**: **0.00ms** (passive read of Cursor's existing log files).
- **Setup required**: None! Simply run AgentTrace Hub (`./start.sh`) and use Cursor normally.

---

## Option 2: Project `.cursorrules` Instruction Hook

If you want Cursor to explicitly report completed test runs or build benchmarks into the Hub, add this rule to your project's `.cursorrules` or `.cursor/rules/telemetry.mdc`:

```markdown
# Telemetry and Benchmark Reporting
When executing benchmark tasks, test suites, or git diff inspections in the terminal, run the following fast-trace hook:

sh /home/arch/agent-trace-hub/hooks/fast-trace.sh cursor post_tool << 'EOF'
{
  "tool_name": "run_terminal_command",
  "input": "npm test",
  "resultPreview": "All unit tests pass",
  "duration_ms": 120
}
EOF
```

---

## Option 3: Cursor Model Context Protocol (MCP) Server

You can also configure an MCP tool server in `~/.cursor/mcp.json` or `.cursor/mcp.json` so Cursor can emit structured lifecycle events directly into AgentTrace Hub:

```json
{
  "mcpServers": {
    "agent-trace-hub": {
      "command": "node",
      "args": ["/home/arch/agent-trace-hub/mcp-server.js"],
      "env": {
        "AGENT_TRACE_URL": "http://127.0.0.1:4100/api/traces"
      }
    }
  }
}
```
