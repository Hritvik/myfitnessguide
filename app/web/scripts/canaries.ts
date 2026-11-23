/**
 * The Private shape (e2e spec §3): a marker word in every owner-only field of
 * the stress household, unique to its member and field, inside an ordinary
 * invented sentence, so committed shots still read naturally; and owner-only
 * numbers that occur nowhere else in the household. The seed writes them
 * (`seed-sample.ts --long`), `stressHousehold().canaries` lists them, and the
 * privacy tests look for them where they must not be. The Worker test's
 * SECRET (test/owner-only-sweep.tools.test.ts), carried into the browser.
 * Invented words only.
 *
 * Where else the words land: a canary written through a tool is also copied
 * into the Worker's bookkeeping, `record_version.data` (the row as written)
 * and `idempotency_key.response` (the tool's answer). Neither is read by any
 * tool or screen, so UI and API privacy tests are unaffected; but a check on
 * the database itself that a word or number "occurs once" must leave those two
 * tables out. (The numbers are written by SQL only, so they never reach them.)
 */
import { OWNER_VIA } from "@myfitnessguide/worker/owner-only";

export type CanaryMember = "Asha" | "Kabir" | "Noor";

export interface TextCanary {
  kind: "text";
  member: CanaryMember;
  table: string;
  field: string;
  word: string;
  text: string;
}

export interface NumberCanary {
  kind: "number";
  member: CanaryMember;
  table: "reading" | "lab_result";
  field: "value";
  what: "fasted weight" | "waist" | "marker";
  value: number;
  /** As the app shows it, and as the database dump prints it. */
  shown: string;
}

export type Canary = TextCanary | NumberCanary;

/** Every owner-only text field (records' OWNER_ONLY tables with free text, every OWNER_TEXT field), and EXTRA_FIELDS: the history's write reasons and the Inbox texts. */
export const TEXT_FIELDS = [
  ["reading", "note"], ["blood_draw", "note"], ["lab_result", "note"], ["flag", "note"],
  ["member_note", "topic"], ["member_note_version", "body"], ["measurement_cadence", "message"], ["feedback", "text"],
  ["hr_zone", "basis"], ["method_change", "note"], ["target", "reasoning"], ["goal_point", "note"],
  ["phase", "intent"], ["prescription", "cue"], ["prescription", "fallback_note"], ["legacy_audit_entry", "reason"],
  ["session", "note"], ["session_set", "note"], ["cardio_block", "note"], ["load_change", "reason"],
  ["schedule_swap", "reason"], ["write_log", "reason"], ["inbox_entry", "text"], ["question", "text"],
] as const;

/**
 * Owner-only text outside OWNER_ONLY and OWNER_TEXT, each by its own rule: a
 * write's reason (Worker decision 137), and a Tell Claude text, its sender's
 * alone (`inbox_entry.created_by`, Worker decision 157; F5).
 */
export const EXTRA_FIELDS = ["write_log.reason", "inbox_entry.text"] as const;

/** One invented syllable per field. */
export const SYLLABLE: Readonly<Record<string, string>> = {
  "reading.note": "dask", "blood_draw.note": "mirro", "lab_result.note": "tull", "flag.note": "fenn",
  "member_note.topic": "quist", "member_note_version.body": "borra", "measurement_cadence.message": "lume", "feedback.text": "sarn",
  "hr_zone.basis": "pellow", "method_change.note": "vond", "target.reasoning": "trisk", "goal_point.note": "olva",
  "phase.intent": "grane", "prescription.cue": "dimmet", "prescription.fallback_note": "harl", "legacy_audit_entry.reason": "yorrow",
  "session.note": "cassen", "session_set.note": "pindle", "cardio_block.note": "wrex", "load_change.reason": "nuvo",
  "schedule_swap.reason": "zellby", "write_log.reason": "marrin", "inbox_entry.text": "tovin",
  "question.text": "quillow",
};

