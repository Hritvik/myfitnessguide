import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startGymServer } from "../src/server.ts";

export const CLIENT_ID = "test-client.access";
export const SECRET = "s3cr3t-do-not-leak-0123456789abcdef";

/** One request the fake API received. */
export interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Raw text instead of JSON. */
  text?: string;
  /** Answer only after this long. */
  delayMs?: number;
}

export type Handler = (req: Seen) => FakeResponse;

/** An in-process stand-in for the Worker API. */
export interface FakeApi {
  url: string;
  seen: Seen[];
  handle(handler: Handler): void;
  close(): Promise<void>;
}

/** Listing in the exact shape the Worker's describeTools() serves. */
export const LISTING = {
  tools: [
    {
      name: "day_totals",
      group: "nutrition",
      description: "Totals for one member's day.",
      write: false,
      profiles: { remoteMember: true, interactiveAgent: true, unattended: true },
      endpoint: "/tools/day_totals",
      input_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { member: { type: "string" }, date: { type: "string" } },
        required: ["member"],
        additionalProperties: false,
      },
    },
    {
      name: "log_set",
      group: "training",
      description: "Log one set.",
      write: true,
      profiles: { remoteMember: true, interactiveAgent: true, unattended: false },
      endpoint: "/tools/log_set",
      input_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          session_id: { type: "integer", exclusiveMinimum: 0 },
          reps: { type: "integer" },
          idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
          origin: { type: "string", enum: ["live", "coach", "inbox"] },
          speaker: { type: "string" },
          reason: { type: "string", minLength: 1 },
          resolver_detail: { type: "string" },
        },
        required: ["session_id", "idempotency_key"],
        additionalProperties: false,
      },
    },
  ],
};

export async function startFakeApi(): Promise<FakeApi> {
  const seen: Seen[] = [];
  let handler: Handler = (req) =>
    req.method === "GET" && req.path === "/tools" ? { body: LISTING } : { body: { status: "ok", echo: req.body } };
  const server: HttpServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const s: Seen = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      seen.push(s);
      const r = handler(s);
      const headers = { ...(r.text === undefined ? { "content-type": "application/json" } : {}), ...r.headers };
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(r.status ?? 200, headers);
        res.end(r.text ?? JSON.stringify(r.body ?? {}));
      };
      if (r.delayMs) setTimeout(send, r.delayMs).unref();
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    handle: (h) => (handler = h),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface Harness {
  client: Client;
  logs: string[];
  cacheFile: string;
  dir: string;
  close(): Promise<void>;
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "gym-mcp-"));
}

export function writeToken(dir: string, text = JSON.stringify({ client_id: CLIENT_ID, client_secret: SECRET })): string {
  const file = join(dir, "token.json");
  writeFileSync(file, text);
  return file;
}

/** Start the MCP server against `baseUrl` and connect an MCP client to it in-process. */
export async function connect(opts: {
  baseUrl: string;
  dir?: string;
  sessionId?: string;
  /** Raw token file contents; a valid token by default. */
  tokenText?: string;
  /** Collects log lines; a fresh array by default. */
  logs?: string[];
  timeoutMs?: number;
  /** Start in unattended mode. */
  unattended?: boolean;
}): Promise<Harness> {
  const dir = opts.dir ?? tempDir();
  const cacheFile = join(dir, "cache", "tools.json");
  const logs = opts.logs ?? [];
  const server = await startGymServer({
    baseUrl: opts.baseUrl,
    tokenFile: writeToken(dir, opts.tokenText),
    cacheFile,
    log: (line) => logs.push(line),
    sessionId: opts.sessionId ?? "sess1",
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.unattended === undefined ? {} : { unattended: opts.unattended }),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverSide);
  await client.connect(clientSide);
  return {
    client,
    logs,
    cacheFile,
    dir,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The text of a tool result's single text block. */
export function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content.map((c) => c.text).join("\n");
}
