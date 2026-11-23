import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { ApiReply, ApiTool } from "./api.ts";

/** The API caps keys at 200; the session prefix takes the rest. */
export const MAX_MODEL_KEY = 160;

export const WRITE_GUIDE = [
  "WRITE TOOL — every call needs idempotency_key, speaker and origin.",
  `idempotency_key: make up a short key naming this one logical write (for example "bench-2026-10-06-set3"). Reuse the same idempotency_key whenever you retry this write — after a timeout or "could not reach" error (send the same arguments), or after needs_clarification (send the answer filled in) — so it is never applied twice. Use a new idempotency_key for each new write, even when its arguments match an earlier one: two identical sets are two writes.`,
  "speaker: the household member you are talking with in this conversation (their name).",
  'origin: "coach" during a Coach-mode training session (replying between sets); "live" for any other conversation with the speaker. Writes about another member, or coach-mode sets, are saved as drafts by the API.',
].join("\n");

/** Interactive: a Claude Code conversation. Unattended: a scheduled run with nobody to ask (decision 21). */
export type Mode = "interactive" | "unattended";

/**
 * The only writes an unattended server registers (decision 21): the two
 * food writes that only ever create new draft rows under origin `inbox`
 * (app/worker/test/unattended-inbox.tools.test.ts checks that no existing
 * row is touched), and closing the entry. Every other write is left out,
 * including any write the Worker adds later: an allow-list fails closed.
 */
export const UNATTENDED_DATA_WRITES: ReadonlySet<string> = new Set(["log_intake", "household_meal"]);
export const UNATTENDED_CLOSE = "resolve_inbox_entry";
export const UNATTENDED_WRITES: ReadonlySet<string> = new Set([...UNATTENDED_DATA_WRITES, UNATTENDED_CLOSE]);

export const UNATTENDED_WRITE_GUIDE = [
  "WRITE TOOL (unattended run) — every call needs idempotency_key. This server saves every write as an Inbox draft (origin inbox), with no speaker and no origin to send. A draft confirms by itself after 48 h unless the member confirms, changes or rejects it first.",
  "idempotency_key: exactly inbox-<entry id>-write for the one data write an entry gets (log_intake or household_meal, every item in that one call), and exactly inbox-<entry id>-close for resolve_inbox_entry. A rerun sends the same keys, so the API replays instead of drafting twice. Any other key is refused.",
  "needs_clarification means nothing was written: leave the entry pending. idempotency_key_reused means the entry already has its write: leave it pending.",
].join("\n");

/**
 * The read a run checks before anything else (decision 21): in unattended
 * mode the server adds `unattended: true` to its ok reply. Its absence means
 * an interactive server, and an unattended run stops.
 */
export const MODE_PROBE = "whoami";
export const MODE_PROBE_NOTE = "This server is UNATTENDED: its ok reply carries unattended: true, added by the server.";

/** The probe's reply with the mode added; any other reply unchanged. */
export function withMode(name: string, mode: Mode, body: Record<string, unknown>, status: number): Record<string, unknown> {
  if (mode !== "unattended" || name !== MODE_PROBE || status !== 200 || body.status !== "ok") return body;
  return { ...body, unattended: true };
}

export function isWrite(tool: ApiTool): boolean {
  if (tool.write !== undefined) return tool.write;
  const props = (tool.input_schema.properties ?? {}) as Record<string, unknown>;
  return "idempotency_key" in props;
}

/**
 * An unattended write's key comes from the Inbox entry, not the session
 * (decision 21): one data write per entry, `inbox-<id>-write`, and one close,
 * `inbox-<id>-close`. A rerun after a crash sends the same keys, so the API
 * replays (same request) or refuses with idempotency_key_reused (any other
 * request, any other tool): an entry never gets a second data write.
 */
export const UNATTENDED_KEY = /^inbox-([1-9][0-9]{0,15})-(write|close)$/;

const refused = (why: string): string => `Refused: ${why} Nothing was written.`;

/**
 * Why the unattended server refuses a write before calling the API, or null.
 * The key must be the entry's fixed key for the tool; a close must name its
 * key's entry, be `resolved`, and carry at least one record (decision 21).
 */
export function unattendedProblem(tool: ApiTool, args: Record<string, unknown>): string | null {
  if (!isWrite(tool)) return null;
  const key = args.idempotency_key;
  const m = typeof key === "string" ? UNATTENDED_KEY.exec(key) : null;
  const close = tool.name === UNATTENDED_CLOSE;
  const want = close ? "inbox-<entry id>-close" : "inbox-<entry id>-write";
  if (!m || m[2] !== (close ? "close" : "write")) {
    return refused(`in an unattended run ${tool.name}'s idempotency_key must be exactly ${want}, got ${JSON.stringify(key)}.`);
  }
  if (!close) return null;
  if (String(args.id) !== m[1]) {
    return refused(`resolve_inbox_entry's id must be the entry its key names (${m[1]}), got ${JSON.stringify(args.id)}.`);
  }
  if (args.status !== "resolved") {
    return refused(`an unattended run only closes an entry as resolved, never ${JSON.stringify(args.status)}: leave it pending for a person.`);
  }
  if (!Array.isArray(args.records) || args.records.length === 0) {
    return refused("an unattended run closes an entry only with the records its write returned; with none, leave it pending.");
  }
  return null;
}

