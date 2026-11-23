/**
 * The shapes the Today screen reads, as the Worker's tools return them.
 * Only the fields the screen uses are declared.
 */
import type { Range } from "./route";

export interface WhoAmI {
  member: string | null;
  members: string[];
  today: string;
  /** HH:MM in the household's time zone. */
  time: string;
  time_zone: string;
}

export interface LeftLine {
  goal: number;
  consumed: number;
  left: number;
  floor: number | null;
  floorLeft: number | null;
}

/** How many items a kcal and a protein sum leave out because nobody knows their value (ticket 72). */
export type UnknownItems = Record<"kcal" | "protein", number> & {
  /** Items with any macro not wholly known, each once: the "N items unknown" (review P2-4). Absent from an earlier Worker. */
  any?: number;
};

export interface NutrientTotal {
  value: number;
  known: number;
  of: number;
}

export interface DayTotals {
  member: string;
  date: string;
  day_status: string;
  item_count: number;
  draft_items: number;
  so_far: Partial<Record<"kcal" | "protein" | "carbs" | "fat", NutrientTotal>>;
  /** How many items each sum (so far, and so left) leaves out because nobody knows their value (ticket 72). Absent from an older Worker. */
  unknown_items?: Record<"kcal" | "protein" | "carbs" | "fat", number> & { any?: number };
  left: Record<"kcal" | "protein" | "carbs" | "fat", LeftLine> | null;
  target_values: { nutrient: string; kind: string; value: number | null }[];
}

/** An agent's write names the member it was talking with (`speaker`), null only for an Inbox write without one or an older write. */
export type LoggedBy = { kind: "member"; name: string } | { kind: "agent"; origin: string; speaker: string | null } | { kind: "system" } | null;

export interface RecordRef {
  table: string;
  id: number;
}

export interface MealItem {
  table: "intake_item";
  id: number;
  source_kind: "food_source" | "portion" | "recipe" | "manual";
  name: string | null;
  label: string | null;
  amount: { value?: number; unit?: string; measure?: string; servings?: number; fraction?: number | null; weighed_g?: number } | null;
  /** A food item's food: its ref, its unit and its measures, for the row's Edit (click test P2-8); null otherwise. */
  food?: { ref: string; reference_unit: "g" | "ml" | "piece"; measures: { name: string; amount: number }[] } | null;
  portion_id: number | null;
  /** A leftover helping's serving: it is removed as the serving and can't be amended (ticket 61). */
  leftover_serving_id?: number | null;
  kcal: number | null;
  protein: number | null;
  /** Known for some of its parts only (a recipe with an unconvertible line): "450+ kcal" (ticket 72). Absent from an older Worker. */
  partial?: { kcal: boolean; protein: boolean };
  provenance: string | null;
  plus_minus_kcal: number | null;
  uncertainty: string | null;
  state: "draft" | "confirmed";
  logged_by: LoggedBy;
  /** A draft its member had confirmed and someone else then edited (ticket 69). Absent from an older Worker. */
  ever_confirmed?: boolean;
  /** That edit's writer, only on such a re-draft. */
  edited_by?: LoggedBy;
}

export type SlotState = "eaten" | "skipped" | "nothing_yet" | "not_recorded";

export interface MealSlot {
  slot: string;
  state: SlotState;
  /** The meal's sums of what is known; unknown_items counts the items they leave out (ticket 72; absent from an older Worker). */
  totals: { kcal: number | null; protein: number | null; unknown_items?: UnknownItems } | null;
  items: MealItem[];
}

export interface DayMeals {
  member: string;
  date: string;
  day_status: string;
  slots: MealSlot[];
  estimate: {
    plus_minus_kcal: number | null;
    estimated_items: number;
    estimated_without_size: number;
    dominant: { name: string | null; description: string | null; kcal: number | null } | null;
  };
  /** Sheets-era honesty: whether the import wrote the day, and its typed-macros share (high is the API's call). */
  honesty: { imported: boolean; typed_macros: { items: number; kcal: number; share: number | null; high: boolean } };
}

