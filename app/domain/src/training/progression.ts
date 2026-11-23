import type {
  Implement,
  ProgressionContext,
  ImplementKind,
  LoadAmount,
  LoadUnit,
  NextLoad,
  ProducibleLoad,
  ProgressionReason,
  ProgressionResult,
  ProgressionRule,
  ProgressionSet,
  Rir,
  SetType,
} from "../types";
import { amountKg, inventoryOpen, producibleLoads } from "./inventory";
import { fromKg, toKg } from "./load";

/** Loads within this many kg are the same (unit conversion and 0.01 rounding of a converted increment). */
const EPS = 0.003;
/** A jump smaller than this fraction of the current load is not progress: a mixed-unit rack can hold 27.5 lb and 12.5 kg, 0.03 kg apart. */
const MEANINGFUL_FRACTION = 0.005;
const AUTOREGULATION_REPS_UNDER = 2;

function meaningfulGap(kg: number): number {
  return Math.max(EPS, Math.abs(kg) * MEANINGFUL_FRACTION);
}

const SET_TYPES: readonly SetType[] = ["working", "warm-up", "back-off", "substitution", "calibration"];

/** RIR above this is not a reading but noise (a Sheets date serial such as 46024). */
const MAX_PLAUSIBLE_RIR = 10;

/**
 * Read reported RIR: a number, a range like '1-2', or '4+'. Blank and
 * unreadable values are null, which the progression check treats as not
 * recorded.
 */
export function parseRir(value: string | number | null | undefined): Rir {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === "") return null;
  const match = /^(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?)|\+)?$/.exec(text);
  if (!match) return null;
  const low = Number(match[1]);
  const high = match[2] === undefined ? low : Number(match[2]);
  if (high < low || high > MAX_PLAUSIBLE_RIR) return null;
  return { low, high };
}

/**
 * The normal load step for a kind of implement, per unit: what to propose
 * (unverified) when the next load would go above what the gym is known to
 * have. Per side for barbells and plate-loaded kit, per hand for dumbbells.
 */
export const NORMAL_STEP: Record<ImplementKind, Record<LoadUnit, number>> = {
  barbell: { kg: 1.25, lb: 2.5 },
  plate_loaded: { kg: 2.5, lb: 5 },
  plates: { kg: 2.5, lb: 5 },
  dumbbell: { kg: 2.5, lb: 5 },
  kettlebell: { kg: 4, lb: 10 },
  machine: { kg: 5, lb: 10 },
  cable: { kg: 5, lb: 10 },
  fixed_bar: { kg: 5, lb: 10 },
  bodyweight: { kg: 2.5, lb: 5 },
  band: { kg: 2.5, lb: 5 },
  cardio_machine: { kg: 2.5, lb: 5 },
  other: { kg: 2.5, lb: 5 },
};

const round9 = (x: number): number => Math.round(x * 1e9) / 1e9;
const round2 = (x: number): number => Math.round(x * 100) / 100;

function show(a: LoadAmount): string {
  return `${round2(a.value)} ${a.unit}`;
}

function atHighest(current: LoadAmount): ProgressionResult {
  return { verdict: "never", reason: "at_highest_load", message: `${show(current)} is the highest load this implement produces` };
}

function toNext(l: ProducibleLoad): NextLoad {
  const next: NextLoad = { nextLoad: l.value, nextLoadUnit: l.unit };
  if (l.plates !== undefined) next.nextLoadPlates = l.plates;
  return next;
}

/**
 * The step to guess above what is known, in `unit`: the spacing of the two
 * heaviest known loads in that unit that differ meaningfully (a rack's real
 * ladder, including a ladder that widens at the top), else the kind's normal
 * step. Facts the member supplied, not a stored policy.
 */
function topStep(known: readonly ProducibleLoad[], implement: Implement, unit: LoadUnit, currentKg: number): number {
  // Plate-loaded kit's combinations are not a ladder: the next combination
  // above the top is a whole plate away, while the unknown plates may sit in
  // between. Its own normal step is the honest guess.
  if (implement.plates) return NORMAL_STEP[implement.kind ?? "other"][unit];
  const same = known.filter((l) => l.unit === unit);
  for (let i = same.length - 1; i > 0; i--) {
    const gap = same[i]!.value - same[i - 1]!.value;
    if (gap > 0 && toKg(gap, unit) > meaningfulGap(currentKg)) return round2(gap);
  }
  return NORMAL_STEP[implement.kind ?? "other"][unit];
}

