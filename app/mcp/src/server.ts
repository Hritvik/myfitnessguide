import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ApiClient, Unreachable, VERSION, type ApiTool } from "./api.ts";
import { toToolResult, unreachable } from "./result.ts";
import { dataWriteEntry, pendingEntryProblem, servesTool, toApiArgs, toMcpTool, unattendedProblem, withMode, type Mode } from "./tools.ts";

export interface GymServerOptions {
  baseUrl: string;
  tokenFile: string;
  cacheFile: string;
  /** One line to stderr. Never stdout: stdout carries only MCP protocol. */
  log: (line: string) => void;
  /** Scopes the model's idempotency keys; one per server process. */
  sessionId: string;
  timeoutMs?: number;
  /** Unattended mode (decision 21): only the drafting writes, every write origin `inbox`. Default off. */
  unattended?: boolean;
}

/** The API's listing, falling back to the last good one cached on disk. */
async function loadTools(api: ApiClient, cacheFile: string, log: (line: string) => void): Promise<ApiTool[]> {
  try {
    const tools = await api.listTools();
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ tools }, null, 2));
      renameSync(tmp, cacheFile);
    } catch (error) {
      log(`could not write the tool cache ${cacheFile}: ${(error as Error).message}`);
    }
    return tools;
  } catch (error) {
    const reason = (error as Error).message;
    let cached: ApiTool[];
    try {
      cached = (JSON.parse(readFileSync(cacheFile, "utf8")) as { tools: ApiTool[] }).tools;
    } catch {
      throw new Error(`GET /tools failed (${reason}) and there is no cached tool list at ${cacheFile}`);
    }
    log(`GET /tools failed (${reason}); starting from the cached tool list at ${cacheFile} (${cached.length} tools)`);
    return cached;
  }
}

export async function startGymServer(opts: GymServerOptions): Promise<Server> {
  const api = new ApiClient({
    baseUrl: opts.baseUrl,
    tokenFile: opts.tokenFile,
    log: opts.log,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  const mode: Mode = opts.unattended ? "unattended" : "interactive";
  // The cache keeps the full listing; the mode decides what this process registers.
  const tools = (await loadTools(api, opts.cacheFile, opts.log)).filter((t) => servesTool(t, mode));

  const server = new Server({ name: "myfitnessguide", version: VERSION }, { capabilities: { tools: {} } });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const listed = tools.map((t) => toMcpTool(t, mode));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const tool = byName.get(name);
    if (!tool) {
      const where = mode === "unattended" ? " in this unattended server, which drafts only" : "";
      return { content: [{ type: "text", text: `No tool named ${name}${where}.` }], isError: true };
    }
    if (mode === "unattended") {
      const problem = unattendedProblem(tool, args);
      if (problem) return { content: [{ type: "text", text: problem }], isError: true };
      const entry = dataWriteEntry(tool, args);
      if (entry !== null) {
        // One extra read per data write (at most one per entry): the key must name a pending entry.
        let pending: string | null;
        try {
          pending = pendingEntryProblem(entry, await api.request("POST", "/tools/inbox_entries", { status: "pending" }));
        } catch (error) {
          if (!(error instanceof Unreachable)) throw error;
          opts.log(`${name}: checking entry ${entry}: ${error.message}`);
          pending = `Refused: could not check entry ${entry} (${error.message}). Nothing was written. Leave the entry pending.`;
        }
        if (pending) return { content: [{ type: "text", text: pending }], isError: true };
      }
    }
    try {
      const body = toApiArgs(tool, args, opts.sessionId, mode);
      const reply = await api.request("POST", `/tools/${encodeURIComponent(name)}`, body);
      if (reply.kind === "json") reply.body = withMode(name, mode, reply.body, reply.status);
      return toToolResult(reply, mode);
    } catch (error) {
      if (error instanceof Unreachable) {
        opts.log(`${name}: ${error.message}`);
        return unreachable(error.message);
      }
      throw error;
    }
  });
  return server;
}