export interface CookShare {
  portion_id: number;
  member: string;
  you: boolean;
  fraction: number | null;
  weighed_g: number | null;
  provenance: string;
  state: "draft" | "confirmed";
}

export interface CookComponent {
  component_id: number;
  name: string;
  shares: CookShare[];
  remainder: { fraction: number; status: "unaccounted" | "leftover" | "discarded" | "eaten" } | null;
  /** Leftover helpings eaten from it (click test P1-7); absent from an older Worker. */
  leftovers?: { serving_id: number; member: string; you: boolean; fraction: number | null; eaten_on: string }[];
}

export interface CookAsk {
  portion_id: number;
  component_id: number;
  fraction: number | null;
  kcal: number | null;
  plus_minus_kcal: number | null;
  /** What the ± is mostly about ("ladle size"), stored on the portion. */
  uncertainty: string | null;
  provenance: string;
  logged_by: LoggedBy;
  /** A share its member had confirmed and someone else then edited (ticket 69). Absent from an older Worker. */
  ever_confirmed?: boolean;
  /** That edit's writer, only on such a re-draft. */
  edited_by?: LoggedBy;
  records: RecordRef[];
}

export interface DayCook {
  cook_id: number;
  name: string;
  cooked_on: string;
  meal_slot: string;
  logged_by: LoggedBy;
  components: CookComponent[];
  absent: string[];
  ask: CookAsk | null;
}

export interface DayCooks {
  member: string;
  date: string;
  cooks: DayCook[];
}

export type NeedsCard =
  | { rule: "drafts"; count: number; oldest: { table: string; id: number; deadline: string | null; waits: "end_of_session" | "rir_needed" | null }; message: string }
  | { rule: "remainder"; cook_id: number; cook: string; /** The pot's day (Worker decision 164); absent from an older Worker. */ cooked_on?: string; component_id: number; component: string | null; fraction: number; message: string }
  | { rule: "yesterday_open"; date: string; items: number; message: string }
  | { rule: "load"; session: string; date: string | null; prescriptions: { prescription_id: number; exercise: string; state: { kind: string } }[]; message: string }
  | { rule: "flag"; flag_id: number; subject: string; due_on: string; more: number; message: string }
  | { rule: "measurement"; cadence: string; last: string | null; message: string; /** A reading cadence's metric and body state; absent from a Worker before Task 25. */ metric?: string | null; body_state?: string | null };

export interface NeedsYou {
  member: string;
  date: string;
  cards: NeedsCard[];
  more: NeedsCard[];
}

export interface LoadAmount {
  value: number;
  unit: "kg" | "lb";
}

/** A prescribed load: a value, or a composition (the bar and the plates on each side, units mixed). */
export interface PrescribedLoad extends LoadAmount {
  basis: string | null;
  bar: LoadAmount | null;
  plates: (LoadAmount & { count: number })[] | null;
}

export interface NextLoad {
  value: number;
  unit: "kg" | "lb";
  plates: (LoadAmount & { count: number })[] | null;
}

export interface CheckOffer {
  if_exists: { tool: string; implement_id?: number; gym_id?: number; loads?: LoadAmount[] };
  if_not: { tool: string; implement_id?: number; gym_id?: number; loads?: LoadAmount[] };
}

/** next_prescription's state for a row (Worker training.ts, PrescriptionState). */
export type StateOut =
  | { kind: "ready"; next_load: NextLoad | null }
  | { kind: "needs_confirmation"; set_ids: number[]; next_load: NextLoad | null }
  | { kind: "check_at_gym"; question: string; next_load: NextLoad; offer: CheckOffer | null }
  | { kind: "holding"; reason: string }
  | { kind: "cant_move"; reason: string };

export interface Prescription {
  prescription_id: number;
  position: number;
  exercise: string;
  sets: number | null;
  target: { kind: "reps"; low: number | null; high: number | null } | { kind: "duration"; low_s: number | null; high_s: number | null } | { kind: "distance"; value: number | null; unit: string | null };
  rir_target: { low: number; high: number | null } | null;
  load: (PrescribedLoad & { implement: string | null; unverified: boolean }) | null;
  cue: string | null;
  fallback_note: string | null;
  fallbacks: string[];
  state: StateOut;
}

