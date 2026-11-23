/**
 * Plain input and output types for the domain rules. Terms follow
 * CONTEXT.md. These are not the database tables; the worker maps rows to
 * and from them.
 */

/** An ISO calendar date, 'YYYY-MM-DD'. */
export type IsoDate = string;

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

/** One thing to nudge about when it falls overdue. `last: null` = never done. */
export interface StalenessItem {
  name: string;
  last: IsoDate | null;
  everyDays: number;
  message: string;
}

/** A label's macros against its stated energy (Atwater 4/4/9). */
export interface LabelEnergyCheck {
  reconciles: boolean;
  atwaterKcal: number;
  /** Atwater minus stated: negative when the macros account for less energy than the label states. */
  differenceKcal: number;
  toleranceKcal: number;
}

/** Catalogue integrity inputs (gymcalc catalogue_problems). */
export interface CatalogueRecipe {
  ref: string;
  derivation: "derived" | "stored";
  /** Number of ingredient lines. */
  lines: number;
}

export interface CatalogueIngredientLine {
  recipe: string;
  foodId: string | null;
}

// --------------------------------------------------------------- Nutrition

/** Units an amount can be typed in. `each` counts whole items. */
export type AmountUnit = "mg" | "g" | "kg" | "ml" | "l" | "each";

/**
 * Nutrient values per reference amount, keyed by nutrient (kcal, protein,
 * carbs, fat, fibre, sodium, iron, ...). A missing key or null means
 * unknown; 0 means measured zero.
 */
export type Nutrients = Readonly<Record<string, number | null | undefined>>;

/** A single food in one state, with its nutrients per reference amount. */
export interface FoodSource {
  id: string;
  /** The food across its states, e.g. "rice"; sources differing only by state share it. */
  food: string;
  /** e.g. "dry", "cooked", "whole, shelled". */
  state: string;
  referenceAmount: { value: number; unit: AmountUnit };
  /** Named units of this source, each worth `amount` of the reference unit. */
  measures?: readonly { name: string; amount: number }[];
  nutrients: Nutrients;
}

/**
 * The conversion between two states of the same food. A discarded fraction
 * (egg yolks) is removed first; the factor applies to what is kept:
 * to = from x (1 - discardedFraction) x factor.
 */
export interface Yield {
  food: string;
  fromState: string;
  toState: string;
  factor: number;
  discardedFraction?: number;
}

/** An amount as entered: a unit or a named measure, and optionally a state. */
export interface AmountInput {
  food: string;
  value: number;
  unit?: AmountUnit;
  measure?: string;
  state?: string;
}

export type Clarification = {
  kind: "clarify";
  reason: "unknown_food" | "ambiguous_state" | "unknown_state" | "unknown_measure" | "unit_mismatch" | "no_unit";
  question: string;
  options: string[];
};

export type AmountResolution =
  | {
      kind: "resolved";
      sourceId: string;
      /** In the source's reference unit. */
      amount: number;
      /** amount / referenceAmount.value: how many reference amounts. */
      multiples: number;
      yieldApplied: { fromState: string; toState: string; factor: number; discardedFraction: number } | null;
    }
  | Clarification;

/**
 * A summed nutrient with its coverage: `value` sums the known
 * contributions; `known` of `of` contributions had a value.
 */
export interface NutrientTotal {
  value: number;
  known: number;
  of: number;
}

export type NutrientTotals = Readonly<Record<string, NutrientTotal>>;

/** One ingredient line of a cook, already resolved to reference amounts. */
export interface CookLine {
  /** Defaults to "main". */
  component?: string;
  source: FoodSource;
  multiples: number;
}

/** One real preparation of food, with its actual ingredient quantities. */
export interface Cook {
  lines: readonly CookLine[];
  components?: readonly { name: string; cookedWeightG?: number }[];
  /** Cooked weight of a single-component cook. */
  cookedWeightG?: number;
}

/** One person's share of one component: a fraction, or a weighed amount of its cooked weight. */
export interface Portion {
  member: string;
  /** Defaults to the cook's only component. */
  component?: string;
  share: { fraction: number } | { weighedG: number };
}

export type RemainderDisposition = "eaten" | "leftover" | "discarded";

export interface RemainderMark {
  component: string;
  disposition: RemainderDisposition;
  /** Who ate it, when eaten. */
  by?: string;
}

