/**
 * Every Worker tool, aimed at another member's owner-only data (e2e spec §5):
 * `member` names the owner; `record` names the owner's owner-only records by
 * id; `household` takes no member (its answer must still hold none of the
 * owner's canaries); `query` is refused to every member. A row's input must
 * reach its tool: a 400 fails the test unless the row says `invalidOk` (a
 * catalogue or household tool whose full input isn't built here; it holds no
 * member's data). The table is exactly the tools the Worker lists (GET /tools):
 * a tool missing from it fails the test, so a new tool can't skip the check;
 * the importer's tools (src/importing.ts) aren't served, so aren't here.
 * Writes are included: owner-only covers both (Worker decision 40).
 */
import type { Owner } from "./support/canaries.ts";
import { AMENDABLE, OWNER_ONLY, RETRACTABLE, STATE_TABLES } from "@myfitnessguide/worker/owner-only";
import { TEXT_FIELDS } from "../scripts/canaries.ts";
import { ownedRecords, SENT_BY, sentRecords } from "./support/canaries.ts";

export interface Row {
  aim: "member" | "record" | "household" | "query";
  inputs: (o: Owner) => Record<string, unknown>[];
  invalidOk?: true;
  /**
   * The owner-only record (OWNER_ONLY, or an Inbox entry the owner sent) an input aims at, when it does:
   * that call must be refused (a 403, or a 404 not_found that says nothing of it) and write nothing.
   */
  refuses?: (input: Record<string, unknown>) => Aimed | undefined;
}

const member = (f: (o: Owner) => Record<string, unknown>, invalidOk = false): Row => ({ aim: "member", inputs: (o) => [f(o)], ...(invalidOk ? { invalidOk: true as const } : {}) });
const record = (f: (o: Owner) => Record<string, unknown>[], refuses?: Row["refuses"]): Row => ({ aim: "record", inputs: f, ...(refuses ? { refuses } : {}) });
/** A record by table and id. */
export interface Aimed {
  table: string;
  id: number;
}
/** The record in the input's `field`, of `table`. */
const by = (table: string, field: string) => (input: Record<string, unknown>): Aimed => ({ table, id: input[field] as number });
/** The record an input names (`record`, the first of `records`, or `table` and `id`), when it is owner-only. */
const ownerOnly = (input: Record<string, unknown>): Aimed | undefined => {
  const r = (input.record ?? (input.records as unknown[] | undefined)?.[0] ?? input) as Aimed;
  return Object.hasOwn(OWNER_ONLY, r.table) || Object.hasOwn(SENT_BY, r.table) ? { table: r.table, id: r.id } : undefined;
};
const household = (input: Record<string, unknown>, invalidOk = false): Row => ({ aim: "household", inputs: () => [input], ...(invalidOk ? { invalidOk: true as const } : {}) });
const ids = (o: Owner, table: string) => o.ids[table] ?? [];
const recs = (o: Owner) => ownedRecords(o);
const ROW_LOAD = { value: 35, unit: "kg", basis: "total", implement: 2 };
const RAGI = { source: "food", food: "Ragi", value: 10, unit: "g", provenance: "weighed", confidence: "high" };
const ROW_SET = { exercise: "row", reps: 5, rir: 2, load: ROW_LOAD };

/**
 * The owner's records each records tool takes, from the Worker's own lists
 * (owner-only.ts, read by tools/records.ts): amend's AMENDABLE, the
 * STATE_TABLES confirm and reject decide, retract's RETRACTABLE. Any other
 * table is refused by kind before the record is read, so aiming there would
 * never reach the visibility check. A table the Worker adds to a list is
 * probed with no change here.
 */
const STATEFUL: ReadonlySet<string> = new Set(STATE_TABLES);
const RETRACTS: ReadonlySet<string> = new Set(RETRACTABLE);
const recsIn = (o: Owner, tables: ReadonlySet<string>) => recs(o).filter((r) => tables.has(r.table));
/** The field amend changes on a table: its note, else its owner-only free text (the canary's field), else its first. */
export function amendField(table: string): string {
  const fields = AMENDABLE[table]!;
  const text = TEXT_FIELDS.find(([t, f]) => t === table && fields.includes(f))?.[1];
  return fields.includes("note") ? "note" : (text ?? fields[0]!);
}

