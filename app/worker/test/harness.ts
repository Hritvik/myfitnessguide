// Drives the Worker through its HTTP seam: POST /tools/<name> as a member
// or as the agent, against a fresh in-memory database.
import { createApp } from "../src/app";
import type { Identity } from "../src/auth";
import { TOOLS } from "../src/tools";
import { household, type Household } from "./fixtures";
import { CountingDb } from "./counting";
import type { TestDb } from "./db";
import { SqliteDb } from "./sqlite";

export type As = "agent" | "harness" | "hritvik" | "asha" | "kabir" | "stranger" | "unknown_token" | "nobody" | "noor";

const IDENTITIES: Record<As, Identity | null> = {
  agent: { kind: "service", clientId: "mcp-client.access" },
  harness: { kind: "service", clientId: "harness-client.access" },
  hritvik: { kind: "member", email: "Hritvik@Example.com" },
  asha: { kind: "member", email: "asha@example.com" },
  kabir: { kind: "member", email: "kabir@example.com" },
  stranger: { kind: "member", email: "stranger@example.com" },
  unknown_token: { kind: "service", clientId: "someone-else.access" },
  nobody: null,
  noor: { kind: "member", email: "noor@example.com" },
};

const WRITES = new Set(TOOLS.filter((t) => t.write).map((t) => t.name));

export interface Reply {
  http: number;
  body: any;
}

let keySeq = 0;

/** The default household's clock start and the agent's default speaker (setup() with no options). */
const START = "2026-10-05T07:30:00Z";
const SPEAKER = "Hritvik";

/** What a test may vary in the seam (redesign-a plan, R12): its household, the agent's default speaker, the clock's start. */
export interface SetupOptions<H> {
  household?: (t: TestDb) => H;
  speaker?: string;
  now?: string;
}

export function setup<H extends { id: number } = Household>(options: SetupOptions<H> = {}) {
  const db = new SqliteDb();
  const t = db.test;
  const h = (options.household ?? (household as unknown as (t: TestDb) => H))(t);
  const clock = { now: new Date(options.now ?? START) };
  // Every statement the Worker runs goes through the counter (D1's per-invocation query limit).
  const counter = new CountingDb(db);
  const app = createApp({
    db: counter,
    verify: async (request) => IDENTITIES[(request.headers.get("x-test-as") ?? "nobody") as As],
    serviceTokens: {
      "mcp-client.access": { resolver: "claude_code", channel: "local_agent" },
      "harness-client.access": { resolver: "hosted_model", channel: "unattended" },
    },
    now: () => clock.now,
  });

  async function raw(path: string, init: RequestInit & { as?: As } = {}): Promise<Reply> {
    const headers = new Headers(init.headers);
    headers.set("x-test-as", init.as ?? "agent");
    const response = await app.fetch(new Request(`https://api.test${path}`, { ...init, headers }));
    return { http: response.status, body: await response.json() };
  }

  /**
   * Call a tool. Writes get a fresh idempotency key, and agent writes speak
   * with options.speaker (SPEAKER by default), unless the input says otherwise.
   */
  async function call(tool: string, input: Record<string, unknown> = {}, as: As = "agent"): Promise<Reply> {
    const body: Record<string, unknown> = { ...input };
    if (WRITES.has(tool)) {
      if (!("idempotency_key" in body)) body.idempotency_key = `k-${++keySeq}`;
      if ((as === "agent" || as === "harness") && !("speaker" in body) && body.origin !== "inbox") body.speaker = options.speaker ?? SPEAKER;
    }
    for (const [k, v] of Object.entries(body)) if (v === undefined) delete body[k];
    return raw(`/tools/${tool}`, { method: "POST", body: JSON.stringify(body), as });
  }

  /** Call and expect status ok; returns the body. */
  async function ok(tool: string, input: Record<string, unknown> = {}, as: As = "agent"): Promise<any> {
    const reply = await call(tool, input, as);
    if (reply.http !== 200 || reply.body.status !== "ok") {
      throw new Error(`${tool} -> ${reply.http} ${JSON.stringify(reply.body)}`);
    }
    return reply.body;
  }

  /** Call and expect status ok; returns the body and the D1 statements the call ran. */
  async function counted(tool: string, input: Record<string, unknown> = {}, as: As = "agent"): Promise<{ body: any; statements: number; log: string[] }> {
    counter.reset();
    const body = await ok(tool, input, as);
    return { body, statements: counter.count, log: counter.log };
  }

  function advanceHours(hours: number): void {
    clock.now = new Date(clock.now.getTime() + hours * 3_600_000);
  }

  return { db, counter, t, h, clock, app, raw, call, ok, counted, advanceHours };
}

export type Harness = ReturnType<typeof setup<Household>>;