/** One invented stem per member. */
const STEM: Record<CanaryMember, string> = { Asha: "Vel", Kabir: "Brin", Noor: "Quor" };

/** An ordinary sentence per field, around the word. */
export const SENTENCE: Readonly<Record<string, (w: string) => string>> = {
  "reading.note": (w) => `Measured after the walk past the ${w} bakery.`,
  "blood_draw.note": (w) => `Drawn at the ${w} clinic before breakfast.`,
  "lab_result.note": (w) => `The lab wrote ${w} beside this marker.`,
  "flag.note": (w) => `Ask about the ${w} scale before trusting it.`,
  "member_note.topic": (w) => `Notes from the ${w} appointment`,
  "member_note_version.body": (w) => `Keep the ${w} routine through the festival weeks.`,
  "measurement_cadence.message": (w) => `Measure the waist at the ${w} mark each fortnight.`,
  "feedback.text": (w) => `The ${w} button on the week view did nothing.`,
  "hr_zone.basis": (w) => `Estimated on the ${w} treadmill test.`,
  "method_change.note": (w) => `Switched to the ${w} tape from here on.`,
  "target.reasoning": (w) => `Held through the ${w} wedding season.`,
  "goal_point.note": (w) => `Set after the ${w} review.`,
  "phase.intent": (w) => `Slow and steady, the ${w} way.`,
  "prescription.cue": (w) => `Brace like the ${w} drill.`,
  "prescription.fallback_note": (w) => `Use the ${w} bench if this one is taken.`,
  "legacy_audit_entry.reason": (w) => `Copied from the ${w} notebook.`,
  "session.note": (w) => `Trained after the ${w} commute.`,
  "session_set.note": (w) => `Felt the ${w} twinge on the last rep.`,
  "cardio_block.note": (w) => `Walked the ${w} loop twice.`,
  "load_change.reason": (w) => `Dropped after the ${w} week.`,
  "schedule_swap.reason": (w) => `Swapped for the ${w} class.`,
  "write_log.reason": (w) => `Logged from the ${w} kiosk.`,
  "inbox_entry.text": (w) => `Had something at the ${w} stall, not sure how much.`,
  "question.text": (w) => `Was the ${w} pot yours, or the other one?`,
};

const CODED = "a code, date, unit or name from a fixed set, not free text";
const JSON_TEXT = "structured JSON the tools write, not free text";
const WITHHELD = "free text, but its whole row is owner-only (OWNER_ONLY): the row's canaried field already proves the row is withheld";
const coded = (table: string, ...columns: string[]) => Object.fromEntries(columns.map((c) => [`${table}.${c}`, CODED]));

/**
 * The text columns of OWNER_ONLY tables that carry no canary of their own,
 * each with its reason. The guard test reads every text column of every
 * OWNER_ONLY table from the Worker's migrations, so a new one fails until it
 * gets a canary (TEXT_FIELDS) or a line here.
 */