export interface InventoryGap {
  kind: "plate_denominations" | "plates" | "rack_end" | "stack_top" | "bar_weight" | "sled_weight";
  implement_id: number | null;
  implement: string | null;
  unit?: "kg" | "lb";
  unknown?: number[];
  question: string;
}

export interface InventoryGaps {
  gym: string | null;
  next_session: string | null;
  gaps: InventoryGap[];
  ask: InventoryGap | null;
}

export interface NextPrescription {
  programming_mode: "prescribed" | "record_only";
  session: string | null;
  date?: string | null;
  message?: string;
  layoff_policy?: "normal" | "hold" | "back_off" | null;
  gaps?: { prescription_id: number; exercise: string; template: string }[];
  prescriptions?: Prescription[];
}

/** Everything the Today screen reads for one member's day. */
export interface TodayData {
  me: string | null;
  members: string[];
  today: string;
  viewing: string;
  date: string;
  totals: DayTotals;
  meals: DayMeals;
  cooks: DayCooks;
  /** needs_you, read only on your own today. */
  needs: NeedsYou | null;
  /** The household's time zone, for clock times such as a draft's deadline. */
  timeZone: string;
  next: NextPrescription | null;
  /** Your Tell Claude texts about the viewed member for this day still waiting for Claude (pending inbox entries you sent); empty when the read failed. */
  waiting: InboxEntry[];
}

/**
 * The unified Progress read model (progress_summary, spec §Unified Progress
 * read model, 20 Oct 2026): five decision signals with comparison metadata,
 * association only, never causality. The website's Progress overview renders
 * in this order: body, strength, nutrition, review, next.
 */
export interface ProgressSummary {
  member: string;
  period: ProgressPeriod;
  as_of: string;
  from: string;
  to: string;
  signals: [
    { name: "body" } & ProgressSignals["body"],
    { name: "strength" } & ProgressSignals["strength"],
    { name: "nutrition" } & ProgressSignals["nutrition"],
    { name: "review" } & ProgressSignals["review"],
    { name: "next" } & ProgressSignals["next"],
  ];
}

export type ProgressPeriod = Range;

export interface ProgressSignals {
  body: {
    metric: string;
    latest: { date: string; value: number; unit: string } | null;
    change: number | null;
    rate_per_week: number | null;
    reading_count: number;
    body_states: string[];
    method_changes_reflected: boolean;
    note: string | null;
  };
  strength: {
    lifts: { exercise: string; best_e1rm_kg: number | null; change_kg: number | null; sessions: number }[];
    note: string | null;
  };
  nutrition: {
    from: string;
    to: string;
    logged_days: number;
    days_in_window: number;
    coverage: number | null;
    average_kcal: number | null;
    target_kcal: number | null;
    adherence_gap_kcal: number | null;
    note: string | null;
  };
  review: {
    open_flags: number;
    blood_draws_in_period: number;
    latest_reading_on: string | null;
    note: string | null;
  };
  next: { drill_down: string; reason: string };
}

export interface GoalVerdict {
  verdict: "on_track" | "behind" | "ahead" | "no_goal_point" | "no_reading";
  week: string | null;
  reading: number | null;
  goal: number | null;
  deviation: number | null;
  weeksBehind: number;
}

export interface BodyTrends {
  member: string;
  /** What the call resolved to; null when the member has no goal points (a headline call). */
  metric: string | null;
  canonical_unit: string | null;
  segments: { start: string | null; readings: { id: number; date: string; value_canonical: number; unit: string }[] }[];
  method_changes: { date: string; note: string }[];
  seven_day_averages?: { date: string; average_kg: number | null }[];
  goal_points: { week_of: string; tier: "planned" | "stretch"; low: number; high: number }[];
  /** The last planned goal point, whatever the range. */
  end_target: { week_of: string; low: number; high: number } | null;
  current_week?: GoalVerdict;
  current_phase: { name: string; starts_on: string; ends_on: string | null; energy_stance: string } | null;
  headline: { metric: string | null; direction: "decrease" | "increase" | null; reason: string | null };
  waist_to_height?: {
    height_cm: number;
    height_measured_on: string;
    segments: { start: string | null; readings: { date: string; value: number }[] }[];
    goal_path: { week_of: string; value: number }[];
    goal_points: { week_of: string; tier: string; low: number; high: number }[];
    end_target: { week_of: string; low: number; high: number } | null;
    band: number;
    current_week: GoalVerdict;
  } | null;
}

