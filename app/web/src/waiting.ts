/**
 * "Waiting on you" (desktop spec §4): every draft someone logged about you
 * and your pending Inbox entries, in one list. Ticked drafts confirm in one
 * write (all or none). A draft that settled meanwhile leaves the list with
 * a note from its history, the other ticks stay, and Confirm is offered
 * again as a new plan (the refused write wrote nothing). Rejecting stays
 * one at a time, with a reason. Words only; every value is the API's.
 */
import { plural } from "./format";
import { settledHow } from "./history";
import { deadlineText, waitsText } from "./strip";
import type { HistoryVersion, HouseholdOverview, InboxEntry, RecordRef, WaitingDraft } from "./types";
import { planStep, type Plan } from "./writes";

export interface WaitingRow {
  key: string;
  /** The draft; null for an Inbox entry, which is read-only here. */
  ref: RecordRef | null;
  text: string;
  note: string;
  /** False for a row that waits on something (end of session, RIR) and for the Inbox. */
  tickable: boolean;
}

const WHAT: Record<string, string> = {
  intake_item: "Food: ",
  portion: "Your share: ",
  leftover_serving: "Your helping: ",
  session: "Session: ",
  session_set: "Set: ",
  reading: "Reading: ",
  blood_draw: "Blood draw: ",
  cook: "Cook: ",
  household_meal: "",
};

const MORE = "More drafts are waiting than shown here. They confirm by themselves at their times; confirm or remove these to see the rest.";

/** Who logged it and when, then when it confirms by itself or why it waits. A draft with no version row comes with an empty logged_at: the "Logged by" clause is left out. */
function draftNote(d: WaitingDraft, timeZone: string): string {
  const waits = waitsText(d, timeZone, "waits for you");
  if (d.logged_at === "" || Number.isNaN(Date.parse(d.logged_at))) return `${waits.charAt(0).toUpperCase()}${waits.slice(1)}.`;
  return `Logged by ${d.logged_by ?? "someone"} ${deadlineText(d.logged_at, timeZone)}; ${waits}.`;
}

export function waitingRows(o: HouseholdOverview, inbox: readonly InboxEntry[], timeZone: string): { rows: WaitingRow[]; more: string | null } {
  const mine = o.waiting_on_you ?? { drafts: [], truncated: false };
  const drafts = mine.drafts.map((d) => ({
    key: `${d.table}:${d.id}`,
    ref: { table: d.table, id: d.id },
    text: `${WHAT[d.table] ?? ""}${d.table === "reading" ? d.summary.replace(/_/g, " ") : d.summary}`,
    note: draftNote(d, timeZone),
    tickable: d.waits === null,
  }));
  const entries = inbox.map((e) => ({ key: `inbox:${e.id}`, ref: null, text: `Inbox: "${e.text}"`, note: `Waiting for Claude; sent ${deadlineText(e.created_at, timeZone)}.`, tickable: false }));
  return { rows: [...drafts, ...entries], more: mine.truncated ? MORE : null };
}

/** One confirm for every ticked row still listed and tickable, in the list's order; null when there is none. */
export function confirmTickedPlan(rows: readonly WaitingRow[], ticked: ReadonlySet<string>): Plan | null {
  const records = rows.filter((r) => r.ref !== null && r.tickable && ticked.has(r.key)).map((r) => r.ref as RecordRef);
  if (records.length === 0) return null;
  return { steps: [planStep("confirm", { records })], done: `Confirmed ${plural(records.length, "draft", "drafts")}.` };
}

/** After a refused batch and a re-read: the ticked rows that left the list, and the ticks that stay (rows still listed and tickable). */
export function afterRefusal(ticked: ReadonlySet<string>, now: readonly WaitingRow[]): { ticked: Set<string>; gone: string[] } {
  const listed = new Map(now.map((r) => [r.key, r]));
  return {
    ticked: new Set([...ticked].filter((k) => listed.get(k)?.tickable === true)),
    gone: [...ticked].filter((k) => !listed.has(k)),
  };
}

/**
 * After a refused batch and a re-read: the rows of the refused plan's records that left the list
 * (in the words of `before`, the rows the plan was made from) and the ticks to keep (the plan's
 * records still listed and tickable). Worked out from the plan, not the ticks on screen, so every
 * settled row of the batch gets its note.
 */
export function settleRefusal(records: readonly RecordRef[], now: readonly WaitingRow[], before: readonly WaitingRow[]): { gone: WaitingRow[]; ticked: Set<string> } {
  const keyOf = (r: RecordRef) => `${r.table}:${r.id}`;
  const after = afterRefusal(new Set(records.map(keyOf)), now);
  const gone = records
    .filter((r) => after.gone.includes(keyOf(r)))
    .map((r) => before.find((b) => b.key === keyOf(r)) ?? { key: keyOf(r), ref: r, text: `${r.table.replace(/_/g, " ")} ${r.id}`, note: "", tickable: false });
  return { gone, ticked: after.ticked };
}

/** A gone row's note: how it settled, from its history (null when the history couldn't be read). */
export function goneNote(row: WaitingRow, versions: readonly HistoryVersion[] | null, timeZone: string): { key: string; text: string; said: string } {
  return { key: row.key, text: row.text, said: (versions ? settledText(versions, timeZone) : null) ?? "No longer waiting on you." };
}

/** How a row that left the list settled (settledHow, in this list's words); null while it is still a draft. */
export function settledText(versions: readonly HistoryVersion[], timeZone: string): string | null {
  const s = settledHow(versions, timeZone);
  if (!s) return null;
  return s.how === "removed" ? `Removed on ${s.when}.` : s.how === "by_itself" ? `Confirmed by itself on ${s.when}.` : `Confirmed on ${s.when}.`;
}

/** "Not mine…": one record, with the member's own reason (never filled in for them). */
export function rejectDraftPlan(ref: RecordRef, reason: string): Plan | { error: string } {
  const why = reason.trim();
  if (why === "") return { error: "Say why it isn't yours; the reason goes in its history." };
  return { steps: [planStep("reject", { records: [ref], reason: why })], done: "Removed." };
}