/** The entry an unattended data write is keyed to (after unattendedProblem passed), or null for any other call. */
export function dataWriteEntry(tool: ApiTool, args: Record<string, unknown>): number | null {
  if (!UNATTENDED_DATA_WRITES.has(tool.name) || typeof args.idempotency_key !== "string") return null;
  const m = UNATTENDED_KEY.exec(args.idempotency_key);
  return m && m[2] === "write" ? Number(m[1]) : null;
}

/**
 * Review N1: a data write's `<id>` must be a pending Inbox entry, read fresh
 * from `inbox_entries` (status pending, oldest 100) just before the write,
 * or the model could draft the same food again under another entry's key.
 * Returns why the write is refused, or null when the entry is pending.
 */
export function pendingEntryProblem(id: number, reply: ApiReply): string | null {
  const why = (reason: string) => refused(`${reason} Leave the entry pending.`);
  if (reply.kind !== "json" || reply.status !== 200 || reply.body.status !== "ok" || !Array.isArray(reply.body.entries)) {
    return why(`could not read the pending Inbox entries to check entry ${id} (HTTP ${reply.status}).`);
  }
  const ids = new Set((reply.body.entries as { id?: unknown }[]).map((e) => e.id));
  if (!ids.has(id)) {
    return why(`entry ${id} is not a pending Inbox entry${reply.body.truncated === true ? " among the oldest 100" : ""}: an unattended data write's key must name the pending entry it resolves.`);
  }
  return null;
}

/** Whether this server registers the tool, using the Worker's canonical capability metadata. */
export function servesTool(tool: ApiTool, mode: Mode): boolean {
  const profiles = tool.profiles;
  if (
    !profiles ||
    typeof profiles.remoteMember !== "boolean" ||
    typeof profiles.interactiveAgent !== "boolean" ||
    typeof profiles.unattended !== "boolean"
  ) {
    throw new Error(`Tool ${tool.name} has no valid capability profiles; refusing to expose an unclassified tool.`);
  }
  return mode === "interactive" ? profiles.interactiveAgent : profiles.unattended;
}

/** The MCP tool the model sees: the API's own schema, with the write fields tightened for Claude Code. */
export function toMcpTool(tool: ApiTool, mode: Mode = "interactive"): McpTool {
  const schema = structuredClone(tool.input_schema) as McpTool["inputSchema"] & { required?: string[] };
  if (!isWrite(tool)) {
    const description = mode === "unattended" && tool.name === MODE_PROBE ? `${tool.description ?? ""}\n\n${MODE_PROBE_NOTE}` : (tool.description ?? "");
    return { name: tool.name, description, inputSchema: schema };
  }
  const properties = { ...(schema.properties ?? {}) } as Record<string, Record<string, unknown>>;
  if (mode === "unattended") {
    // The server stamps origin and sends no speaker (toApiArgs), so the model is never asked for either.
    delete properties.origin;
    delete properties.speaker;
    const close = tool.name === UNATTENDED_CLOSE;
    properties.idempotency_key = {
      type: "string",
      pattern: close ? "^inbox-[1-9][0-9]{0,15}-close$" : "^inbox-[1-9][0-9]{0,15}-write$",
      description: close ? "Exactly inbox-<entry id>-close, the id being this call's id." : "Exactly inbox-<entry id>-write: an entry's one data write, the same on every run.",
    };
    const extra: string[] = [];
    if (close) {
      properties.status = { type: "string", const: "resolved", description: "An unattended run only resolves; anything else stays pending for a person." };
      if (properties.records) properties.records = { ...properties.records, minItems: 1 };
      extra.push("records");
    }
    const required = [...new Set([...(schema.required ?? []).filter((r) => r !== "origin" && r !== "speaker"), "idempotency_key", ...extra])];
    return {
      name: tool.name,
      description: tool.description ? `${tool.description}\n\n${UNATTENDED_WRITE_GUIDE}` : UNATTENDED_WRITE_GUIDE,
      inputSchema: { ...schema, properties, required },
    };
  }
  properties.idempotency_key = {
    type: "string",
    minLength: 1,
    maxLength: MAX_MODEL_KEY,
    description: "One key per logical write; reuse it verbatim on every retry of that write, new key for every new write.",
  };
  properties.speaker = {
    type: "string",
    minLength: 1,
    description: "The member the agent is talking with in this conversation.",
  };
  properties.origin = {
    type: "string",
    enum: ["live", "coach"],
    description: "coach: a Coach-mode session, between sets. live: any other conversation with the speaker.",
  };
  const required = [...new Set([...(schema.required ?? []), "idempotency_key", "speaker", "origin"])];
  return {
    name: tool.name,
    description: tool.description ? `${tool.description}\n\n${WRITE_GUIDE}` : WRITE_GUIDE,
    inputSchema: { ...schema, properties, required },
  };
}

/**
 * The body sent to the API. A write's key is scoped to this server session,
 * so the model's short keys can't collide with another session's. In
 * unattended mode the key is the entry's (`inbox:inbox-12-0`), and every
 * write goes as origin `inbox` with no speaker, whatever the model sent.
 */
export function toApiArgs(tool: ApiTool, args: Record<string, unknown>, sessionId: string, mode: Mode = "interactive"): Record<string, unknown> {
  if (!isWrite(tool)) return args;
  const body = { ...args };
  if (mode === "unattended") {
    // Not session-scoped: the key is the entry's (unattendedProblem), the same on every run.
    if (typeof body.idempotency_key === "string") body.idempotency_key = `inbox:${body.idempotency_key}`;
    delete body.speaker;
    body.origin = "inbox";
  } else if (typeof body.idempotency_key === "string") {
    body.idempotency_key = `cc:${sessionId}:${body.idempotency_key}`;
  }
  return body;
}