export interface WeekSummary {
  member: string;
  week_start: string;
  week_end: string;
  days: {
    date: string;
    day_status: string;
    item_count: number;
    kcal: number | null;
    kcal_target: number | null;
    protein: number | null;
    protein_target: number | null;
    /** Absent from an older Worker. */
    unknown_items?: UnknownItems;
    training: { kind: "gym" | "dance" | "cardio"; template: string | null; energy_kcal: number | null }[];
    kind: "gym" | "dance" | "cardio" | "rest";
  }[];
  measured: { kcal_measured: number; kcal_known: number; share: number | null };
  energy_availability: {
    value: number; low: boolean; threshold: number; ffm_kg: number; ffm_measured_on: string; days_counted: number;
    intake_kcal_per_day: number; exercise_kcal_per_day: number; sessions_without_energy: number;
  } | null;
  energy_availability_missing: string | null;
}

export interface LabResult {
  id: number;
  marker: string;
  value: number | null;
  comparator: string | null;
  value_text: string | null;
  unit: string | null;
  ref_low: number | null;
  ref_high: number | null;
  ref_text: string | null;
  status: "below" | "above" | "within" | null;
  change: { previous: number; previous_on: string; delta: number } | null;
}

export interface BloodDraws {
  member: string;
  draws: { id: number; drawn_on: string; lab: string; fasting: number | null; state: string; results: LabResult[] }[];
}

export interface Flags {
  flags: { id: number; subtype: string; subject: string; due_on: string | null; status: string; note: string | null; raised_on: string }[];
}

/** household_overview's waiting_on_you: a draft about the signed-in member. */
export interface WaitingDraft {
  table: string;
  id: number;
  summary: string;
  logged_by: string | null;
  logged_at: string;
  deadline: string | null;
  waits: "end_of_session" | "rir_needed" | null;
}

export interface HouseholdOverview {
  date: string;
  members: {
    member: string;
    you: boolean;
    day_status: string;
    kcal_left: number | null;
    protein_left: number | null;
    /** Absent from an older Worker. */
    unknown_items?: UnknownItems;
    drafts: { count: number; oldest: { table: string; id: number; deadline: string | null; waits: "end_of_session" | "rir_needed" | null } | null };
    last_session: { date: string; session_type: string; template: string | null } | null;
  }[];
  meals: { date: string; cooks: DayCook[] }[];
  leftovers: { cook_id: number; cook: string; cooked_on: string; component_id: number; component: string | null; fraction: number; kcal: number | null; since: string }[];
  waiting: { table: string; id: number; about: string; summary: string; deadline: string | null; waits: "end_of_session" | "rir_needed" | null }[];
  /** Every draft about the signed-in member, oldest first, at most 100 (desktop spec §4). Absent from an older Worker. */
  waiting_on_you?: { drafts: WaitingDraft[]; truncated: boolean };
}

export interface DescribedSet {
  id: number;
  exercise: string;
  set_number: number;
  set_type: string;
  reps: number | null;
  load_status: "entered" | "none" | "not_recorded";
  load_value: number | null;
  load_unit: "kg" | "lb" | null;
  load_basis: string | null;
  bar: LoadAmount | null;
  plates: (LoadAmount & { count: number })[] | null;
  rir: { low: number; high: number } | "not_recorded" | null;
  state: "draft" | "confirmed";
  /** A hold's seconds or a carry's distance, when the set isn't counted in reps (Worker decision 144). */
  duration_s?: number | null;
  distance?: { value: number; unit: string } | null;
}

