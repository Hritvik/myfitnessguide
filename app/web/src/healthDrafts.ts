/**
 * "Drafts to check" (spec addendum 7 Oct 2026, C): draft readings on
 * Progress, draft blood draws on Health, each with who logged it and when
 * it confirms by itself (the strip's wording), to confirm or reject.
 * Words only; every value is health_drafts'.
 */
import { day, longDay, plural, qty } from "./format";
import { settledHow } from "./history";
import { waitsText } from "./strip";
import type { HealthDrafts, HistoryVersion, RecordRef } from "./types";
import { planStep, type Plan } from "./writes";

export interface DraftRow {
  key: string;
  ref: RecordRef;
  text: string;
  note: string;
}

const BODY_STATE: Record<string, string | null> = { fasted: "fasted", fed: "fed", post_exercise: "after exercise", not_recorded: null };

const noteOf = (d: { logged_by: string | null; deadline: string | null }, timeZone: string) =>
  `Logged by ${d.logged_by ?? "the agent"}; ${waitsText({ deadline: d.deadline, waits: null }, timeZone, "waits for you")}.`;

export function draftRows(d: HealthDrafts, kind: "reading" | "blood_draw", timeZone: string): DraftRow[] {
  if (kind === "reading") {
    return d.readings.map((r) => ({
      key: `reading:${r.id}`,
      ref: { table: "reading", id: r.id },
      text: [`${r.label} ${qty(r.value)} ${r.unit}`, r.side, BODY_STATE[r.body_state] ?? null, day(r.date)].filter((p): p is string => !!p).join(", "),
      note: noteOf(r, timeZone),
    }));
  }
  return d.draws.map((w) => ({
    key: `blood_draw:${w.id}`,
    ref: { table: "blood_draw", id: w.id },
    text: `${w.lab}, ${longDay(w.drawn_on)}, ${plural(w.results, "result", "results")}`,
    note: noteOf(w, timeZone),
  }));
}

const REASON: Record<string, string> = { reading: "Rejected in the app: not my reading", blood_draw: "Rejected in the app: not my blood draw" };

export function rejectHealthPlan(ref: RecordRef): Plan {
  return { steps: [planStep("reject", { records: [ref], reason: REASON[ref.table] ?? "Rejected in the app" })], done: "Removed." };
}

/**
 * The way to change a confirmed record now. History in the app is
 * read-only and the app has no retract: a reading is retracted through
 * chat; a blood draw can't be retracted at all (`RETRACTABLE`), only amended.
 */
const NOW: Record<string, string> = {
  reading: "To remove it now, ask Claude in chat to retract it.",
  blood_draw: "A confirmed blood draw can't be removed; to correct it, ask Claude in chat.",
};

/**
 * What to say when a tapped draft is no longer one (the hourly auto-confirm
 * confirmed it while shown, so the API said not_draft, or it was decided
 * elsewhere), from its history; null while it is still a draft, so a real
 * failure keeps "Try again". The time is History's own (`auditLines`).
 */
export function settledNote(table: string, versions: readonly HistoryVersion[], timeZone: string): string | null {
  const s = settledHow(versions, timeZone);
  if (!s) return null;
  if (s.how === "removed") return `Already removed, on ${s.when}.`;
  const how = s.how === "by_itself" ? `This confirmed itself on ${s.when}.` : `This was confirmed on ${s.when}.`;
  return `${how} ${NOW[table] ?? NOW.reading}`;
}
