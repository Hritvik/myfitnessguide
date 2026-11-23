#!/usr/bin/env node
// Stdio entry point. stdout carries only MCP protocol; everything else goes to stderr.
import { randomBytes } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION } from "./api.ts";
import { loadConfig } from "./config.ts";
import { startGymServer } from "./server.ts";

const log = (line: string): void => {
  process.stderr.write(`[myfitnessguide-mcp] ${line}\n`);
};

// One id per server process: it scopes the model's idempotency keys (see DECISIONS.md).
const sessionId = `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(4).toString("hex")}`;

try {
  const config = loadConfig();
  const server = await startGymServer({ ...config, log, sessionId });
  await server.connect(new StdioServerTransport());
  const mode = config.unattended ? "unattended (every write a draft, origin inbox)" : "interactive";
  log(`myfitnessguide-mcp ${VERSION} ready: ${config.baseUrl}, session ${sessionId}, ${mode}`);
} catch (error) {
  log(`failed to start: ${(error as Error).message}`);
  process.exit(1);
}