/** The sessions tool: reverse-chronological sessions, volume and records computed server-side. */
export interface SessionsList {
  member: string;
  from: string;
  to: string;
  sessions: {
    id: number;
    date: string;
    session_type: string;
    template: string | null;
    gym: string | null;
    state: string;
    imported: boolean;
    working_sets: number;
    volume_kg: number;
    records: { exercise: string; e1rm_kg: number; previous_best_kg: number }[];
    /** `block_ids`: the session's cardio blocks, in order (Worker decision 145). */
    cardio: { blocks: number; duration_s: number | null; block_ids?: number[] } | null;
    energy_kcal: number | null;
    sets: DescribedSet[];
  }[];
}

export type NoE1rm = "bodyweight_dominant" | "plates_only" | "no_reps" | "no_rir" | "over_cap";
export interface LiftGoal { week_of: string; tier: string | null; low?: number; high?: number; unit?: string | null; multiple_low?: number; multiple_high?: number }
export interface LiftTrends {
  member: string;
  lifts: { exercise_id: number; exercise: string; slug: string; implement_kind: string; bodyweight_dominant: boolean; last_done: string; sessions: number; best_e1rm: { kg: number; on: string; session_id: number; implement: string | null; reps: number; rir_low: number } | null; no_e1rm: NoE1rm | null; best_top_set: { kg: number; on: string; session_id: number } | null; next_goal: LiftGoal | null }[];
  weekly_volume: { week_start: string; sessions: number; working_sets: number; volume_kg: number | null; sets_without_volume: number }[];
}
export interface LiftDetail {
  member: string; exercise_id: number; exercise: string; slug: string; bodyweight_dominant: boolean;
  points: { session_id: number; date: string; state: "draft" | "confirmed"; segment: number; e1rm: { kg: number; implement: string | null; set_id: number; reps: number; rir_low: number; effective_reps: number; reps_assumed: boolean } | null; top_set: { set_id: number; total_kg: number; reps: number | null } | null; volume_kg: number | null; working_sets: number; sets_without_volume: number }[];
  goals: LiftGoal[];
  method_changes: { date: string; note: string }[];
  sessions: { session_id: number; date: string; sets: unknown[] }[];
}

export interface HistoryVersion {
  version: number;
  action: "create" | "amend" | "confirm" | "reject" | "delete" | "retract";
  data: Record<string, unknown>;
  created_at: string;
  resolver: string;
  origin: string;
  tool: string;
  reason: string | null;
  actor: string | null;
  speaker: string | null;
  on_behalf_of: string | null;
}

// ------------------------------------------------------------ input (the + sheet)

export type RecentItem =
  | { kind: "food_source"; name: string; ref: string; state: string; count: number; last_on: string; usual: { food: string; value: number; unit?: string; measure?: string } }
  | { kind: "recipe"; name: string; ref: string; count: number; last_on: string; usual: { recipe: string; servings: number } };

export type SetLoadValue = "none" | { value: number; unit: "kg" | "lb"; basis: string; bar?: LoadAmount; plates?: (LoadAmount & { count: number })[] };

export interface RecentExercise {
  exercise: string;
  count: number;
  last_on: string;
  today: boolean;
  usual: { load: SetLoadValue | null; reps: number | null };
}

export interface RecentItems {
  member: string;
  from: string;
  to: string;
  items: RecentItem[];
  exercises: RecentExercise[];
}

export type CatalogueHit =
  | { kind: "food_source"; id: number; ref: string; name: string; state: string; aliases: string[]; score: number }
  | { kind: "recipe"; id: number; ref: string; name: string; recipe_kind: string; aliases: string[]; score: number }
  | { kind: "exercise"; id: number; name: string; implement_kind: string; aliases: string[]; score: number }
  | { kind: "workout"; id: number; name: string; aliases: string[]; score: number };

export interface FoodSourceDetail {
  id: number;
  ref: string;
  name: string;
  state: string;
  reference_amount: number;
  reference_unit: "g" | "ml" | "piece";
  measures: { name: string; amount: number }[];
}

