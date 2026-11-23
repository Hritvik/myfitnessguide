import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ACCESS_REFUSED, type ApiReply } from "./api.ts";
import type { Mode } from "./tools.ts";

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

const option = (o: unknown): string => (typeof o === "string" ? o : JSON.stringify(o));

/**
 * The API's question, put first so the model asks it rather than guessing.
 * Nothing was written and the key was not used up, so the retry carries the
 * same key (DECISIONS.md in the worker, decision 2).
 */
function clarification(body: Record<string, unknown>, mode: Mode): CallToolResult {
  const { status: _status, question, options, path, ...rest } = body;
  if (mode === "unattended") {
    // Nobody to ask in a scheduled run (MCP decision 21): the entry waits for a person.
    const lines = ["NEEDS CLARIFICATION — nothing was written. There is nobody to ask: do not guess and do not retry; leave this entry pending and go on to the next.", `The question a person will answer: ${String(question)}`];
    if (Object.keys(rest).length > 0) lines.push(`Details: ${JSON.stringify(rest)}`);
    return text(lines.join("\n"));
  }
  const lines = ["NEEDS CLARIFICATION — nothing was written. Do not guess; ask the user.", `Ask the user: ${String(question)}`];
  if (Array.isArray(options) && options.length > 0) {
    lines.push("Options:", ...options.map((o, i) => `  ${i + 1}. ${option(o)}`));
  }
  if (Array.isArray(path) && path.length > 0) lines.push(`Field needing the answer: ${path.join(".")}`);
  lines.push(
    "Then call this tool again with the answer filled in. For a write, keep the same idempotency_key: nothing was written, so the key is still unused.",
  );
  if (Object.keys(rest).length > 0) lines.push(`Details: ${JSON.stringify(rest)}`);
  return text(lines.join("\n"));
}

interface Issue {
  path?: (string | number)[];
  message?: string;
}

function invalid(body: Record<string, unknown>): CallToolResult {
  const issues = Array.isArray(body.issues) ? (body.issues as Issue[]) : [];
  const lines = ["Invalid input; nothing was written. Fix these fields and call again:"];
  for (const i of issues) lines.push(`- ${i.path && i.path.length > 0 ? i.path.join(".") : "(input)"}: ${i.message ?? "invalid"}`);
  return text(lines.join("\n"), true);
}

const HINTS: Record<Mode, Record<string, string>> = {
  interactive: {
    idempotency_key_reused:
      "This key already belongs to a different write. If this is a new write, call again with a new idempotency_key; if it is a retry, send exactly the original arguments.",
  },
  unattended: {
    idempotency_key_reused: "This entry was already written. Do not retry under another key; leave it pending and stop.",
  },
};

function apiError(status: number, body: Record<string, unknown>, mode: Mode): CallToolResult {
  const e = (body.error ?? {}) as { code?: string; message?: string };
  const { code: _c, message: _m, ...details } = e;
  const lines = [`Error ${e.code ?? "unknown"} (HTTP ${status}): ${e.message ?? JSON.stringify(body)}`];
  const hint = e.code ? HINTS[mode][e.code] : undefined;
  if (hint) lines.push(hint);
  if (Object.keys(details).length > 0) lines.push(`Details: ${JSON.stringify(details)}`);
  return text(lines.join("\n"), true);
}

/** Map one API reply to what the model sees. */
export function toToolResult(reply: ApiReply, mode: Mode = "interactive"): CallToolResult {
  if (reply.kind === "json") {
    const { body, status } = reply;
    if (body.status === "needs_clarification") return clarification(body, mode);
    if (body.status === "invalid") return invalid(body);
    if (body.status === "error") return apiError(status, body, mode);
    if (status < 200 || status >= 300) return text(`HTTP ${status}: ${JSON.stringify(body).slice(0, 500)}`, true);
    if (reply.headers.get("idempotent-replay") === "true") {
      return text(`This write was already applied under this idempotency_key; nothing new was written. The original result:\n${JSON.stringify(body)}`);
    }
    return text(JSON.stringify(body));
  }
  if (reply.kind === "other") return text(`HTTP ${reply.status} from the API without JSON: ${reply.text.slice(0, 500)}`, true);
  return text(`${ACCESS_REFUSED} (HTTP ${reply.status} from Cloudflare Access; the Worker never saw the request, so nothing was written.)`, true);
}

/** The request never got an answer: a write may or may not have applied. */
export function unreachable(message: string): CallToolResult {
  return text(
    `${message}. The API did not answer, so a write may or may not have been applied. Retry with exactly the same arguments and the same idempotency_key: if it was applied, the API replays the original result instead of writing twice.`,
    true,
  );
}