export interface CookResult {
  components: { name: string; cookedWeightG: number | null; totals: NutrientTotals }[];
  totals: NutrientTotals;
  portions: { member: string; component: string; fraction: number | null; nutrients: NutrientTotals | null }[];
  remainder: {
    component: string;
    fraction: number;
    status: "unaccounted" | RemainderDisposition;
    nutrients: NutrientTotals;
  }[];
  problems: string[];
}

export interface DayTotals {
  /** items: summed from intake items; manual_day_total: a legacy DAY TOTAL; empty: nothing logged. */
  source: "items" | "manual_day_total" | "empty";
  totals: NutrientTotals;
  /** True when the day has both items and a manual day total (goes to a ruling). */
  conflict: boolean;
}

/** A macro target: a goal with an optional floor, or "whatever is left" of the kcal target. */
export type MacroTarget = { goal: number; floor?: number } | { remainder: true; floor?: number };

/** A dated set of intake targets for one person (the date lives on the record). */
export interface Target {
  kcal: number;
  protein: MacroTarget;
  fat: MacroTarget;
  carbs: MacroTarget;
}

export type Macro = "protein" | "fat" | "carbs";

export interface ResolvedTarget {
  kcal: number;
  protein: { goal: number; floor: number | null };
  fat: { goal: number; floor: number | null };
  carbs: { goal: number; floor: number | null };
}

export interface LeftLine {
  goal: number;
  consumed: number;
  /** goal - consumed; negative when over. */
  left: number;
  floor: number | null;
  /** How much more is needed to reach the floor; 0 once reached; null without a floor. */
  floorLeft: number | null;
  coverage: { known: number; of: number };
}

export type LeftToday = Record<"kcal" | Macro, LeftLine>;

// ---------------------------------------------------------- Body and health

/** One reading of one metric for one person. Only fasted weights are averaged. */
export interface BodyReading {
  date: IsoDate;
  value: number;
  fasted?: boolean;
}

export interface EnergyAvailability {
  /** kcal per kg of fat-free mass. */
  value: number;
  /** Below 25 kcal/kg FFM. */
  low: boolean;
}

export interface GoalVerdict {
  verdict: "on_track" | "behind" | "ahead" | "no_goal_point" | "no_reading";
  /** The Sunday starting the week judged. */
  week: IsoDate | null;
  reading: number | null;
  goal: number | null;
  /** reading - goal. */
  deviation: number | null;
  /** Consecutive weeks, ending this one, with a reading outside the band on the behind side. */
  weeksBehind: number;
}

// ---------------------------------------------------------------- Training

export type LoadUnit = "kg" | "lb";

/** A load in its own (native) unit. */
export interface LoadAmount {
  value: number;
  unit: LoadUnit;
}

/**
 * A stated load read in its native unit: the unit that makes it a whole or
 * half number. `converted` says the stated unit was not the native one.
 * Ambiguous when clean in both units (options: both) or in neither.
 */
export type NativeReading =
  | { status: "clean"; value: number; unit: LoadUnit; converted: boolean }
  | { status: "ambiguous"; reason: "clean_in_both" | "clean_in_neither"; options: LoadAmount[] };

/**
 * How an entered value relates to the whole load:
 * - total: the whole load (a stack, a cable, a fixed bar)
 * - per_side: plates on one side; the implement's bar is added
 * - per_hand / per_leg: what one limb moves; both limbs unless unilateral
 * - plates_only: plates on one side of an unmarked sled; the sled is left
 *   out, so the total is internally consistent but not absolute
 */
export type LoadBasis = "total" | "per_side" | "per_hand" | "per_leg" | "plates_only";

/** Plates of one denomination on one side: `count` of them. */
export interface PlateGroup extends LoadAmount {
  count: number;
}

/** A gym's plates, as far as they are known. */
export interface PlateInventory {
  /** Denominations available, in any unit. */
  available: readonly LoadAmount[];
  /** Denominations known not to exist. */
  absent?: readonly LoadAmount[];
  /** Every denomination is known; false means a heavier or in-between combination may exist. */
  complete: boolean;
}

/**
 * One load an implement can produce, in its native unit, with its weight
 * in kg. A plate combination carries its plates (per side); a mixed-unit
 * combination reads in kg.
 */
export interface ProducibleLoad extends LoadAmount {
  kg: number;
  plates?: PlateGroup[];
}

/** A neighbour on the list: the load in its own unit, with plates for a combination. */
export type ListedLoad = LoadAmount & { plates?: PlateGroup[] };