/**
 * A normal step above what is known, in the current load's unit: `atLeastKg`
 * or more, on the known ladder's own spacing from the current load, skipping
 * loads known not to exist. Marked unverified: the member checks it exists.
 */
function unverifiedStep(current: LoadAmount, implement: Implement, atLeastKg: number, known: readonly ProducibleLoad[]): NextLoad {
  const step = topStep(known, implement, current.unit, amountKg(current));
  const absent = [...(implement.absent ?? []), ...(implement.plates?.absent ?? [])];
  let value = round9(current.value + step);
  while (toKg(value, current.unit) < atLeastKg - EPS) value = round9(value + step);
  // An increment that isn't a multiple of the step: the increment itself.
  const exact = round2(fromKg(atLeastKg, current.unit));
  if (toKg(value, current.unit) > atLeastKg + EPS && exact > current.value) value = exact;
  while (absent.some((a) => a.unit === current.unit && Math.abs(a.value - value) < 1e-9)) value = round9(value + step);
  return { nextLoad: value, nextLoadUnit: current.unit, unverified: true };
}

/**
 * Where a fired rule moves the load on an implement with an inventory, in
 * kg throughout so a list may mix units. Null without an inventory.
 * Returns `never` when the rule can't move on this implement.
 */
function nextLoadFor(current: LoadAmount, increment: ProgressionRule["increment"], implement: Implement): NextLoad | { never: ProgressionResult } | null {
  if (increment === undefined) return null;
  const currentKg = amountKg(current);
  const open = inventoryOpen(implement);
  const minKg = increment === "smallest_step" ? currentKg : currentKg + toKg(increment.min, implement.unit);
  const maxKg = increment === "smallest_step" ? currentKg : currentKg + toKg(increment.max ?? increment.min, implement.unit);
  const loads = producibleLoads(implement, { upToKg: Math.max(Math.abs(maxKg), Math.abs(currentKg)) + 50 });
  if (loads.length === 0) return null;
  const top = loads[loads.length - 1] as ProducibleLoad;

  if (increment === "smallest_step") {
    const above = loads.find((l) => l.kg > currentKg + meaningfulGap(currentKg));
    if (above === undefined) return open ? unverifiedStep(current, implement, currentKg, loads) : { never: atHighest(current) };
    // Plates not all known: a normal step lighter than the next known combination may exist.
    if (implement.plates && open) {
      const normal = unverifiedStep(current, implement, currentKg, loads);
      if (toKg(normal.nextLoad as number, current.unit) < above.kg - EPS) return normal;
    }
    return toNext(above);
  }

  const candidate = loads.find((l) => l.kg >= minKg - EPS && l.kg <= maxKg + EPS);
  if (candidate) return toNext(candidate);
  if (open && (implement.plates !== undefined || maxKg > top.kg + EPS)) return unverifiedStep(current, implement, minKg, loads);
  if (!loads.some((l) => l.kg > currentKg + meaningfulGap(currentKg))) return { never: atHighest(current) };
  const unit = implement.unit;
  return {
    never: {
      verdict: "never",
      reason: "increment_not_on_implement",
      message: `the increment does not exist on this implement: nothing between ${round2(fromKg(minKg, unit))} and ${round2(fromKg(maxKg, unit))} ${unit}`,
    },
  };
}

function notYet(reason: ProgressionReason, message: string): ProgressionResult {
  return { verdict: "not_yet", reason, message, autoregulation: null };
}

/**
 * Whether a lift has earned a load increase (R3).
 *
 * Only working sets count; blank is working. A qualifying set reaches the
 * rule's rep top with at least `rirTarget` in reserve at the easy end of its
 * range. DIRECTION MATTERS: the bracket is a rep CAP, so stopping at the top
 * with reps in reserve is the signal the load is too light; what
 * disqualifies a set is grinding (fewer in reserve than the target).
 */