export const PRIVACY_TABLE: Record<string, Row> = {
  // analytics.ts: fixed household-visible aggregates, with no owner-only prose
  analytics: member((o) => ({ dataset: "nutrition", member: o.name, metric: "kcal", group_by: "day" })),
  // aliases.ts
  learn_alias: household({ alias: "privacy-probe", kind: "food_source", target: "Ragi" }, true),
  forget_alias: household({ id: 1 }, true),
  learned: member((o) => ({ member: o.name })),
  // catalogue.ts: the household's catalogue, nobody's own data
  upsert_food_source: household({}, true),
  add_measure: household({}, true),
  upsert_recipe: household({}, true),
  update_recipe: household({}, true),
  set_recipe_archived: household({}, true),
  add_recipe_line: household({}, true),
  remove_recipe_line: household({}, true),
  add_yield: household({}, true),
  catalogue_search: household({ query: "a" }),
  catalogue_list: household({ kind: "food_source" }, true),
  catalogue_lookup: household({ refs: ["Ragi"] }, true),
  catalogue_dependents: household({ ref: "Ragi" }, true),
  // feedback.ts
  submit_feedback: household({ type: "idea", text: "A privacy probe." }),
  feedback_list: household({}),
  triage_feedback: record((o) => ids(o, "feedback").map((id) => ({ id, status: "discussed", note: "probe" })), by("feedback", "id")),
  // health.ts
  log_reading: member((o) => ({ member: o.name, date: o.today, metric: "weight", value: 70, unit: "kg", body_state: "fasted" })),
  body_trends: member((o) => ({ member: o.name })),
  reading_metrics: member((o) => ({ member: o.name })),
  log_blood_draw: member((o) => ({ member: o.name, date: o.today, lab: "Probe Labs", results: [{ marker: "Ferritin", value: 50, unit: "ng/mL" }] })),
  blood_draws: member((o) => ({ member: o.name })),
  heart_rate_zones: member((o) => ({ member: o.name })),
  health_drafts: member((o) => ({ member: o.name })),
  flags: member((o) => ({ member: o.name, status: "all" })),
  raise_flag: member((o) => ({ member: o.name, subtype: "data", subject: "probe" })),
  resolve_flag: record((o) => ids(o, "flag").map((id) => ({ flag_id: id, resolution: "probe" })), by("flag", "flag_id")),
  set_goal_point: member((o) => ({ member: o.name, metric: "waist_navel", week_of: o.today, value: 80, unit: "cm", tier: "planned" })),
  // input.ts
  recent_items: member((o) => ({ member: o.name })),
  route_text: member((o) => ({ member: o.name, date: o.today, text: "2 eggs" })),
  commit_route: member((o) => ({ member: o.name, date: o.today, meal_slot: "snack", pieces: [{ entry: { kind: "item", item: RAGI }, edited: false }] })),
  submit_to_inbox: member((o) => ({ member: o.name, date: o.today, text: "chai", spans: [{ text: "chai", start: 0, end: 4 }] })),
  inbox_entries: member((o) => ({ member: o.name, status: "all" })),
  // The owner's own sent texts (Worker decision 157; F5): Kabir's is about Asha, so as Asha this is the subject trying to close it.
  resolve_inbox_entry: record((o) => sentRecords(o).map((r) => ({ id: r.id, status: "rejected", note: "probe" })), by("inbox_entry", "id")),
  // questions.ts: the agent asks; only the member asked answers.
  ask_member: member((o) => ({ member: o.name, text: "Which pot was it?", choices: ["The first", "The second"] })),
  answer_question: record((o) => ids(o, "question").map((id) => ({ id, choice: "The first" }))),
  // notes.ts
  member_notes: member((o) => ({ member: o.name, include_versions: true })),
  write_member_note: member((o) => ({ member: o.name, topic: "probe", body: "probe" })),
  // nutrition.ts: food is household data; the answers must still hold no canary
  log_intake: member((o) => ({ member: o.name, date: o.today, meal_slot: "snack", items: [RAGI] })),
  // A correction is the same household write; with no item of the owner's, a 400 is expected.
  correct_intake: member((o) => ({ item_id: ids(o, "intake_item")[0] ?? 0, reason: "probe", replacement: RAGI }), true),
  day_items: member((o) => ({ member: o.name, date: o.today })),
  day_totals: member((o) => ({ member: o.name, date: o.today })),
  set_day_status: member((o) => ({ member: o.name, date: o.today, status: "complete" })),
  what_if: member((o) => ({ member: o.name, date: o.today, items: [RAGI] })),
  household_meal: household({}, true),
  preview_meal: household({}, true),
  household_planning_context: household({ from: "2026-10-05", to: "2026-10-05" }),
  preview_meal_plan: household({}, true),
  save_meal_plan: household({}, true),
  meal_plan: household({}, true),
  set_meal_plan_archived: household({}, true),
  mark_remainder: household({}, true),
  add_cook_line: household({}, true),
  remove_cook_line: household({}, true),
  // programme.ts
  // Twice: from today (the default), and from the far past, where the seeded swap and its owner-only reason are listed
  // (programme lists swaps from its date on).
  programme: { aim: "member", inputs: (o) => [{ member: o.name }, { member: o.name, date: "2000-01-01" }] },
  active_session: member((o) => ({ member: o.name, date: o.today })),
  create_programme: member((o) => ({
    member: o.name,
    name: "Privacy probe",
    schedule_kind: "rotation",
    started_on: o.today,
    change_reason: "Privacy probe",
    templates: [{ name: "Probe", session_type: "strength", prescriptions: [] }],
    slots: [{ rotation_position: 1, template: "Probe" }],
  })),
  update_programme: member((o) => ({ member: o.name, effective_on: o.today, change_reason: "Privacy probe", name: "Privacy probe revision" })),
  set_programme_archived: member((o) => ({ member: o.name, archived: true, effective_on: o.today, change_reason: "Privacy probe" })),
  upsert_phase: member((o) => ({ member: o.name, name: "Privacy probe", starts_on: o.today, ends_on: null, energy_stance: "maintenance", intent: "Privacy probe", change_reason: "Privacy probe" })),
  set_phase_archived: member((o) => ({ member: o.name, phase: "Privacy probe", archived: true, change_reason: "Privacy probe" })),
  // Each change kind, the load change on each of the owner's prescriptions (owner-only).
  programme_change: {
    aim: "member",
    inputs: (o) => [
      { member: o.name, change: { kind: "swap", date: o.today, template: null, reason: "probe" } },
      ...ids(o, "prescription").map((id) => ({ member: o.name, change: { kind: "load_change", prescription_id: id, date: o.today, load: { value: 35, unit: "kg", basis: "total" }, reason: "probe" } })),
    ],
  },
  // progress.ts: the owner-only unified summary (tools/progress.ts); another member's is refused.
  progress_summary: member((o) => ({ member: o.name })),
  // query.ts: refused to every member (tools/query.ts; decision 136)
  query: { aim: "query", inputs: () => [{ sql: "SELECT note FROM reading" }] },
  // records.ts: by the owner's own records
  amend: record((o) => recs(o).filter((r) => Object.hasOwn(AMENDABLE, r.table)).map((r) => ({ record: r, changes: { [amendField(r.table)]: "probe" }, reason: "probe" })), ownerOnly),
  confirm: record((o) => recsIn(o, STATEFUL).map((r) => ({ records: [r] })), ownerOnly),
  reject: record((o) => recsIn(o, STATEFUL).map((r) => ({ records: [r], reason: "probe" })), ownerOnly),
  retract: record((o) => recsIn(o, RETRACTS).map((r) => ({ records: [r], reason: "probe" })), ownerOnly),
  history: record((o) => [...recs(o), ...sentRecords(o)].map((r) => ({ table: r.table, id: r.id })), ownerOnly),
  // screens.ts
  whoami: household({}),
  day_meals: member((o) => ({ member: o.name, date: o.today })),
  day_cooks: member((o) => ({ member: o.name, date: o.today })),
  needs_you: member((o) => ({ member: o.name })),
  waiting: member((o) => ({ member: o.name })),
  week_summary: member((o) => ({ member: o.name })),
  nutrition_trends: member((o) => ({ member: o.name })),
  household_overview: household({}),
  sessions: member((o) => ({ member: o.name })),
  lift_trends: member((o) => ({ member: o.name })),
  // staleness.ts
  staleness: member((o) => ({ member: o.name })),
  set_measurement_cadence: member((o) => ({ member: o.name, name: "probe", every_days: 7, source: { kind: "manual" }, message: "probe" })),
  // targets.ts
  targets: member((o) => ({ member: o.name })),
  set_target: member((o) => ({ member: o.name, effective_from: o.today, provenance: "member", reasoning: "probe", values: [{ nutrient: "kcal", kind: "target", value: 2000 }] })),
  // training.ts: sessions are household data, their notes the owner's (decision 137)
  start_session: member((o) => ({ member: o.name, date: o.today, session_type: "cardio" })),
  log_set: record((o) => ids(o, "session").map((id) => ({ session_id: id, ...ROW_SET }))),
  log_workout: member((o) => ({ member: o.name, date: o.today, source: { kind: "none" }, sets: [ROW_SET] })),
  preview_set: record((o) => ids(o, "session").map((id) => ({ session_id: id, ...ROW_SET }))),
  end_session: record((o) => ids(o, "session").map((id) => ({ session_id: id }))),
  // A stored set belongs to its session: another member's correction, re-check or history is refused.
  update_set: record(
    (o) => ids(o, "session_set").map((id) => ({ set_id: id, version: 1, reason: "probe", changes: { reps: 5 } })),
    by("session_set", "set_id"),
  ),
  revalidate_set: record((o) => ids(o, "session_set").map((id) => ({ set_id: id })), by("session_set", "set_id")),
  get_set_history: record((o) => ids(o, "session_set").map((id) => ({ set_id: id })), by("session_set", "set_id")),
  revalidate_session: record((o) => ids(o, "session").map((id) => ({ session_id: id })), by("session", "session_id")),
  validate_session: record((o) => ids(o, "session").map((id) => ({ session_id: id })), by("session", "session_id")),
  next_prescription: member((o) => ({ member: o.name })),
  // A prescription's numbers are household data, its cue and fallback note the owner's (Worker decision 135): no canary, not refused.
  check_progression: record((o) => ids(o, "prescription").map((id) => ({ prescription_id: id }))),
  substitute: record((o) => ids(o, "prescription").map((id) => ({ prescription_id: id }))),
  lift_history: member((o) => ({ member: o.name, pattern: "row" })),
  last_trained: member((o) => ({ member: o.name })),
  log_cardio: member((o) => ({ member: o.name, date: o.today, session_type: "cardio", blocks: [{ kind: "steady", duration_s: 600 }] })),
  create_gym: household({ name: "Privacy probe gym" }, true),
  create_implement: household({ gym: 2, name: "Privacy probe rack", kind: "machine", unit: "kg", loading: "total", ranges: [{ from: 20, to: 40, step: 5, unit: "kg" }] }, true),
  update_implement: household({ implement_id: 2, note: "probe" }, true),
  set_implement_archived: household({ implement_id: 2, archived: true, change_reason: "probe" }, true),
  inventory: member((o) => ({ member: o.name })),
  add_implement_load: household({ implement_id: 2, loads: [{ load: 45, unit: "kg" }] }, true),
  remove_implement_load: household({ implement_id: 2, loads: [{ load: 45, unit: "kg" }] }, true),
  inventory_gaps: member((o) => ({ member: o.name })),
  record_plates: member((o) => ({ member: o.name, unit: "kg", available: [20] })),
  // workouts.ts
  workouts: member((o) => ({ member: o.name })),
  create_workout: household({}, true),
  update_workout: household({}, true),
  set_workout_archived: household({}, true),
  add_workout_line: household({}, true),
  remove_workout_line: household({ line_id: 1 }, true),
  save_session_as_workout: record((o) => ids(o, "session").map((id) => ({ session_id: id, name: "probe" }))),
};
