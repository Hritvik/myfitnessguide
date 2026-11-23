import type { Identity, Verifier } from "./auth";
import { Ctx, isoSeconds, type Caller, type Member, type ServicePrincipal, type WriteChannel, type WriteFields } from "./context";
import { all, first, type Db } from "./db";
import { Clarify, ToolError } from "./errors";
import { describeTools, type Tool } from "./tool";
import { TOOLS } from "./tools";
import { WriteTx } from "./write";
import { handleRemoteMcp } from "./remote-mcp";

export interface AppOptions {
  db: Db;
  verify: Verifier;
  /** Service-token client id -> its server-owned resolver and execution channel. */
  serviceTokens: Record<string, ServicePrincipal>;
  now?: () => Date;
  timeZone?: string;
  tools?: readonly Tool[];
  /** Stable for one OAuth grant, so client-supplied logical write keys cannot collide across clients. */
  remoteMcpConnectionId?: string;
}

export interface App {
  fetch(request: Request): Promise<Response>;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/** Translate the two partial-unique races that protect programme succession. */
export function programmeRevisionConflict(message: string): ToolError | null {
  return /UNIQUE constraint failed: programme\.(supersedes_programme_id|member_id)\b/.test(message)
    ? new ToolError("programme_changed", "The active programme changed while this revision was being saved; reload it and retry against the new active programme.", 409)
    : null;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** JSON with sorted keys, so the same request always hashes the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Who is calling, with the household's members, in one statement (decision
 * 96): a member by their Access email, or the agent for the deployment's
 * one household.
 */
async function resolveCaller(
  db: Db,
  identity: Identity,
  serviceTokens: Record<string, ServicePrincipal>,
  memberChannel: Extract<WriteChannel, "web" | "remote_mcp">,
): Promise<{ caller: Caller; members: Member[] } | null> {
  if (identity.kind === "member") {
    const members = await all<Member>(
      db,
      "SELECT * FROM member WHERE household_id = (SELECT household_id FROM member WHERE email = ? COLLATE NOCASE AND active = 1) ORDER BY id",
      identity.email,
    );
    const m = members.find((r) => r.email.toLowerCase() === identity.email.toLowerCase() && r.active === 1);
    return m ? { caller: { kind: "member", memberId: m.id, householdId: m.household_id, name: m.name, channel: memberChannel }, members } : null;
  }
  if (!Object.hasOwn(serviceTokens, identity.clientId)) return null;
  const principal = serviceTokens[identity.clientId];
  if (!principal) return null;
  // One household per deployment; the agent acts within it.
  const rows = await all<Member & { _household: number; id: number | null }>(
    db,
    "SELECT h.id AS _household, m.* FROM household h LEFT JOIN member m ON m.household_id = h.id WHERE h.id = (SELECT id FROM household ORDER BY id LIMIT 1) ORDER BY m.id",
  );
  const head = rows[0];
  if (!head) return null;
  const members = rows.filter((r) => r.id !== null).map(({ _household: _h, ...m }) => m as Member);
  return { caller: { kind: "agent", ...principal, householdId: head._household, clientId: identity.clientId }, members };
}

const MAX_ATTEMPTS = 3;

export function createApp(options: AppOptions): App {
  const tools = options.tools ?? TOOLS;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const clock = options.now ?? (() => new Date());
  const timeZone = options.timeZone ?? "Asia/Kolkata";
  const { db } = options;

  async function runWrite(ctx: Ctx, tool: Tool, input: WriteFields & Record<string, unknown>): Promise<Response> {
    const { idempotency_key: key, ...rest } = input;
    const requestHash = await sha256(canonical({ tool: tool.name, input: rest }));
    const answer = (prior: { tool: string; request_hash: string; response: string }): Response => {
      if (prior.tool !== tool.name || prior.request_hash !== requestHash) {
        throw new ToolError("idempotency_key_reused", `idempotency key ${key} was used for a different request`, 409);
      }
      return json(JSON.parse(prior.response), 200, { "idempotent-replay": "true" });
    };
    const replay = async (): Promise<Response | null> => {
      const prior = await first<{ tool: string; request_hash: string; response: string }>(db, "SELECT tool, request_hash, response FROM idempotency_key WHERE key = ?", key);
      return prior ? answer(prior) : null;
    };
    // The key's earlier answer and the next write id in one statement (decision 96).
    const probe = await first<{ tool: string | null; request_hash: string | null; response: string | null; next_id: number }>(
      db,
      `SELECT k.tool, k.request_hash, k.response, (SELECT coalesce(max(id), 0) + 1 FROM write_log) AS next_id
       FROM (SELECT 1) AS one LEFT JOIN idempotency_key AS k ON k.key = ?`,
      key,
    );
    if (probe && probe.tool !== null) return answer(probe as { tool: string; request_hash: string; response: string });

    // Who the write is by, and in what setting.
    let speaker: Member | null = null;
    let origin: "live" | "coach" | "inbox" | "app";
    if (ctx.caller.kind === "member") {
      origin = "app";
      speaker = await ctx.memberById(ctx.caller.memberId);
    } else {
      origin = input.origin ?? "live";
      if (input.speaker !== undefined) speaker = await ctx.member(input.speaker, ["speaker"]);
      else if (origin !== "inbox") {
        throw new Clarify("speaker_required", "Which member is the agent talking with?", (await ctx.members()).map((m) => m.name), [
          "speaker",
        ]);
      }
    }

    for (let attempt = 1; ; attempt++) {
      const writeId =
        attempt === 1 && probe ? probe.next_id : ((await first<{ m: number }>(db, "SELECT coalesce(max(id), 0) + 1 AS m FROM write_log"))?.m ?? 1);
      const at = ctx.nowIso();
      const tx = new WriteTx(db, writeId, at);
      ctx.tx = tx;
      ctx.write = { origin, speaker, onBehalfOf: null };
      const result = await tool.run(ctx, input);
      const response = { status: "ok", write_id: writeId, ...result };
      const c = ctx.caller;
      const writeLog = db
        .prepare(
          `INSERT INTO write_log (id, at, resolver, resolver_detail, actor_member_id, on_behalf_of_member_id, origin, tool, reason, speaker_member_id, channel)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          writeId,
          at,
          c.kind === "member" ? "member" : c.resolver,
          input.resolver_detail ?? (c.kind === "agent" ? c.clientId : null),
          c.kind === "member" ? c.memberId : null,
          ctx.write.onBehalfOf,
          origin,
          tool.name,
          (typeof input.change_reason === "string" && input.change_reason.trim().length > 0 ? input.change_reason.trim() : input.reason) ?? `${tool.name} (${origin})`,
          // The member the agent was talking with; a member's own write already names them as the actor.
          c.kind === "agent" ? (speaker?.id ?? null) : null,
          c.channel ?? (c.kind === "member" ? "web" : c.resolver === "importer" ? "import" : "local_agent"),
        );
      const idem = db
        .prepare(
          "INSERT INTO idempotency_key (key, tool, request_hash, write_id, response, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(key, tool.name, requestHash, writeId, JSON.stringify(response), at);
      try {
        await db.batch([writeLog, ...tx.finish(), idem]);
        return json(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/UNIQUE constraint failed: idempotency_key\.key/.test(message)) {
          const again = await replay();
          if (again) return again;
        }
        // the inbox_entry_closes_once trigger: another call closed the entry between its read and its write.
        if (/inbox_entry_not_pending/.test(message)) throw new ToolError("not_pending", "the inbox entry was closed by another call", 409);
        // A concurrent answer is refused by question_answers_once.
        if (/question_not_open/.test(message)) throw new ToolError("not_open", "the question was answered or settled by another call", 409);
        const programmeConflict = programmeRevisionConflict(message);
        if (programmeConflict) throw programmeConflict;
        // Two calls allocated the same id or ref at once: allocate again.
        if (/UNIQUE constraint failed: (\w+\.id|food_source\.ref|recipe\.ref)\b/.test(message) && attempt < MAX_ATTEMPTS) continue;
        // Every attempt lost its write id to another write (decision 132): nothing landed, so the same
        // key can be sent again. Any other UNIQUE failure stays a 422.
        if (/UNIQUE constraint failed: write_log\.id\b/.test(message)) throw new ToolError("busy", "The app is busy; try again.", 503);
        throw new ToolError("constraint", message, 422);
      }
    }
  }

  async function handleTool(request: Request, name: string): Promise<Response> {
    const tool = byName.get(name);
    if (!tool) return json(new ToolError("unknown_tool", `no tool ${name}`, 404).toResponse(), 404);
    if (request.method !== "POST") return json(new ToolError("method", "use POST", 405).toResponse(), 405);

    const identity = await options.verify(request);
    if (!identity) return json(new ToolError("unauthenticated", "no valid Access identity", 401).toResponse(), 401);
    const resolved = await resolveCaller(db, identity, options.serviceTokens, "web");
    if (!resolved) return json(new ToolError("forbidden", "this identity is not a member or a known service token", 403).toResponse(), 403);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(new ToolError("invalid_json", "the body must be JSON").toResponse(), 400);
    }
    const parsed = tool.input.safeParse(body);
    if (!parsed.success) {
      return json(
        {
          status: "invalid",
          issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message, code: i.code })),
        },
        400,
      );
    }

    const ctx = new Ctx(db, resolved.caller, clock, timeZone, resolved.members);
    try {
      if (tool.write) return await runWrite(ctx, tool, parsed.data as WriteFields & Record<string, unknown>);
      return json({ status: "ok", ...(await tool.run(ctx, parsed.data)) });
    } catch (error) {
      if (error instanceof Clarify) return json(error.toResponse());
      if (error instanceof ToolError) return json(error.toResponse(), error.httpStatus);
      throw error;
    }
  }

  async function memberFor(request: Request): Promise<{ caller: Extract<Caller, { kind: "member" }>; members: Member[] } | Response> {
    const identity = await options.verify(request);
    if (!identity) return json(new ToolError("unauthenticated", "no valid Access identity", 401).toResponse(), 401);
    const resolved = await resolveCaller(db, identity, options.serviceTokens, "remote_mcp");
    if (!resolved) return json(new ToolError("forbidden", "this identity is not an active member", 403).toResponse(), 403);
    if (resolved.caller.kind !== "member") return json(new ToolError("forbidden", "the remote MCP is for signed-in members only", 403).toResponse(), 403);
    return { caller: resolved.caller, members: resolved.members };
  }

  async function invokeResolved(tool: Tool, input: Record<string, unknown>, resolved: { caller: Caller; members: Member[] }): Promise<Response> {
    const parsed = tool.input.safeParse(input);
    if (!parsed.success) {
      return json({ status: "invalid", issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message, code: i.code })) }, 400);
    }
    const ctx = new Ctx(db, resolved.caller, clock, timeZone, resolved.members);
    try {
      if (tool.write) return await runWrite(ctx, tool, parsed.data as WriteFields & Record<string, unknown>);
      return json({ status: "ok", ...(await tool.run(ctx, parsed.data)) });
    } catch (error) {
      if (error instanceof Clarify) return json(error.toResponse());
      if (error instanceof ToolError) return json(error.toResponse(), error.httpStatus);
      throw error;
    }
  }

  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/tools" && request.method === "GET") {
        const identity = await options.verify(request);
        if (!identity) return json(new ToolError("unauthenticated", "no valid Access identity", 401).toResponse(), 401);
        if (!(await resolveCaller(db, identity, options.serviceTokens, "web"))) {
          return json(new ToolError("forbidden", "this identity is not a member or a known service token", 403).toResponse(), 403);
        }
        return json({ tools: describeTools(tools) });
      }
      if (url.pathname === "/mcp") {
        const resolved = await memberFor(request);
        if (resolved instanceof Response) return resolved;
        const connection = options.remoteMcpConnectionId ?? "legacy";
        return handleRemoteMcp(request, `${resolved.caller.memberId}:${connection}`, tools, (tool, input) => invokeResolved(tool, input, resolved));
      }
      const match = /^\/tools\/([a-z_]+)$/.exec(url.pathname);
      if (match) return handleTool(request, match[1] as string);
      return json(new ToolError("not_found", `no route ${url.pathname}`, 404).toResponse(), 404);
    },
  };
}

export { isoSeconds };
