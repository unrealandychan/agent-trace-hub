import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as http from "node:http";
import * as fs from "node:fs";

/**
 * Pi Agent Tracing Extension - Non-blocking event streaming to AgentTrace Hub.
 * Zero-latency impact: uses asynchronous non-awaiting fire-and-forget I/O.
 */
export default function (pi: ExtensionAPI) {
  const COLLECTOR_HOST = process.env.AGENT_TRACE_HOST || "127.0.0.1";
  const COLLECTOR_PORT = parseInt(process.env.AGENT_TRACE_PORT || "4100", 10);
  const FALLBACK_FILE = process.env.AGENT_TRACE_FILE || "/tmp/agent-traces.jsonl";

  function sendTelemetry(event: string, payload: Record<string, any>) {
    const data = JSON.stringify({
      agent: "pi",
      event,
      timestamp: new Date().toISOString(),
      raw: payload
    });

    const req = http.request(
      {
        hostname: COLLECTOR_HOST,
        port: COLLECTOR_PORT,
        path: "/api/traces",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: 300,
      },
      (res) => {
        res.resume(); // Discard response data cleanly
      }
    );

    req.on("error", () => {
      // Offline fallback: append to JSONL asynchronously
      fs.appendFile(FALLBACK_FILE, data + "\n", () => {});
    });

    req.write(data);
    req.end();
  }

  // Hook tool completions
  pi.on("tool_result", (event) => {
    sendTelemetry("post_tool", {
      toolName: event.toolName,
      isError: event.isError || false,
      resultPreview: typeof event.content === "string" ? event.content.slice(0, 300) : "object",
    });
  });

  // Hook session completion
  pi.on("agent_settled", () => {
    sendTelemetry("stop", {
      status: "settled",
    });
  });
}