export const UNCANARIED: Readonly<Record<string, string>> = {
  ...coded("question", "status", "asked_at", "answered_at", "closed_at"),
  "question.choices": JSON_TEXT,
  "question.blocks": JSON_TEXT,
  "question.answer": WITHHELD,
  ...coded("reading", "metric", "measured_on", "measured_at_time", "unit", "side", "body_state", "measurer", "method", "state", "confirmed_at"),
  "reading.conditions": WITHHELD,
  "reading.suspect_reason": WITHHELD,
  ...coded("method_change", "metric", "changed_on"),
  ...coded("blood_draw", "drawn_on", "state", "confirmed_at"),
  "blood_draw.lab": WITHHELD,
  ...coded("lab_result", "comparator", "unit"),
  "lab_result.marker": WITHHELD,
  "lab_result.value_text": WITHHELD,
  "lab_result.ref_text": WITHHELD,
  ...coded("flag", "subtype", "raised_on", "due_on", "status", "resolved_on"),
  "flag.subject": WITHHELD,
  "flag.resolution": WITHHELD,
  ...coded("member_note", "subject_table", "created_at"),
  ...coded("measurement_cadence", "source", "metric", "body_state", "last_done_on"),
  "measurement_cadence.name": WITHHELD,
  ...coded("feedback", "type", "status", "created_at"),
  "feedback.context": JSON_TEXT,
  "feedback.triage_note": WITHHELD,
  ...coded("member_note_version", "created_at"),
  ...coded("hr_zone", "status", "set_on"),
  ...coded("target", "effective_from", "provenance", "created_at"),
  ...coded("goal_point", "metric", "week_of", "tier", "basis", "unit"),
  ...coded("phase", "starts_on", "ends_on", "energy_stance", "archived_at"),
  "phase.name": WITHHELD,
  "phase.archived_reason": WITHHELD,
  ...coded("prescription", "target_kind", "distance_unit", "load_unit", "load_basis", "bar_unit"),
  "prescription.progression_rule": JSON_TEXT,
  "prescription.plates": JSON_TEXT,
  ...coded("legacy_audit_entry", "source_file", "logged_on", "logged_time", "action"),
  "legacy_audit_entry.agent": WITHHELD,
  "legacy_audit_entry.target": WITHHELD,
  "legacy_audit_entry.prior_value": WITHHELD,
  "legacy_audit_entry.result": WITHHELD,
};

/**
 * Kabir is the stress household's empty member (no target, sessions, readings or blood draws; wide-layout spec §7, J13),
 * so his canaries stop there. His Inbox text is about Asha: it stays his, and Asha, who it is about, never sees it.
 */
export const KABIR_FIELDS = ["flag.note", "member_note.topic", "member_note_version.body", "feedback.text", "write_log.reason", "inbox_entry.text", "question.text"] as const;

/** Noor has no programme of her own (J9, J10): no prescription, load change or swap. */
export const NOOR_SKIPS: ReadonlySet<string> = new Set(["prescription.cue", "prescription.fallback_note", "load_change.reason", "schedule_swap.reason"]);

/**
 * Training's free text that is household data (Worker decision 167, superseding 137): another
 * member may see it, so the privacy tests never treat it as a needle to hide. It stays a canary
 * (the positive control proves its owner reaches it). Prescription coach notes, a swap's reason
 * and phases stay their member's alone, so they are not here.
 */
export const HOUSEHOLD_TEXT: ReadonlySet<string> = new Set(["session.note", "session_set.note", "cardio_block.note", "load_change.reason"]);

function carries(member: CanaryMember, field: string): boolean {
  if (member === "Kabir") return (KABIR_FIELDS as readonly string[]).includes(field);
  if (member === "Noor") return !NOOR_SKIPS.has(field);
  return true;
}

const TEXTS: TextCanary[] = (["Asha", "Kabir", "Noor"] as const).flatMap((member) =>
  TEXT_FIELDS.flatMap(([table, field]) => {
    const at = `${table}.${field}`;
    if (!carries(member, at)) return [];
    const syllable = SYLLABLE[at];
    const sentence = SENTENCE[at];
    if (syllable === undefined) throw new Error(`canaries.ts: TEXT_FIELDS lists ${at}, but SYLLABLE has no syllable for it`);
    if (sentence === undefined) throw new Error(`canaries.ts: TEXT_FIELDS lists ${at}, but SENTENCE has no sentence for it`);
    const word = `${STEM[member]}${syllable}`;
    return [{ kind: "text" as const, member, table, field, word, text: sentence(word) }];
  }),
);

