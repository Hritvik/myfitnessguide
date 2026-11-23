/**
 * A record's audit trail in words (spec §8): who, when, what and why, for
 * every version, retractions included. An import is "Imported from Sheets";
 * a row a ruling changed says "corrected at import: <the ruling>", from the
 * importer's write-log reason ("import <file> <tab> row <n>, as ruled: ...").
 */
import type { HistoryVersion } from "./types";

export interface AuditLine {
  when: string;
  who: string;
  what: string;
  why: string | null;
}

const RULED = ", as ruled: ";
const VERB: Record<HistoryVersion["action"], string> = {
  create: "created it", amend: "changed it", confirm: "confirmed it", reject: "rejected it", delete: "removed it", retract: "retracted it",
};
/** Bookkeeping columns that change with state, not with what was recorded. */
const QUIET = new Set(["state", "confirmed_at", "id"]);

function who(v: HistoryVersion): string {
  if (v.origin === "import") return "Imported from Sheets";
  if (v.resolver === "system") return "Auto-confirm";
  if (v.resolver === "member") return v.actor ?? "A member";
  if (v.speaker) return `The agent, talking with ${v.speaker}`;
  return v.origin === "inbox" ? "The Inbox" : "The agent";
}

const show = (x: unknown) => (x === null || x === undefined || x === "" ? "blank" : String(x));

function what(v: HistoryVersion, before: HistoryVersion | undefined): string {
  if (v.action !== "amend" || !before) return VERB[v.action];
  const changed = Object.keys(v.data).filter((k) => !QUIET.has(k) && JSON.stringify(v.data[k]) !== JSON.stringify(before.data[k]));
  if (changed.length === 0) return VERB.amend;
  return `changed ${changed.map((k) => `${k.replace(/_/g, " ")} from ${show(before.data[k])} to ${show(v.data[k])}`).join("; ")}`;
}

function why(v: HistoryVersion): string | null {
  const r = v.reason;
  if (!r) return null;
  if (v.origin === "import") {
    const at = r.indexOf(RULED);
    return at === -1 ? null : `corrected at import: ${r.slice(at + RULED.length)}`;
  }
  // The API's default when no reason was given repeats the tool; it says nothing.
  if (r === `${v.tool} (${v.origin})`) return null;
  return r;
}

export function auditLines(versions: HistoryVersion[], timeZone: string): AuditLine[] {
  const clock = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone });
  return versions.map((v, i) => ({ when: clock.format(new Date(v.created_at)).replace(/,/g, ""), who: who(v), what: what(v, versions[i - 1]), why: why(v) }));
}

/**
 * How a record that is no longer a draft settled, from its last version:
 * removed, confirmed by itself (the hourly auto-confirm) or confirmed by
 * someone, and when, in History's own time format; null while it is still
 * a draft. Drafts to check and Waiting on you each word it their way.
 */
export function settledHow(versions: readonly HistoryVersion[], timeZone: string): { how: "removed" | "by_itself" | "confirmed"; when: string } | null {
  const last = versions.at(-1);
  if (!last) return null;
  const when = auditLines([last], timeZone)[0]?.when ?? "";
  if (last.action === "reject" || last.action === "retract" || last.action === "delete") return { how: "removed", when };
  if (last.data.state !== "confirmed") return null;
  return { how: last.resolver === "system" ? "by_itself" : "confirmed", when };
}
