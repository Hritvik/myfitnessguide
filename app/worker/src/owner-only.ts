/**
 * Which records are owner-only, and which tables the records tools take,
 * with no imports, so the browser suite can read the same lists
 * (`@myfitnessguide/worker/owner-only`, e2e spec §3, §5). records.ts and
 * context.ts re-export them; src/records.ts reads a child table's owner
 * through OWNER_VIA, the one definition of whose record it is.
 */

/**
 * Owner-only record kinds: visible only to their member, and to the agent.
 * Health data and every free text that can cite it (decision 135): a
 * target's reasoning, goal points, a phase's intent, a prescription's
 * coach notes, the old Sheets audit.
 */
export type OwnerOnly = "reading" | "blood_draw" | "flag" | "member_note" | "feedback" | "target" | "goal_point" | "phase" | "prescription" | "session" | "legacy_audit" | "question";

/** Tables whose records are owner-only, and the visibility kind each falls under. */
export const OWNER_ONLY: Record<string, OwnerOnly> = {
  reading: "reading",
  method_change: "reading",
  blood_draw: "blood_draw",
  lab_result: "blood_draw",
  flag: "flag",
  member_note: "member_note",
  measurement_cadence: "reading",
  feedback: "feedback",
  // Health-derived (decision 135): each one's free text cites readings, bloods or BIA.
  member_note_version: "member_note",
  hr_zone: "reading",
  target: "target",
  goal_point: "goal_point",
  phase: "phase",
  prescription: "prescription",
  legacy_audit_entry: "legacy_audit",
  // Claude's question and the answer belong to their recipient and the agent.
  question: "question",
};

/**
 * Free text on records another member may otherwise see (decision 167,
 * superseding 137): a schedule swap's reason is still its member's alone.
 * Training's session, set, cardio and load-change text is now household
 * data with the numbers around it.
 */
export const OWNER_TEXT: Record<string, readonly string[]> = {
  schedule_swap: ["reason"],
};

export const IN_LIST = "IN (SELECT value FROM json_each(?))";

/** Tables whose owner is their parent's member, and the one statement that reads many parents. */
export const OWNER_VIA = {
  session_set: { column: "session_id", sql: `SELECT id AS k, member_id AS v FROM session WHERE id ${IN_LIST}` },
  cardio_block: { column: "session_id", sql: `SELECT id AS k, member_id AS v FROM session WHERE id ${IN_LIST}` },
  lab_result: { column: "draw_id", sql: `SELECT id AS k, member_id AS v FROM blood_draw WHERE id ${IN_LIST}` },
  target_value: { column: "target_id", sql: `SELECT id AS k, member_id AS v FROM target WHERE id ${IN_LIST}` },
  member_note_version: { column: "note_id", sql: `SELECT id AS k, member_id AS v FROM member_note WHERE id ${IN_LIST}` },
  load_change: {
    column: "prescription_id",
    sql: `SELECT p.id AS k, pr.member_id AS v FROM prescription p JOIN session_template t ON t.id = p.template_id JOIN programme pr ON pr.id = t.programme_id WHERE p.id ${IN_LIST}`,
  },
  schedule_swap: { column: "programme_id", sql: `SELECT id AS k, member_id AS v FROM programme WHERE id ${IN_LIST}` },
  prescription: { column: "template_id", sql: `SELECT t.id AS k, p.member_id AS v FROM session_template t JOIN programme p ON p.id = t.programme_id WHERE t.id ${IN_LIST}` },
} as const satisfies Record<string, { column: string; sql: string }>;
export type ViaTable = keyof typeof OWNER_VIA;

// The tables the records tools take (tools/records.ts), here so the browser suite aims its
// privacy probes at exactly these (e2e spec §5): a table they add is probed with no other change.

/** Tables whose records carry draft / confirmed state (schema decision 3). A share (portion, leftover serving) comes before its intake item. */
export const STATE_TABLES = ["session", "session_set", "cook", "household_meal", "portion", "leftover_serving", "intake_item", "reading", "blood_draw"] as const;

/**
 * What amend may change, per table. Keys, owners, links and state are
 * never amendable: those are a different record, or confirm / reject.
 */