export interface RecipeLineDetail {
  id: number;
  position: number;
  ref: string;
  name: string;
  state: string;
  amount_value: number;
  amount_unit: string;
  measure: string | null;
}

export interface RecipeDetail {
  id: number;
  ref: string;
  name: string;
  kind: string;
  servings: number;
  lines: RecipeLineDetail[];
}

export interface CatalogueLookup {
  food_sources: FoodSourceDetail[];
  recipes: RecipeDetail[];
  missing: string[];
}

export interface WhatIf {
  items: { nutrients: Partial<Record<string, NutrientTotal>> }[];
  day: DayTotals;
}

export interface PreviewMeal {
  cooks: {
    name: string;
    recipe_id: number | null;
    components: unknown[];
    lines: unknown[];
    totals: Partial<Record<string, NutrientTotal>>;
    portions: { member: string; component: string; kind: string; fraction: number | null; weighed_g: number | null; nutrients: Partial<Record<string, NutrientTotal>> | null }[];
    remainder: { component: string; fraction: number; status: string }[];
  }[];
  items: unknown[];
  members: Record<string, Partial<Record<string, NutrientTotal>>>;
}

/** inventory's implement: its listed loads (null for plate-loaded kit), loads known not to be there, and a bar's weight. */
export interface InventoryImplement {
  id: number;
  name: string;
  kind: string;
  unit: "kg" | "lb";
  loading: string;
  load_list_complete: boolean;
  bar: LoadAmount | null;
  loads: LoadAmount[] | null;
  absent: LoadAmount[];
  plates: unknown;
}

export interface Inventory {
  gym: string;
  gym_id: number;
  plates: { unit: "kg" | "lb"; complete: boolean; note: string | null; plates: { value: number; status: "confirmed" | "inferred" | "absent" }[] }[];
  implements: InventoryImplement[];
}

export interface PreviewSet {
  set: Record<string, unknown> & { total_kg?: number | null; exercise?: string };
  /** The domain's SnapResult: off the list, the listed loads either side. */
  snap: { status: string; value: number; unit: "kg" | "lb"; below?: LoadAmount | null; above?: LoadAmount | null } | null;
  offer: Record<string, unknown> | null;
  implausible: { ratio: number; referenceKg: number; likelyCause: string } | null;
  read_from: LoadAmount | null;
  state: "draft" | "confirmed";
  session: { id: number | null; would_create: boolean; template: string | null; workout: string | null };
}
export interface NextForEntry {
  programming_mode: "prescribed" | "record_only";
  session: string | null;
  prescriptions?: {
    prescription_id: number;
    exercise: string;
    sets: number | null;
    target: { kind: "reps"; low: number | null; high: number | null } | { kind: "duration"; low_s: number | null; high_s: number | null } | { kind: "distance"; value: number | null; unit: string | null };
    rir_target: { low: number; high: number | null } | null;
    load: PrescribedLoad | null;
  }[];
}

export interface WorkoutLineOut {
  id: number;
  position: number;
  exercise: string;
  set_type: string;
  sets: number;
  target: { kind: "reps"; low: number; high: number } | { kind: "duration"; seconds: number } | { kind: "distance"; value: number; unit: string };
  load: null | "none" | { value: number; unit: "kg" | "lb"; basis: string; bar: LoadAmount | null; plates: (LoadAmount & { count: number })[] | null };
  rir: { low: number; high: number } | null;
  rest_s: number | null;
  note: string | null;
}

export interface WorkoutOut {
  id: number;
  name: string;
  note: string | null;
  aliases: string[];
  last_used: string | null;
  lines: WorkoutLineOut[];
}

export type ProgressState =
  | { kind: "ready"; next_load: NextLoad | null }
  | { kind: "needs_confirmation"; set_ids: number[]; next_load: NextLoad | null }
  | { kind: "check_at_gym"; question: string; next_load: NextLoad }
  | { kind: "holding"; reason: string }
  | { kind: "cant_move"; reason: string };