/** The kinds of implement, as the schema names them. */
export type ImplementKind =
  | "barbell"
  | "dumbbell"
  | "kettlebell"
  | "machine"
  | "plate_loaded"
  | "cable"
  | "fixed_bar"
  | "plates"
  | "bodyweight"
  | "band"
  | "cardio_machine"
  | "other";

/** One piece of a gym's equipment, with the loads it can produce. */
export interface Implement {
  id: string;
  /** What it is; decides how a per-side load's e1RM is split (only a cable splits by side). */
  kind?: ImplementKind;
  /** The unit its loads are marked in. */
  unit: LoadUnit;
  /**
   * Explicit producible loads, in the basis loads are entered on it: a bare
   * number is in `unit`, an amount in its own native unit (a list may mix
   * kg and lb). Absent or empty, with no `plates`, means the gym has no
   * inventory for it: loads are logged as entered and never snapped.
   */
  loads?: readonly (number | LoadAmount)[];
  /** Loads known not to exist ("there's no 15 kg dumbbell"); never proposed. */
  absent?: readonly LoadAmount[];
  /**
   * Barbell and plate-loaded kit: the gym's plates. Producible loads are
   * then the symmetric per-side combinations of these plates (any units),
   * derived rather than listed.
   */
  plates?: PlateInventory;
  /** Bar weight in kg added to per_side plates (a 20 kg barbell). */
  barKg?: number;
  /** An assistance machine: the entered value helps, so the load is negative. */
  assisted?: boolean;
  /** The top of its range is not established (fixed bars): `loads` may be incomplete upward. */
  maxUnknown?: boolean;
}

/** A load as entered. The total in kg is computed, never stored rounded. */
export interface Load {
  value: number;
  unit: LoadUnit;
  basis: LoadBasis;
  implement: Implement;
  /** per_hand / per_leg done one limb at a time. */
  unilateral?: boolean;
  /**
   * A composition: the plates on each side (per_side or plates_only), in
   * any units. When given, `value` and `unit` are ignored and the per-side
   * load is the plates' sum; the bar or sled is the implement's `barKg`.
   */
  plates?: readonly PlateGroup[];
}

export interface TotalLoad {
  /** Exact total in kg; negative for assistance. */
  kg: number;
  assisted: boolean;
  /** False for plates_only, whose sled weight is unknown. */
  comparableAcrossImplements: boolean;
}

/**
 * An entered value checked against an implement's producible loads. `value`
 * and `unit` are the entered load read in its native unit (or the matching
 * listed load). Off the list, `mayExist` says the list's top or the gym's
 * plates are not fully known, so the load may still be producible.
 */
export type SnapResult =
  | { status: "no_inventory"; value: number; unit: LoadUnit }
  | { status: "on_list"; value: number; unit: LoadUnit; plates?: PlateGroup[] }
  | {
      status: "off_list";
      value: number;
      unit: LoadUnit;
      plates?: PlateGroup[];
      below: ListedLoad | null;
      above: ListedLoad | null;
      nearest: ListedLoad;
      mayExist: boolean;
    };

/** A warning that a logged load is far from the exercise's history. */
export interface ImplausibleLoad {
  /** |new| / |reference|. */
  ratio: number;
  /** The history load compared against, in kg. */
  referenceKg: number;
  likelyCause: "lb_entered_as_kg" | "kg_entered_as_lb" | "basis_doubled" | "basis_halved" | "unknown";
}

/** Reps in reserve as reported: a range, not recorded, or blank (a draft). */
export type Rir = { low: number; high: number } | "not_recorded" | null;

/**
 * Set types. Only working sets count toward progression. `calibration`
 * (load-finding probes) is kept from the Sheets Log alongside the Training
 * schema's four; blank means working.
 */
export type SetType = "working" | "warm-up" | "back-off" | "substitution" | "calibration";

/** One logged set, as the progression check needs it. */
export interface ProgressionSet {
  reps: number | null;
  rir: Rir;
  /** False when reps were inferred from a bulk "as prescribed" report. */
  repsConfirmed: boolean;
  setType?: SetType | "";
}

/** A progression rule as structured data: "add <increment> when <targetSets> x <repTop>". */
export interface ProgressionRule {
  targetSets: number;
  repTop: number;
  /**
   * A qualifying set reports at least this many reps in reserve at the easy
   * end of its range. Fewer means it was ground out (gymcalc's `rir_max`).
   */
  rirTarget: number;
  /**
   * The load step, in the implement's unit; a range like "2.5-5 kg" has a
   * max. "smallest_step" is whatever the next producible load is ("add the
   * smallest increment"), which needs an inventory to name.
   */
  increment?: { min: number; max?: number } | "smallest_step";
  /** Autoregulation: a working set this many reps or more under the rep floor holds or drops. Default 2. */
  autoregulationRepsUnder?: number;
}

