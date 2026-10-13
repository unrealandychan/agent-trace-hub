// server.js - AgentTrace Hub: Visualize, Evaluate, and Compare AGY, Claude Code, Pi Agent & Cursor.
// Built with native Node.js (node:http, node:sqlite, node:fs, node:path) - ZERO external dependencies.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const PORT = parseInt(process.env.PORT || "4100", 10);

// Choose a writable database path
let dbPath = path.join(__dirname, "data", "traces.db");
try {
  if (!fs.existsSync(path.dirname(dbPath))) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  fs.writeFileSync(dbPath + ".test", "");
  fs.unlinkSync(dbPath + ".test");
} catch {
  dbPath = path.join("/tmp", "agent-trace-hub.db");
}

console.log(`[AgentTrace Hub] Using database: ${dbPath}`);
const db = new DatabaseSync(dbPath);

// Enable WAL mode for high concurrency & low write latency
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");

// Initialize Schema
db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  agent TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  status TEXT DEFAULT 'completed',
  total_duration_ms INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0.0,
  files_changed INTEGER DEFAULT 0,
  lines_added INTEGER DEFAULT 0,
  lines_deleted INTEGER DEFAULT 0,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL,
  duration_ms INTEGER DEFAULT 0,
  tool_category TEXT NOT NULL,
  raw_tool_name TEXT,
  input_summary TEXT,
  output_summary TEXT,
  status TEXT DEFAULT 'success',
  error TEXT,
  raw_json TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS evaluations (
  id TEXT PRIMARY KEY,
  session_id TEXT UNIQUE NOT NULL,
  verified_pass INTEGER DEFAULT 1,
  rubric_correctness INTEGER DEFAULT 5,
  rubric_speed INTEGER DEFAULT 5,
  rubric_safety INTEGER DEFAULT 5,
  rubric_code_quality INTEGER DEFAULT 5,
  composite_score REAL DEFAULT 95.0,
  evaluator_notes TEXT,
  created_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
`);

// Canonical tool category mapper across AGY, Claude Code, Pi Agent, and Cursor
function normalizeToolCategory(agent, rawName) {
  if (!rawName) return "custom";
  const name = String(rawName).toLowerCase();

  if (name.includes("command") || name.includes("bash") || name.includes("powershell") || name.includes("terminal") || name.includes("exec") || name.includes("shell")) {
    return "terminal_command";
  }
  if (name.includes("replace") || name.includes("edit") || name.includes("patch") || name.includes("modify")) {
    return "file_edit";
  }
  if (name.includes("view") || name.includes("read") || name.includes("cat") || name.includes("head") || name.includes("tail")) {
    return "file_read";
  }
  if (name.includes("write") || name.includes("create") || name.includes("new_file") || name.includes("save")) {
    return "file_write";
  }
  if (name.includes("search") || name.includes("grep") || name.includes("find") || name.includes("glob") || name.includes("list_dir") || name.includes("ls")) {
    return "code_search";
  }
  if (name.includes("browser")) {
    return "browser";
  }
  if (name.includes("subagent") || name.includes("agent") || name.includes("task") || name.includes("turn")) {
    return "agent_control";
  }
  return "custom";
}

// Ingestion logic for a single trace event
function ingestTraceItem(item) {
  const agent = (item.agent || "unknown").toLowerCase();
  const event = item.event || "tool_event";
  const timestamp = item.timestamp || new Date().toISOString();
  const raw = item.raw || {};

  const rawName = raw.toolName || (raw.toolCall && raw.toolCall.name) || raw.tool_name || item.tool_name || item.tool || "unknown";
  const category = normalizeToolCategory(agent, rawName);
  const duration = raw.duration_ms || raw.durationMs || item.duration_ms || item.duration || 150;
  const status = raw.isError || raw.error || item.error || raw.status === "error" ? "error" : "success";
  const error = raw.error || item.error || (raw.isError ? "Tool execution error" : null);

  const sessionId = item.session_id || item.sessionId || raw.conversationId || raw.sessionId || `sess-${agent}-live`;

  // Ensure session exists
  const ensureSession = db.prepare(`
    INSERT INTO sessions (id, agent, start_time, status)
    VALUES (?, ?, ?, 'running')
    ON CONFLICT(id) DO UPDATE SET
      tool_call_count = tool_call_count + 1,
      error_count = error_count + (CASE WHEN ? = 'error' THEN 1 ELSE 0 END),
      total_duration_ms = total_duration_ms + ?
  `);
  ensureSession.run(sessionId, agent, timestamp, status, duration);

  // Insert Trace Record
  const insertTrace = db.prepare(`
    INSERT INTO traces (
      id, session_id, agent, timestamp, event_type, duration_ms,
      tool_category, raw_tool_name, input_summary, output_summary, status, error, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const inputSummary = typeof raw.toolCall?.args === "object"
    ? JSON.stringify(raw.toolCall.args).slice(0, 300)
    : (raw.input || raw.args || "").toString().slice(0, 300);

  const outputSummary = (raw.resultPreview || raw.output || "").toString().slice(0, 300);

  insertTrace.run(
    `tr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    sessionId,
    agent,
    timestamp,
    event,
    duration,
    category,
    rawName,
    inputSummary || "-",
    outputSummary || "-",
    status,
    error,
    JSON.stringify(item)
  );
}

// Background file tailer for /tmp/agent-traces.jsonl (Zero-latency fallback)
const FALLBACK_LOG = process.env.AGENT_TRACE_FILE || "/tmp/agent-traces.jsonl";
let lastOffset = 0;

function syncJsonlLog() {
  if (!fs.existsSync(FALLBACK_LOG)) return;
  try {
    const stats = fs.statSync(FALLBACK_LOG);
    if (stats.size <= lastOffset) return;

    const fd = fs.openSync(FALLBACK_LOG, "r");
    const buffer = Buffer.alloc(stats.size - lastOffset);
    fs.readSync(fd, buffer, 0, buffer.length, lastOffset);
    fs.closeSync(fd);
    lastOffset = stats.size;

    const lines = buffer.toString("utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        ingestTraceItem(item);
      } catch (e) {}
    }
  } catch (err) {}
}

// Background file tailer for Cursor IDE native transcripts (~/.cursor/projects/*/agent-transcripts/**/*.jsonl)
const cursorOffsets = new Map();

function findCursorJsonlFiles(dir) {
  let results = [];
  try {
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(findCursorJsonlFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && fullPath.includes("agent-transcripts")) {
        results.push(fullPath);
      }
    }
  } catch (err) {}
  return results;
}

function processCursorEntry(sessionId, entry) {
  const sid = `cursor-${sessionId}`;
  if (entry.role === "user") {
    const ensureSession = db.prepare(`
      INSERT INTO sessions (id, agent, start_time, status)
      VALUES (?, 'cursor', ?, 'running')
      ON CONFLICT(id) DO NOTHING
    `);
    ensureSession.run(sid, new Date().toISOString());
  } else if (entry.role === "assistant") {
    const contents = Array.isArray(entry.message?.content) ? entry.message.content : [];
    for (const c of contents) {
      if (c.type === "tool_use" || c.type === "tool_call" || c.name || c.tool_name) {
        const toolName = c.name || c.tool_name || "cursor_tool";
        ingestTraceItem({
          agent: "cursor",
          session_id: sid,
          event: "post_tool",
          raw: {
            toolName: toolName,
            args: c.input || c.arguments || c.params || {},
            output: c.result || "Executed",
            durationMs: 200,
            status: "success"
          }
        });
      }
    }
  } else if (entry.type === "turn_ended") {
    if (entry.status === "error") {
      ingestTraceItem({
        agent: "cursor",
        session_id: sid,
        event: "turn_error",
        raw: {
          toolName: "cursor_turn",
          error: entry.error || "Cursor turn terminated with error",
          isError: true,
          durationMs: 50
        }
      });
    }
  }
}

function syncCursorTranscripts() {
  const cursorProjectsDir = path.join(process.env.HOME || "/home/arch", ".cursor", "projects");
  if (!fs.existsSync(cursorProjectsDir)) return;

  const files = findCursorJsonlFiles(cursorProjectsDir);
  for (const filePath of files) {
    try {
      const stats = fs.statSync(filePath);
      const prevOffset = cursorOffsets.get(filePath) || 0;
      if (stats.size <= prevOffset) continue;

      const fd = fs.openSync(filePath, "r");
      const length = stats.size - prevOffset;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, prevOffset);
      fs.closeSync(fd);
      cursorOffsets.set(filePath, stats.size);

      const sessionId = path.basename(filePath, ".jsonl");
      const lines = buffer.toString("utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          processCursorEntry(sessionId, entry);
        } catch (e) {}
      }
    } catch (err) {}
  }
}

// Start background pollers
setInterval(syncJsonlLog, 250);
setInterval(syncCursorTranscripts, 1000);

// Seed realistic benchmark data for all 4 agents (AGY, Claude Code, Pi Agent, Cursor)
function seedDemoData() {
  console.log("[AgentTrace Hub] Ensuring complete benchmark traces for AGY, Claude Code, Pi Agent, and Cursor...");

  const now = new Date().toISOString();

  // Tasks
  const tasks = [
    {
      id: "task-race-cache",
      name: "Fix Race Condition in Distributed Cache",
      description: "Cache stampede under concurrent loads caused stale reads; requires distributed mutex with TTL lock renewal.",
    },
    {
      id: "task-auth-ed25519",
      name: "Refactor JWT Auth Middleware to Ed25519",
      description: "Upgrade RS256 token verification to asymmetric Ed25519 keypair and add revocation caching.",
    },
    {
      id: "task-db-optimize",
      name: "Optimize Query Bottleneck & Migration",
      description: "N+1 query problem on user activity feeds; write idempotent migration adding composite index.",
    },
  ];

  const insertTask = db.prepare("INSERT INTO tasks (id, name, description, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING");
  for (const t of tasks) {
    insertTask.run(t.id, t.name, t.description, now);
  }

  // Pre-seed agent sessions & traces across tasks
  const demoRuns = [
    // Task 1: Race Condition in Distributed Cache
    {
      id: "sess-agy-cache-01",
      taskId: "task-race-cache",
      agent: "agy",
      durationMs: 42500,
      toolsCount: 7,
      errors: 0,
      promptTokens: 14200,
      completionTokens: 2150,
      costUsd: 0.041,
      filesChanged: 2,
      linesAdded: 48,
      linesDeleted: 12,
      verified: 1,
      correctness: 5,
      speed: 5,
      safety: 5,
      quality: 5,
      score: 98.0,
      notes: "Clean separation using Redis SETNX with lease renewal loop. All concurrency unit tests passed on first attempt.",
      traces: [
        { cat: "file_read", raw: "view_file", dur: 120, in: "src/cache/distributed.ts (Lines 1-80)", out: "Identified mutex release without token verification" },
        { cat: "code_search", raw: "search_web", dur: 850, in: "Redis Redlock algorithm lock renewal pattern", out: "Found recommended TTL heart-beat pattern" },
        { cat: "file_edit", raw: "replace_file_content", dur: 310, in: "src/cache/distributed.ts: implement Redlock lease", out: "Added RedlockMutex class with UUID token" },
        { cat: "file_write", raw: "write_to_file", dur: 180, in: "tests/cache_concurrency.test.ts", out: "Added 100 parallel concurrent worker stress test" },
        { cat: "terminal_command", raw: "run_command", dur: 3420, in: "npm test -- tests/cache_concurrency.test.ts", out: "PASS: 100/100 concurrent workers acquired lock cleanly" },
        { cat: "file_edit", raw: "replace_file_content", dur: 220, in: "src/cache/index.ts: export updated RedlockMutex", out: "Updated exports" },
        { cat: "terminal_command", raw: "run_command", dur: 2100, in: "npm run lint", out: "0 lint errors found" }
      ]
    },
    {
      id: "sess-claude-cache-01",
      taskId: "task-race-cache",
      agent: "claude",
      durationMs: 58200,
      toolsCount: 9,
      errors: 1,
      promptTokens: 21800,
      completionTokens: 3400,
      costUsd: 0.089,
      filesChanged: 3,
      linesAdded: 76,
      linesDeleted: 22,
      verified: 1,
      correctness: 5,
      speed: 4,
      safety: 4,
      quality: 4,
      score: 91.5,
      notes: "Solved correctly with retry backoff. Suffered one syntax error on first edit attempt that was quickly self-healed.",
      traces: [
        { cat: "code_search", raw: "Grep", dur: 210, in: "pattern: 'acquireLock' in src/", out: "Found 3 usages in cache/distributed.ts" },
        { cat: "file_read", raw: "Read", dur: 150, in: "src/cache/distributed.ts", out: "Read 120 lines" },
        { cat: "file_edit", raw: "Edit", dur: 410, in: "src/cache/distributed.ts: add retry with jitter", out: "Replaced acquireLock logic" },
        { cat: "terminal_command", raw: "Bash", dur: 2800, in: "npm test", out: "FAIL: syntax error in distributed.ts line 64" },
        { cat: "file_read", raw: "Read", dur: 110, in: "src/cache/distributed.ts (Lines 50-75)", out: "Inspected syntax error" },
        { cat: "file_edit", raw: "Edit", dur: 280, in: "src/cache/distributed.ts: fix bracket mismatch", out: "Syntax resolved" },
        { cat: "file_write", raw: "Write", dur: 240, in: "tests/cache_race.test.ts", out: "Created test suite" },
        { cat: "terminal_command", raw: "Bash", dur: 3200, in: "npm test", out: "PASS: All tests pass" },
        { cat: "terminal_command", raw: "Bash", dur: 1900, in: "git diff --stat", out: "3 files changed, 76 insertions" }
      ]
    },
    {
      id: "sess-pi-cache-01",
      taskId: "task-race-cache",
      agent: "pi",
      durationMs: 36400,
      toolsCount: 5,
      errors: 0,
      promptTokens: 11500,
      completionTokens: 1800,
      costUsd: 0.032,
      filesChanged: 1,
      linesAdded: 32,
      linesDeleted: 8,
      verified: 1,
      correctness: 4,
      speed: 5,
      safety: 4,
      quality: 4,
      score: 89.0,
      notes: "Fastest execution time and minimal token footprint. Applied an in-memory singleflight lock rather than full Redlock.",
      traces: [
        { cat: "file_read", raw: "read", dur: 95, in: "src/cache/distributed.ts", out: "Read file contents" },
        { cat: "file_edit", raw: "edit", dur: 290, in: "src/cache/distributed.ts: add singleflight deduplicator", out: "Wrapped query with singleflight mutex" },
        { cat: "terminal_command", raw: "bash", dur: 2900, in: "npm test", out: "PASS: 18 passed" },
        { cat: "terminal_command", raw: "bash", dur: 1100, in: "git status", out: "Modified src/cache/distributed.ts" },
        { cat: "terminal_command", raw: "bash", dur: 850, in: "git diff", out: "32 insertions, 8 deletions" }
      ]
    },
    {
      id: "sess-cursor-cache-01",
      taskId: "task-race-cache",
      agent: "cursor",
      durationMs: 44200,
      toolsCount: 6,
      errors: 0,
      promptTokens: 17100,
      completionTokens: 2600,
      costUsd: 0.052,
      filesChanged: 2,
      linesAdded: 51,
      linesDeleted: 14,
      verified: 1,
      correctness: 5,
      speed: 5,
      safety: 5,
      quality: 5,
      score: 96.0,
      notes: "Rapid inline file edits with multi-file jump navigation. Handled lease renewal and concurrency tests cleanly.",
      traces: [
        { cat: "file_read", raw: "read_file", dur: 110, in: "src/cache/distributed.ts", out: "Read 90 lines" },
        { cat: "code_search", raw: "grep_search", dur: 190, in: "acquireLock in src/", out: "Found distributed lock mutex" },
        { cat: "file_edit", raw: "edit_file", dur: 380, in: "src/cache/distributed.ts: implement Redlock lease with expiration", out: "Added RedlockMutex class" },
        { cat: "file_write", raw: "new_file", dur: 210, in: "tests/cache_concurrency.test.ts", out: "Added 50 parallel workers stress test" },
        { cat: "terminal_command", raw: "run_terminal_command", dur: 3100, in: "npm test", out: "PASS: 50/50 workers acquired lock" },
        { cat: "terminal_command", raw: "run_terminal_command", dur: 1500, in: "git diff --stat", out: "2 files changed, 51 insertions(+)" }
      ]
    },

    // Task 2: Auth Ed25519
    {
      id: "sess-agy-auth-02",
      taskId: "task-auth-ed25519",
      agent: "agy",
      durationMs: 38100,
      toolsCount: 6,
      errors: 0,
      promptTokens: 16500,
      completionTokens: 2400,
      costUsd: 0.048,
      filesChanged: 3,
      linesAdded: 62,
      linesDeleted: 35,
      verified: 1,
      correctness: 5,
      speed: 5,
      safety: 5,
      quality: 5,
      score: 97.5,
      notes: "Strict cryptographic validation using Web Crypto API. Revocation list checked via Bloom filter.",
      traces: [
        { cat: "file_read", raw: "view_file", dur: 110, in: "src/middleware/jwt.ts", out: "Found RSA-256 legacy verification" },
        { cat: "file_edit", raw: "replace_file_content", dur: 380, in: "src/middleware/jwt.ts: switch to crypto.subtle Ed25519", out: "Replaced crypto verify" },
        { cat: "file_write", raw: "write_to_file", dur: 220, in: "src/middleware/revocation.ts", out: "Added revocation cache layer" },
        { cat: "file_edit", raw: "replace_file_content", dur: 190, in: "src/middleware/index.ts", out: "Exported middleware" },
        { cat: "terminal_command", raw: "run_command", dur: 3200, in: "npm test -- tests/auth.test.ts", out: "PASS: 24 tests passed" },
        { cat: "terminal_command", raw: "run_command", dur: 1800, in: "npm run lint", out: "Clean" }
      ]
    },
    {
      id: "sess-claude-auth-02",
      taskId: "task-auth-ed25519",
      agent: "claude",
      durationMs: 51200,
      toolsCount: 8,
      errors: 0,
      promptTokens: 19400,
      completionTokens: 3100,
      costUsd: 0.076,
      filesChanged: 2,
      linesAdded: 55,
      linesDeleted: 28,
      verified: 1,
      correctness: 5,
      speed: 4,
      safety: 5,
      quality: 5,
      score: 94.0,
      notes: "Solid implementation with Jose library. Thorough testing of expired and revoked tokens.",
      traces: [
        { cat: "code_search", raw: "Grep", dur: 180, in: "verifyJwt in src/", out: "src/middleware/jwt.ts" },
        { cat: "file_read", raw: "Read", dur: 130, in: "src/middleware/jwt.ts", out: "Inspected RSA parser" },
        { cat: "file_edit", raw: "Edit", dur: 450, in: "src/middleware/jwt.ts: import jose and verify Ed25519", out: "Updated verification logic" },
        { cat: "terminal_command", raw: "Bash", dur: 2900, in: "npm test", out: "PASS: 22 tests passed" },
        { cat: "file_edit", raw: "Edit", dur: 310, in: "tests/auth.test.ts: add test for malformed Ed25519", out: "Added edge case test" },
        { cat: "terminal_command", raw: "Bash", dur: 2800, in: "npm test", out: "PASS: 23 tests passed" },
        { cat: "terminal_command", raw: "Bash", dur: 1400, in: "git diff", out: "Reviewed diffs" },
        { cat: "terminal_command", raw: "Bash", dur: 900, in: "git status", out: "Clean working tree" }
      ]
    },
    {
      id: "sess-pi-auth-02",
      taskId: "task-auth-ed25519",
      agent: "pi",
      durationMs: 34900,
      toolsCount: 5,
      errors: 0,
      promptTokens: 12200,
      completionTokens: 1950,
      costUsd: 0.035,
      filesChanged: 2,
      linesAdded: 42,
      linesDeleted: 20,
      verified: 1,
      correctness: 4,
      speed: 5,
      safety: 4,
      quality: 4,
      score: 90.0,
      notes: "Quick, lean solution using Node crypto.generateKeyPairSync. Missed key rotation edge case.",
      traces: [
        { cat: "file_read", raw: "read", dur: 90, in: "src/middleware/jwt.ts", out: "Read file" },
        { cat: "file_edit", raw: "edit", dur: 320, in: "src/middleware/jwt.ts: update verify with ed25519", out: "Changed algorithm" },
        { cat: "file_edit", raw: "edit", dur: 240, in: "tests/jwt.test.ts", out: "Updated mock keys" },
        { cat: "terminal_command", raw: "bash", dur: 2400, in: "npm test", out: "PASS" },
        { cat: "terminal_command", raw: "bash", dur: 700, in: "git diff", out: "42 additions" }
      ]
    },
    {
      id: "sess-cursor-auth-02",
      taskId: "task-auth-ed25519",
      agent: "cursor",
      durationMs: 41200,
      toolsCount: 6,
      errors: 0,
      promptTokens: 18200,
      completionTokens: 2550,
      costUsd: 0.054,
      filesChanged: 2,
      linesAdded: 58,
      linesDeleted: 30,
      verified: 1,
      correctness: 5,
      speed: 5,
      safety: 5,
      quality: 5,
      score: 96.5,
      notes: "Refactored JWT middleware using Node native crypto Ed25519 with instant diff preview and revocation cache.",
      traces: [
        { cat: "file_read", raw: "read_file", dur: 120, in: "src/middleware/jwt.ts", out: "Inspected RS256 token verification" },
        { cat: "code_search", raw: "grep_search", dur: 170, in: "algorithm in src/middleware", out: "Found RSA algorithm constants" },
        { cat: "file_edit", raw: "edit_file", dur: 410, in: "src/middleware/jwt.ts: switch to Ed25519 key verification", out: "Updated JWT verifier" },
        { cat: "file_write", raw: "new_file", dur: 230, in: "src/middleware/revocation.ts", out: "Created in-memory revocation map" },
        { cat: "terminal_command", raw: "run_terminal_command", dur: 2900, in: "npm test -- tests/auth.test.ts", out: "PASS: 24 tests passed" },
        { cat: "terminal_command", raw: "run_terminal_command", dur: 1600, in: "git diff --stat", out: "2 files changed, 58 insertions(+), 30 deletions(-)" }
      ]
    },

    // Task 3: Optimize Query Bottleneck & Migration
    {
      id: "sess-agy-db-03",
      taskId: "task-db-optimize",
      agent: "agy",
      durationMs: 35800,
      toolsCount: 6,
      errors: 0,
      promptTokens: 13900,
      completionTokens: 2100,
      costUsd: 0.038,
      filesChanged: 2,
      linesAdded: 44,
      linesDeleted: 16,
      verified: 1,
      correctness: 5,
      speed: 5,
      safety: 5,
      quality: 5,
      score: 97.0,
      notes: "Added composite index on (user_id, created_at DESC) and batch query loader. 18x throughput increase.",
      traces: [
        { cat: "file_read", raw: "view_file", dur: 110, in: "src/db/queries.ts", out: "Found unindexed N+1 query in user feed" },
        { cat: "file_edit", raw: "replace_file_content", dur: 290, in: "src/db/queries.ts: implement DataLoader batching", out: "Batch resolved queries" },
        { cat: "file_write", raw: "write_to_file", dur: 210, in: "migrations/20261013_add_activity_idx.sql", out: "Created idempotent composite index" },
        { cat: "terminal_command", raw: "run_command", dur: 2400, in: "npm run migrate", out: "Applied 1 migration" },
        { cat: "terminal_command", raw: "run_command", dur: 3100, in: "npm test -- tests/db_benchmark.test.ts", out: "Query time reduced from 340ms to 18ms" },
        { cat: "terminal_command", raw: "run_command", dur: 1100, in: "git status", out: "Working tree clean" }
      ]
    },
    {
      id: "sess-claude-db-03",
      taskId: "task-db-optimize",
      agent: "claude",
      durationMs: 48000,
      toolsCount: 7,
      errors: 0,
      promptTokens: 18500,
      completionTokens: 2900,
      costUsd: 0.065,
      filesChanged: 2,
      linesAdded: 45,
      linesDeleted: 18,
      verified: 1,
      correctness: 5,
      speed: 4,
      safety: 5,
      quality: 5,
      score: 93.0,
      notes: "Idempotent migration with EXPLAIN ANALYZE verification. Fixed N+1 using Prisma eager loading.",
      traces: [
        { cat: "code_search", raw: "Grep", dur: 160, in: "findMany in src/db/", out: "Found 4 query sites" },
        { cat: "file_read", raw: "Read", dur: 120, in: "src/db/activity.ts", out: "Reviewed activity fetch" },
        { cat: "file_edit", raw: "Edit", dur: 380, in: "src/db/activity.ts: eager load relations", out: "Replaced separate queries" },
        { cat: "file_write", raw: "Write", dur: 220, in: "prisma/migrations/add_idx/migration.sql", out: "Index added" },
        { cat: "terminal_command", raw: "Bash", dur: 2800, in: "npx prisma migrate dev", out: "Migration applied" },
        { cat: "terminal_command", raw: "Bash", dur: 2900, in: "npm test", out: "PASS: 16 passed" },
        { cat: "terminal_command", raw: "Bash", dur: 900, in: "git diff --stat", out: "2 files changed, 45 insertions" }
      ]
    },
    {
      id: "sess-pi-db-03",
      taskId: "task-db-optimize",
      agent: "pi",
      durationMs: 31500,
      toolsCount: 5,
      errors: 0,
      promptTokens: 10800,
      completionTokens: 1700,
      costUsd: 0.029,
      filesChanged: 2,
      linesAdded: 36,
      linesDeleted: 12,
      verified: 1,
      correctness: 4,
      speed: 5,
      safety: 4,
      quality: 4,
      score: 91.0,
      notes: "Lightweight fix adding raw SQL JOIN query and single index migration.",
      traces: [
        { cat: "file_read", raw: "read", dur: 85, in: "src/db/activity.ts", out: "Read query code" },
        { cat: "file_edit", raw: "edit", dur: 270, in: "src/db/activity.ts: rewrite query with JOIN", out: "Single roundtrip query" },
        { cat: "file_write", raw: "new_file", dur: 180, in: "migrations/add_index.sql", out: "Index SQL created" },
        { cat: "terminal_command", raw: "bash", dur: 2200, in: "npm test", out: "PASS" },
        { cat: "terminal_command", raw: "bash", dur: 750, in: "git status", out: "Clean" }
      ]
    },
    {
      id: "sess-cursor-db-03",
      taskId: "task-db-optimize",
      agent: "cursor",
      durationMs: 37400,
      toolsCount: 6,
      errors: 0,
      promptTokens: 16400,
      completionTokens: 2400,
      costUsd: 0.046,
      filesChanged: 2,
      linesAdded: 39,
      linesDeleted: 14,
      verified: 1,
      correctness: 5,
      speed: 5,
      safety: 5,
      quality: 5,
      score: 95.5,
      notes: "Instant index creation migration + query re-write using query builder with composite index.",
      traces: [
        { cat: "file_read", raw: "read_file", dur: 95, in: "src/db/queries.ts", out: "Analyzed N+1 loops" },
        { cat: "code_search", raw: "grep_search", dur: 150, in: "getUserActivity in src/", out: "Found 2 call sites" },
        { cat: "file_edit", raw: "edit_file", dur: 350, in: "src/db/queries.ts: convert to bulk fetch", out: "Updated query method" },
        { cat: "file_write", raw: "new_file", dur: 210, in: "migrations/20261013_idx_feed.sql", out: "Added CONCURRENTLY index" },
        { cat: "terminal_command", raw: "run_terminal_command", dur: 2600, in: "npm test", out: "PASS: 19 passed" },
        { cat: "terminal_command", raw: "run_terminal_command", dur: 1200, in: "git diff", out: "39 insertions, 14 deletions" }
      ]
    }
  ];

  const insertSession = db.prepare(`
    INSERT INTO sessions (
      id, task_id, agent, start_time, end_time, status, total_duration_ms,
      tool_call_count, error_count, prompt_tokens, completion_tokens, cost_usd,
      files_changed, lines_added, lines_deleted
    ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      task_id = excluded.task_id,
      agent = excluded.agent,
      total_duration_ms = excluded.total_duration_ms,
      tool_call_count = excluded.tool_call_count,
      error_count = excluded.error_count,
      prompt_tokens = excluded.prompt_tokens,
      completion_tokens = excluded.completion_tokens,
      cost_usd = excluded.cost_usd,
      files_changed = excluded.files_changed,
      lines_added = excluded.lines_added,
      lines_deleted = excluded.lines_deleted
  `);

  const insertTrace = db.prepare(`
    INSERT INTO traces (
      id, session_id, agent, timestamp, event_type, duration_ms,
      tool_category, raw_tool_name, input_summary, output_summary, status, error, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);

  const insertEval = db.prepare(`
    INSERT INTO evaluations (
      id, session_id, verified_pass, rubric_correctness, rubric_speed,
      rubric_safety, rubric_code_quality, composite_score, evaluator_notes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      verified_pass = excluded.verified_pass,
      rubric_correctness = excluded.rubric_correctness,
      rubric_speed = excluded.rubric_speed,
      rubric_safety = excluded.rubric_safety,
      rubric_code_quality = excluded.rubric_code_quality,
      composite_score = excluded.composite_score,
      evaluator_notes = excluded.evaluator_notes
  `);

  for (const s of demoRuns) {
    const startTime = new Date(Date.now() - 3600000).toISOString();
    const endTime = new Date(Date.now() - 3600000 + s.durationMs).toISOString();

    insertSession.run(
      s.id, s.taskId, s.agent, startTime, endTime,
      s.durationMs, s.toolsCount, s.errors, s.promptTokens, s.completionTokens,
      s.costUsd, s.filesChanged, s.linesAdded, s.linesDeleted
    );

    insertEval.run(
      "eval-" + s.id, s.id, s.verified, s.correctness, s.speed,
      s.safety, s.quality, s.score, s.notes, now
    );

    let offset = 0;
    for (let i = 0; i < s.traces.length; i++) {
      const t = s.traces[i];
      offset += Math.floor(s.durationMs / (s.traces.length + 1));
      const traceTime = new Date(Date.now() - 3600000 + offset).toISOString();
      insertTrace.run(
        `tr-${s.id}-${i + 1}`,
        s.id,
        s.agent,
        traceTime,
        "post_tool",
        t.dur,
        t.cat,
        t.raw,
        t.in,
        t.out,
        t.out.includes("FAIL") ? "error" : "success",
        t.out.includes("FAIL") ? t.out : null,
        JSON.stringify({ simulated: true })
      );
    }
  }

  console.log("[AgentTrace Hub] Demo benchmark data verified and seeded successfully.");
}

seedDemoData();

// HTTP Router & Request Handling
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;
  const startUs = process.hrtime.bigint();

  // Helper JSON response
  function sendJson(statusCode, data) {
    const payload = JSON.stringify(data);
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(payload);
  }

  // Handle CORS Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  // API 1: Ultra-fast Trace Ingestion (< 1ms target response)
  if (req.method === "POST" && pathname === "/api/traces") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const endUs = process.hrtime.bigint();
      const latencyMs = Number(endUs - startUs) / 1e6;

      try {
        const item = JSON.parse(body || "{}");
        ingestTraceItem(item);
        sendJson(200, { ok: true, serverLatencyMs: latencyMs });
      } catch (err) {
        sendJson(400, { ok: false, error: err.message });
      }
    });
    return;
  }

  // API 2: List Tasks
  if (req.method === "GET" && pathname === "/api/tasks") {
    const tasks = db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all();
    return sendJson(200, { tasks });
  }

  // API 3: List Sessions
  if (req.method === "GET" && pathname === "/api/sessions") {
    const sessions = db.prepare(`
      SELECT s.*, t.name as task_name, e.composite_score, e.verified_pass
      FROM sessions s
      LEFT JOIN tasks t ON s.task_id = t.id
      LEFT JOIN evaluations e ON s.id = e.session_id
      ORDER BY s.start_time DESC
    `).all();
    return sendJson(200, { sessions });
  }

  // API 4: Get Traces for Session
  if (req.method === "GET" && pathname === "/api/traces") {
    const sessionId = parsedUrl.searchParams.get("sessionId");
    if (!sessionId) {
      return sendJson(400, { error: "Missing sessionId parameter" });
    }
    const traces = db.prepare("SELECT * FROM traces WHERE session_id = ? ORDER BY timestamp ASC").all(sessionId);
    return sendJson(200, { traces });
  }

  // API 5: Compare Agents for a Task
  if (req.method === "GET" && pathname === "/api/compare") {
    const taskId = parsedUrl.searchParams.get("taskId") || "task-race-cache";
    const sessions = db.prepare(`
      SELECT s.*, t.name as task_name, t.description as task_desc,
             e.verified_pass, e.rubric_correctness, e.rubric_speed,
             e.rubric_safety, e.rubric_code_quality, e.composite_score, e.evaluator_notes
      FROM sessions s
      JOIN tasks t ON s.task_id = t.id
      LEFT JOIN evaluations e ON s.id = e.session_id
      WHERE s.task_id = ?
    `).all(taskId);

    // Fetch tool breakdowns and trace timelines for each session
    const compared = sessions.map((sess) => {
      const traces = db.prepare("SELECT * FROM traces WHERE session_id = ? ORDER BY timestamp ASC").all(sess.id);

      // Tool category aggregation
      const toolBreakdown = {};
      traces.forEach((tr) => {
        toolBreakdown[tr.tool_category] = (toolBreakdown[tr.tool_category] || 0) + 1;
      });

      return {
        ...sess,
        toolBreakdown,
        traces,
      };
    });

    return sendJson(200, { taskId, agents: compared });
  }

  // API 6: Save Evaluation
  if (req.method === "POST" && pathname === "/api/eval") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const { sessionId, verifiedPass, correctness, speed, safety, codeQuality, notes } = data;

        const composite = (
          (Number(correctness || 5) * 0.35) +
          (Number(speed || 5) * 0.25) +
          (Number(safety || 5) * 0.20) +
          (Number(codeQuality || 5) * 0.20)
        ) * 20;

        const stmt = db.prepare(`
          INSERT INTO evaluations (
            id, session_id, verified_pass, rubric_correctness, rubric_speed,
            rubric_safety, rubric_code_quality, composite_score, evaluator_notes, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            verified_pass = excluded.verified_pass,
            rubric_correctness = excluded.rubric_correctness,
            rubric_speed = excluded.rubric_speed,
            rubric_safety = excluded.rubric_safety,
            rubric_code_quality = excluded.rubric_code_quality,
            composite_score = excluded.composite_score,
            evaluator_notes = excluded.evaluator_notes
        `);

        stmt.run(
          "eval-" + sessionId,
          sessionId,
          verifiedPass ? 1 : 0,
          correctness || 5,
          speed || 5,
          safety || 5,
          codeQuality || 5,
          composite,
          notes || "",
          new Date().toISOString()
        );

        sendJson(200, { ok: true, compositeScore: composite });
      } catch (err) {
        sendJson(400, { ok: false, error: err.message });
      }
    });
    return;
  }

  // API 7: Export Benchmark Report
  if (req.method === "GET" && pathname === "/api/export") {
    const rows = db.prepare(`
      SELECT s.agent, t.name as task_name, s.total_duration_ms, s.tool_call_count,
             s.error_count, s.prompt_tokens, s.completion_tokens, s.cost_usd,
             s.files_changed, e.composite_score, e.verified_pass, e.evaluator_notes
      FROM sessions s
      JOIN tasks t ON s.task_id = t.id
      LEFT JOIN evaluations e ON s.id = e.session_id
      ORDER BY t.name, s.agent
    `).all();

    return sendJson(200, { exportedAt: new Date().toISOString(), report: rows });
  }

  // Static File Serving
  let filePath = path.join(__dirname, "public", pathname === "/" ? "index.html" : pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, "public", "index.html");
  }

  try {
    const ext = path.extname(filePath);
    const contentTypes = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml",
    };
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentTypes[ext] || "text/plain" });
    res.end(content);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`========================================================`);
  console.log(`🚀 AgentTrace Hub running at: http://localhost:${PORT}`);
  console.log(`   - Live Telemetry Ingestion: POST http://localhost:${PORT}/api/traces`);
  console.log(`   - Interactive UI:          http://localhost:${PORT}`);
  console.log(`========================================================`);
});