export interface LogWorkout {
  session: { id: number; created: boolean; template: string | null; workout: string | null; state: string };
  sets: unknown[];
  /** A cardio machine's lines, stored as cardio blocks in the session (Worker decision 151); absent from an older Worker. */
  cardio?: { index: number; id: number; activity: string; duration_s: number | null; distance: { value: number; unit: string } | null; position: number }[];
  progression: { prescription_id: number; exercise: string; state: ProgressState }[];
}

export interface Span {
  text: string;
  start: number;
  end: number;
}

export interface InboxEntry {
  id: number;
  member: string;
  date: string;
  meal_slot: string | null;
  text: string;
  spans: Span[];
  status: "pending" | "resolved" | "rejected";
  note: string | null;
  created_at: string;
}

export interface Learned {
  aliases: { id: number; alias: string; kind: "food_source" | "recipe" | "exercise" | "workout"; target_id: number; target: string; created_by: string | null; created_at: string }[];
  router: { member: string; week_of: string; unedited: number; edited: number; inbox: number; pieces: number; share_unedited: number | null }[];
}

/** reading_metrics: what can be logged as a reading, with the units the metric table allows. */
export interface ReadingMetric {
  code: string;
  label: string;
  dimension: string;
  units: string[];
  /** The sides the member has logged this metric on; empty when never by side. */
  sides: ("left" | "right")[];
  /** The unit the member uses most for this metric (canonical with none); absent from a Worker before click test P1-2. */
  usual_unit?: string | null;
  last: { date: string; value: number; unit: string; body_state: string; side: "left" | "right" | null } | null;
}

export interface RecentReading {
  id: number;
  metric: string;
  date: string;
  value: number;
  unit: string;
  side: "left" | "right" | null;
  body_state: string;
}

export interface ReadingMetrics {
  member: string;
  metrics: ReadingMetric[];
  /** The member's latest confirmed readings, newest first (click test P1-3); absent from an older Worker. */
  recent?: RecentReading[];
}

/** log_reading's answer: the parts the Reading tab shows after a Save. */
export interface LoggedReading {
  reading: { id: number; metric: string; value: number; unit: string; measured_on: string; state: string; value_canonical: number; canonical_unit: string };
  computed: {
    change: { previous: number; previous_on: string; delta: number; real_change: boolean | null } | null;
    seven_day_average_kg?: number | null;
    waist_to_height?: number | null;
  };
}

/** health_drafts: drafts about your body and blood, for you to confirm or reject. */
export interface HealthDrafts {
  member: string;
  readings: { id: number; metric: string; label: string; date: string; value: number; unit: string; side: string | null; body_state: string; logged_by: string | null; deadline: string | null }[];
  draws: { id: number; drawn_on: string; lab: string; fasting: number | null; results: number; logged_by: string | null; deadline: string | null }[];
}

// ------------------------------------------------------------ catalogue (desktop spec §5)

export type MacroKey = "kcal" | "protein_g" | "carbs_g" | "fat_g";
export type MicroKey = "sodium_mg" | "fibre_g" | "iron_mg" | "b12_ug" | "calcium_mg" | "magnesium_mg" | "potassium_mg" | "sat_fat_g" | "total_sugars_g" | "vitamin_c_mg";

export interface CatalogueListFood {
  id: number;
  ref: string;
  name: string;
  state: string;
  reference_amount: number;
  reference_unit: "g" | "ml" | "piece";
}

export interface CatalogueListRecipe {
  id: number;
  ref: string;
  name: string;
  kind: "dish" | "idea";
  servings: number;
  lines: number;
}

export interface CatalogueListExercise {
  id: number;
  name: string;
  implement_kind: string;
  last_done: string | null;
}

export interface CatalogueListGym {
  id: number;
  name: string;
  equipment: number;
}

/** catalogue_list's answer: 200 a page. */
export interface CatalogueListPage<T> {
  kind: string;
  offset: number;
  items: T[];
  truncated: boolean;
  next_offset: number | null;
}

