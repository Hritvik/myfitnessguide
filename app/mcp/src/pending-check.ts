// Ticket 78 step 3, the logic (no side effects; the script is pending.ts).
// Is anything waiting in the Inbox? One read-only
// `inbox_entries` call as the agent, with the MCP server's own URL and
// service token (config.ts, api.ts), so a scheduler can skip starting
// Claude when nothing is pending.
//   npm run pending -w @myfitnessguide/mcp
// Exit 0: nothing pending. Exit 10: something pending. Any other exit: an
// error (1), and the scheduler should not read it as "nothing to do".
// Prints one line to stderr with the count only: never an entry's text,
// never the token.
import { ACCESS_REFUSED, ApiClient, type ApiReply } from "./api.ts";

export const NOTHING_PENDING = 0;
export const SOMETHING_PENDING = 10;
export const FAILED = 1;

export type PendingResult = { ok: true; count: number; truncated: boolean } | { ok: false; reason: string };

/** Read the pending count out of `inbox_entries`' reply; anything unexpected is an error, never "none". */
export function pendingFrom(reply: ApiReply): PendingResult {
  if (reply.kind === "access_refused") return { ok: false, reason: `${ACCESS_REFUSED} (HTTP ${reply.status})` };
  if (reply.kind === "other") return { ok: false, reason: `inbox_entries answered HTTP ${reply.status} without JSON` };
  const { status, body } = reply;
  if (status !== 200 || body.status !== "ok") {
    const e = (body.error ?? {}) as { code?: unknown };
    const code = typeof e.code === "string" ? e.code : String(body.status ?? "unknown");
    return { ok: false, reason: `inbox_entries answered HTTP ${status} (${code})` };
  }
  if (!Array.isArray(body.entries)) return { ok: false, reason: "inbox_entries answered without an entries list" };
  return { ok: true, count: body.entries.length, truncated: body.truncated === true };
}

/** The exit code for a result. */
export function exitCodeFor(result: PendingResult): number {
  if (!result.ok) return FAILED;
  return result.count === 0 ? NOTHING_PENDING : SOMETHING_PENDING;
}

/** The one stderr line: a count or a reason, nothing from any entry. */
export function describe(result: PendingResult): string {
  if (!result.ok) return `FAILED: ${result.reason}`;
  if (result.count === 0) return "nothing pending";
  return `${result.count}${result.truncated ? "+" : ""} pending`;
}

/** Ask the API once. Errors (a bad token file, an unreachable API) become a failed result. */
export async function checkPending(opts: { baseUrl: string; tokenFile: string; timeoutMs?: number }): Promise<PendingResult> {
  try {
    const api = new ApiClient({ ...opts, log: () => {} });
    return pendingFrom(await api.request("POST", "/tools/inbox_entries", { status: "pending" }));
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}