export function progressionCheck(
  sets: readonly ProgressionSet[],
  rule: ProgressionRule,
  context: ProgressionContext = {},
): ProgressionResult {
  const working = sets.filter((s) => {
    const kind = s.setType || "working";
    if (!SET_TYPES.includes(kind)) throw new RangeError(`${String(kind)} is not one of ${SET_TYPES.join(", ")}`);
    return kind === "working";
  });

  // 1. Structural: can this rule ever fire, whatever is lifted?
  const { prescription, currentLoad, implement } = context;
  if (prescription && prescription.repHigh < rule.repTop) {
    return {
      verdict: "never",
      reason: "rep_cap_below_requirement",
      message: `the rep cap is below the rule's requirement: the prescription caps at ${prescription.repHigh} reps, the rule needs ${rule.repTop}`,
    };
  }
  const current: LoadAmount | undefined =
    currentLoad === undefined ? undefined : typeof currentLoad === "number" ? { value: currentLoad, unit: implement?.unit ?? "kg" } : currentLoad;
  let next: NextLoad = { nextLoad: null, nextLoadUnit: null };
  const increment = rule.increment;
  const stepped = current && implement ? nextLoadFor(current, increment, implement) : null;
  if (stepped && "never" in stepped) return stepped.never;
  if (stepped) next = stepped;
  else if (current && typeof increment === "object") {
    // No inventory: the current load plus the minimum increment.
    const unit = implement?.unit ?? current.unit;
    next = { nextLoad: round9(current.value + fromKg(toKg(increment.min, unit), current.unit)), nextLoadUnit: current.unit };
  }

  // 2. Autoregulation: 2+ reps under the rep floor holds or drops (Guide 46).
  if (prescription) {
    const under = rule.autoregulationRepsUnder ?? AUTOREGULATION_REPS_UNDER;
    const threshold = prescription.repLow - under;
    const firstShort = working.findIndex((s) => s.reps !== null && s.reps <= threshold);
    if (firstShort !== -1) {
      if (firstShort === 0) {
        const lighter =
          current !== undefined && implement
            ? ([...producibleLoads(implement, { upToKg: Math.abs(amountKg(current)) + 1 })].reverse().find((l) => l.kg < amountKg(current) - meaningfulGap(amountKg(current))) ?? null)
            : null;
        return {
          verdict: "not_yet",
          reason: "autoregulation",
          message: `the first working set landed ${under}+ reps under the floor of ${prescription.repLow}: drop the load`,
          autoregulation: { action: "drop", dropTo: lighter?.value ?? null, dropToUnit: lighter?.unit ?? null },
        };
      }
      return {
        verdict: "not_yet",
        reason: "autoregulation",
        message: `set ${firstShort + 1} landed ${under}+ reps under the floor of ${prescription.repLow}: hold the load`,
        autoregulation: { action: "hold" },
      };
    }
  }

  // 3. This session's sets against the rule.
  if (working.length < rule.targetSets) {
    return notYet("too_few_working_sets", `${working.length} working sets; the rule needs ${rule.targetSets}`);
  }

  const qualifying = working.slice(0, rule.targetSets);
  for (const [i, set] of qualifying.entries()) {
    if (set.reps === null) return notYet("reps_missing", `set ${i + 1} has no reps`);
    if (set.reps < rule.repTop) {
      return notYet("reps_below_requirement", `set ${i + 1} reached ${set.reps} reps; the rule needs ${rule.repTop}`);
    }
    if (set.rir === null || set.rir === "not_recorded") {
      return notYet("rir_not_recorded", `RIR not recorded on set ${i + 1}, so it cannot move the load`);
    }
    if (set.rir.high < rule.rirTarget) {
      return notYet("ground_out", `set ${i + 1} was ground out at RIR ${set.rir.high}; the rule needs ${rule.rirTarget}`);
    }
  }

  const met = `${rule.targetSets} x ${rule.repTop} at RIR ${rule.rirTarget} or more`;
  // A load never moves on reps nobody counted (gymcalc's needs_confirmation).
  const inferred = qualifying.flatMap((s, i) => (s.repsConfirmed ? [] : [i + 1]));
  if (inferred.length > 0) {
    return {
      verdict: "needs_confirmation",
      reason: "reps_inferred",
      message: `${met}, but the reps of set${inferred.length > 1 ? "s" : ""} ${inferred.join(", ")} were inferred from a bulk report: confirm them before the load moves`,
      ...next,
      inferredSets: inferred,
    };
  }
  const check = next.unverified ? `; ${show({ value: next.nextLoad as number, unit: next.nextLoadUnit as LoadUnit })} is above what the gym is known to have: check it exists` : "";
  return { verdict: "fired", reason: "rule_met", message: `${met}${check}`, ...next };
}