/** catalogue_lookup's food source: the stored row (micronutrients null when unknown), its measures, yields and cost. */
export type FoodRecord = {
  id: number;
  ref: string;
  name: string;
  state: string;
  reference_amount: number;
  reference_unit: "g" | "ml" | "piece";
  protein_band: string | null;
  price_min_inr: number | null;
  price_max_inr: number | null;
  primary_category: string | null;
  tags: string | null;
  last_checked_on: string | null;
  energy_override_reason: string | null;
  measures: { name: string; amount: number }[];
  yields_from: { from_ref: string; from_state: string; factor: number; discarded_fraction: number }[];
  cost_per_25g_protein_inr: { min: number; max: number } | null;
} & Record<MacroKey, number> &
  Record<MicroKey, number | null>;

export interface RecipeLineRecord {
  id: number;
  position: number;
  ref: string;
  name: string;
  state: string;
  amount_value: number;
  amount_unit: string;
  measure: string | null;
}

/** catalogue_lookup's recipe (meal_type, prep_type and method from Worker decision 128). */
export interface RecipeRecord {
  id: number;
  ref: string;
  name: string;
  kind: "dish" | "idea";
  servings: number;
  meal_type: string | null;
  prep_type: string | null;
  method: string | null;
  derived: boolean;
  manual_macros_reason: string | null;
  per_serving: Partial<Record<"kcal" | "protein" | "carbs" | "fat", NutrientTotal>> | null;
  lines: RecipeLineRecord[];
}

export interface CatalogueRecords {
  food_sources: FoodRecord[];
  recipes: RecipeRecord[];
  missing: string[];
}

/** catalogue_dependents (intake_dates from Worker decision 129). */
export interface Dependents {
  kind: "food_source" | "recipe";
  ref: string;
  recipes: { ref: string; name: string }[];
  cooks: { id: number; name: string; cooked_on: string }[];
  intake_items: number;
  intake_dates: { first: string; last: string } | null;
  yields: { to_ref: string; to_state: string; factor: number }[];
}

/** last_trained with an exercise: the member's last day and the days since, as the API counts them. */
export interface LastTrained {
  member: string;
  exercise?: string;
  last: string | null;
  days_since: number | null;
}

/** nutrition_trends: one page of Sunday weeks; every value and flag is the Worker's. */
export type TrendMacro = "kcal" | "protein" | "carbs" | "fat";
export interface NutrientDayOut {
  value: number;
  known: number;
  of: number;
  complete: boolean;
}
export interface NutritionDayOut {
  date: string;
  status: "complete" | "open" | "partial" | "future";
  logged: boolean;
  source: "items" | "manual_day_total" | "empty";
  counted: boolean;
  not_counted: null | "unlogged" | "partial" | "today_open" | "future";
  item_count: number;
  draft_items: number;
  kcal: NutrientDayOut | null;
  protein: NutrientDayOut | null;
  carbs: NutrientDayOut | null;
  fat: NutrientDayOut | null;
  target: Record<TrendMacro, number> | null;
  macro_kcal: { protein: number; carbs: number; fat: number } | null;
  cost: { min: number; max: number; priced_items: number; items: number; complete: boolean } | null;
  cost_per_25g_protein: { min: number; max: number; priced_protein_g: number } | null;
  cost_missing: null | "nothing_priced" | "no_protein_in_priced_items" | "manual_day_total";
}
export interface NutritionWeekOut {
  week_start: string;
  week_end: string;
  days: { in_range: number; counted: number; logged: number; complete: number; partial: number; unlogged: number; today_open: number; open_counted: number };
  average: Record<TrendMacro, { value: number; days: number } | null>;
  target_average: Record<TrendMacro, number | null>;
  macro_split: { protein: number; carbs: number; fat: number } | null;
  cost: { min: number; max: number; days: number } | null;
  cost_per_25g_protein: { min: number; max: number } | null;
  cost_items: { priced: number; of: number } | null;
}
export interface NutritionTrends {
  member: string;
  from: string | null;
  to: string | null;
  today: string;
  pages: { from: string; to: string }[];
  capped: boolean;
  first_logged_on: string | null;
  days: NutritionDayOut[];
  weeks: NutritionWeekOut[];
}