/** Values that occur nowhere else in the household: the seed checks each is in the database exactly once. */
export const NUMBERS: readonly NumberCanary[] = [
  { kind: "number", member: "Asha", table: "reading", field: "value", what: "fasted weight", value: 66.6, shown: "66.6" },
  { kind: "number", member: "Asha", table: "reading", field: "value", what: "waist", value: 93.3, shown: "93.3" },
  { kind: "number", member: "Asha", table: "lab_result", field: "value", what: "marker", value: 417.3, shown: "417.3" },
  { kind: "number", member: "Noor", table: "reading", field: "value", what: "fasted weight", value: 58.8, shown: "58.8" },
  { kind: "number", member: "Noor", table: "reading", field: "value", what: "waist", value: 77.7, shown: "77.7" },
  { kind: "number", member: "Noor", table: "lab_result", field: "value", what: "marker", value: 288.8, shown: "288.8" },
];

export const CANARIES: readonly Canary[] = [...TEXTS, ...NUMBERS];

export function canariesOf(member: CanaryMember): Canary[] {
  return CANARIES.filter((c) => c.member === member);
}

/** What to look for: the word, or the number as shown. */
export function needle(c: Canary): string {
  return c.kind === "text" ? c.word : c.shown;
}

/** The owner-only numbers that a database dump holds other than exactly once, as "<member> <what> <shown>: <n> times". */
export function numbersNotOnce(dump: string, numbers: readonly NumberCanary[] = NUMBERS): string[] {
  return numbers.flatMap((n) => {
    const count = dump.match(new RegExp(`(?<![\\d.])${n.shown.replace(".", "\\.")}(?![\\d])`, "g"))?.length ?? 0;
    return count === 1 ? [] : [`${n.member} ${n.what} ${n.shown}: ${count} times`];
  });
}

/** The emails the seed gives its members. */
export const CANARY_EMAIL: Record<CanaryMember, string> = { Asha: "asha@example.com", Kabir: "kabir@example.com", Noor: "noor@example.com" };

/** The column naming a row's owner, for the tables whose owner isn't `member_id` or a parent (OWNER_VIA). */
const OWNER_COLUMN: Readonly<Record<string, string>> = {
  // A write's reason is its writer's (Worker decision 137).
  write_log: "actor_member_id",
  // A Tell Claude text is its sender's (Worker decision 157).
  inbox_entry: "created_by",
};

/** The read-only part of node:sqlite's DatabaseSync the check needs. */
export interface SqlReader {
  prepare(sql: string): { all(...params: (string | number)[]): unknown[] };
}

/**
 * The text canaries a database doesn't hold where they belong: each must be in
 * its own table and field, on a row its member owns (the row's member_id, its
 * parent's through the Worker's OWNER_VIA, the writer of a write, or the sender
 * of an Inbox text). As "<member> <table>.<field> <word>".
 */
export function canariesMissing(db: SqlReader, canaries: readonly Canary[] = CANARIES): string[] {
  const memberId = (m: CanaryMember) => (db.prepare("SELECT id FROM member WHERE email = ?").all(CANARY_EMAIL[m])[0] as { id: number } | undefined)?.id;
  return canaries.flatMap((c) => {
    if (c.kind !== "text") return [];
    const via = Object.hasOwn(OWNER_VIA, c.table) ? OWNER_VIA[c.table as keyof typeof OWNER_VIA] : null;
    const column = via?.column ?? OWNER_COLUMN[c.table] ?? "member_id";
    const rows = db.prepare(`SELECT ${column} AS o FROM ${c.table} WHERE instr(${c.field}, ?) > 0`).all(c.word) as { o: number | null }[];
    let owners = rows.map((r) => r.o);
    if (via && owners.length > 0) {
      const parents = new Map((db.prepare(via.sql).all(JSON.stringify(owners)) as { k: number; v: number | null }[]).map((r) => [r.k, r.v]));
      owners = owners.map((p) => (p === null ? null : (parents.get(p) ?? null)));
    }
    const mine = memberId(c.member);
    return mine !== undefined && owners.includes(mine) ? [] : [`${c.member} ${c.table}.${c.field} ${c.word}`];
  });
}