export const AMENDABLE: Record<string, readonly string[]> = {
  intake_item: ["eaten_on", "meal_slot", "amount_value", "recipe_servings", "manual_kcal", "manual_protein_g", "manual_carbs_g", "manual_fat_g", "manual_reason", "provenance", "confidence", "dominant_uncertainty", "dominant_uncertainty_kcal", "label", "note"],
  intake_items: ["eaten_on", "meal_slot", "amount_value", "recipe_servings", "manual_kcal", "manual_protein_g", "manual_carbs_g", "manual_fat_g", "manual_reason", "provenance", "confidence", "dominant_uncertainty", "dominant_uncertainty_kcal", "label", "note"],
  portion: ["fraction", "weighed_g", "provenance", "dominant_uncertainty", "dominant_uncertainty_kcal"],
  // A different amount is a retract and a new serving.
  leftover_serving: ["provenance"],
  cook: ["name", "cooked_on", "note"],
  component: ["name", "cooked_weight_g", "cooked_weight_provenance"],
  cook_line: ["amount_value", "provenance", "note"],
  household_meal: ["eaten_on", "meal_slot", "note"],
  session: ["performed_on", "gym_id", "started_at", "ended_at", "energy_kcal", "note"],
  session_set: ["set_type", "reps", "reps_inferred", "load_value", "load_unit", "load_basis", "unilateral", "load_implement_id", "bar_value", "bar_unit", "plates", "rir_status", "rir_low", "rir_high", "duration_s", "distance_value", "distance_unit", "steps", "note"],
  sets: ["set_type", "reps", "reps_inferred", "load_value", "load_unit", "load_basis", "unilateral", "load_implement_id", "bar_value", "bar_unit", "plates", "rir_status", "rir_low", "rir_high", "duration_s", "distance_value", "distance_unit", "steps", "note"],
  set: ["set_type", "reps", "reps_inferred", "load_value", "load_unit", "load_basis", "unilateral", "load_implement_id", "bar_value", "bar_unit", "plates", "rir_status", "rir_low", "rir_high", "duration_s", "distance_value", "distance_unit", "steps", "note"],
  cardio_block: ["kind", "activity", "duration_s", "speed_value", "speed_unit", "incline_pct", "distance_value", "distance_unit", "steps", "avg_hr", "max_hr", "hr_device", "rpe", "conversational", "rounds", "recovery_hr", "note"],
  // measurer is amendable with its member: who held the tape decides whether two
  // readings are comparable, and it is routinely learned after the reading is written.
  reading: ["measured_on", "measured_at_time", "value", "unit", "side", "body_state", "resolution", "measurer", "measurer_member_id", "method", "conditions", "suspect", "suspect_reason", "note"],
  blood_draw: ["drawn_on", "lab", "fasting", "note"],
  lab_result: ["value", "comparator", "value_text", "unit", "ref_low", "ref_high", "ref_text", "note"],
  flag: ["subtype", "subject", "due_on", "note"],
  target: ["provenance", "reasoning"],
  phase: ["name", "starts_on", "ends_on", "energy_stance", "intent"],
  prescription: ["sets", "rep_low", "rep_high", "rir_target_low", "rir_target_high", "duration_low_s", "duration_high_s", "distance_value", "distance_unit", "rest_s", "progression_rule", "cue", "fallback_note"],
  food_source: ["name", "kcal", "protein_g", "carbs_g", "fat_g", "sodium_mg", "fibre_g", "iron_mg", "b12_ug", "calcium_mg", "magnesium_mg", "potassium_mg", "sat_fat_g", "total_sugars_g", "vitamin_c_mg", "protein_band", "protein_quality", "price_min_inr", "price_max_inr", "primary_category", "tags", "last_checked_on", "assumptions", "energy_override_reason"],
  recipe: ["name", "servings", "meal_type", "prep_type", "method", "source_assumptions", "manual_kcal", "manual_protein_g", "manual_carbs_g", "manual_fat_g", "manual_macros_reason"],
  measure: ["amount"],
  yield: ["factor", "discarded_fraction", "note"],
  recipe_line: ["amount_value", "link_status", "note"],
  exercise: ["bodyweight_dominant", "note"],
  implement: ["bar_value", "bar_unit", "load_list_complete", "note"],
  goal_point: ["value_low", "value_high", "tier", "headline", "note"],
  workout: ["name", "note"],
  workout_line: ["set_type", "sets", "target_kind", "rep_low", "rep_high", "duration_s", "distance_value", "distance_unit", "load_kind", "load_value", "load_unit", "load_basis", "bar_value", "bar_unit", "plates", "rir_low", "rir_high", "rest_s", "note"],
};

/**
 * What retract may remove: a member's own entries, not shared or structural
 * records. A session only once it holds no sets (a cardio or class session,
 * or one emptied in this same call), with any blocks left in it (decision 146).
 */
export const RETRACTABLE = ["intake_item", "portion", "leftover_serving", "session_set", "cardio_block", "reading", "session"] as const;