/** What the progression check can see beyond the sets. All optional. */
export interface ProgressionContext {
  /** The prescription's rep range; repHigh is its cap, repLow its floor. */
  prescription?: { repLow: number; repHigh: number };
  /** The current prescribed load: a number in the implement's unit, or an amount in its own unit. */
  currentLoad?: number | LoadAmount;
  implement?: Implement;
}

/**
 * Where the load moves: its value and native unit, the plates per side for
 * a plate combination, and `unverified` when it is a normal step above what
 * the gym is known to have ("check it exists").
 */
export interface NextLoad {
  nextLoad: number | null;
  nextLoadUnit: LoadUnit | null;
  nextLoadPlates?: PlateGroup[];
  unverified?: true;
}

export type ProgressionReason =
  | "rule_met"
  | "too_few_working_sets"
  | "reps_missing"
  | "reps_below_requirement"
  | "rir_not_recorded"
  | "ground_out"
  | "autoregulation"
  | "increment_not_on_implement"
  | "at_highest_load"
  | "rep_cap_below_requirement"
  | "reps_inferred";

/**
 * fired: the rule is met; the load moves to `nextLoad` (null when the
 *   implement or current load is unknown).
 * needs_confirmation: the rule would fire, but some qualifying sets' reps
 *   were inferred from a bulk report ("done", "as prescribed").
 *   `inferredSets` are their 1-based positions among the qualifying sets.
 *   The load moves only after the reps are confirmed.
 * not_yet: the rule could fire later; `autoregulation` is set when the
 *   session landed far enough under the rep floor to hold or drop.
 * never: the rule cannot fire as written, whatever is lifted.
 */
export type ProgressionResult =
  | ({ verdict: "fired"; reason: "rule_met"; message: string } & NextLoad)
  | ({ verdict: "needs_confirmation"; reason: "reps_inferred"; message: string; inferredSets: number[] } & NextLoad)
  | {
      verdict: "not_yet";
      reason: ProgressionReason;
      message: string;
      autoregulation: { action: "hold" } | { action: "drop"; dropTo: number | null; dropToUnit: LoadUnit | null } | null;
    }
  | { verdict: "never"; reason: ProgressionReason; message: string };

export interface SetDerived {
  totalKg: number;
  /** Null for assisted sets or missing reps. Unrounded. */
  volumeKg: number | null;
  /** Epley, only for RIR-0 sets of 1-12 reps on a positive load, never on a bodyweight-dominant exercise. Unrounded. */
  e1rmKg: number | null;
}

/** A chart-safe Epley estimate adjusted by the reported reps in reserve. */
export interface RirAdjustedE1rm {
  /** Unrounded e1RM on one implement share, in kg. */
  e1rmKg: number;
  /** Whether the performed reps were reported directly or inferred from a bulk report. */
  repsSource: "reported" | "inferred";
}

/** A legacy kg value read back into floor units (gymcalc whole_units). */
export type WholeUnits =
  | { unit: LoadUnit; value: number }
  | { unit: "combination"; description: string };

/**
 * How a programme says what comes next: a fixed weekday plan with one-off
 * swaps, or a rotation. A programme declares exactly one.
 */
export type Schedule =
  | { kind: "rotation"; order: readonly string[] }
  | {
      kind: "weekday";
      /** Session template name per weekday; a missing day is rest. */
      days: Partial<Record<Weekday, string>>;
      /** One-off replacements for a single date; null makes it a rest day. */
      swaps: readonly { date: IsoDate; session: string | null }[];
    };

export type LayoffPolicy = "normal" | "hold" | "back_off";

/** A prescription as the gap rule needs it. */
export interface GapPrescription {
  id: string;
  exerciseId: string;
  prescribedOn: IsoDate;
  template?: string;
}

/** Stimulus type of an exercise, which a fallback must match to count as coverage. */
export interface StimulusTags {
  mechanics?: "compound" | "isolation";
  position?: "lengthened" | "shortened" | "mid";
}

export interface FallbackCoverage {
  covered: boolean;
  mismatches: (keyof StimulusTags)[];
}

/** The next session; `date` is null for a rotation, which has no calendar. */
export interface NextSession {
  session: string;
  date: IsoDate | null;
}
