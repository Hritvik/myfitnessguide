import type { Load, LoadUnit, Rir, RirAdjustedE1rm, SetDerived, TotalLoad } from "../types";
import { KG_PER_LB } from "./units";

export function toKg(value: number, unit: LoadUnit): number {
  return unit === "kg" ? value : value * KG_PER_LB;
}

export function fromKg(kg: number, unit: LoadUnit): number {
  return unit === "kg" ? kg : kg / KG_PER_LB;
}

/** The exact total in kg for a load as entered. */
export function totalLoad(load: Load): TotalLoad {
  // A composition's per-side load is its plates' sum, in whatever units they are.
  const kg =
    load.plates && load.plates.length > 0
      ? load.plates.reduce((sum, p) => sum + p.count * toKg(p.value, p.unit), 0)
      : toKg(load.value, load.unit);
  const limbs = load.unilateral ? 1 : 2;
  let total: number;
  switch (load.basis) {
    case "total":
      total = kg;
      break;
    case "per_side":
      total = 2 * kg + (load.implement.barKg ?? 0);
      break;
    case "plates_only":
      total = 2 * kg;
      break;
    case "per_hand":
    case "per_leg":
      total = limbs * kg;
      break;
  }
  const assisted = load.implement.assisted === true;
  return {
    kg: assisted ? -total : total,
    assisted,
    comparableAcrossImplements: load.basis !== "plates_only",
  };
}

/** Epley e1RM applies only to a set taken to failure (RIR 0) at 12 reps or fewer. */
export const E1RM_MAX_REPS = 12;

/**
 * How many shares the e1RM is split into (the split convention). A
 * barbell or plate-loaded machine is one lift, so its e1RM is the total. A
 * dumbbell per hand, a leg, or one side of a cable is its own lift, so the
 * e1RM is one share. Volume always counts every share.
 */
export function implementsSharing(load: Pick<Load, "basis" | "unilateral" | "implement">): number {
  switch (load.basis) {
    case "total":
    case "plates_only":
      return 1;
    case "per_side":
      return load.implement.kind === "cable" ? 2 : 1;
    case "per_hand":
    case "per_leg":
      return load.unilateral ? 1 : 2;
  }
}

/**
 * Volume and e1RM, both from the same exact total load. Volume counts every
 * limb; e1RM is on the per-implement load (one hand's dumbbell, one leg,
 * one side), so a per_hand, per_side or per_leg set's e1RM is the total's
 * share per implement. On a
 * bodyweight-dominant exercise (a goblet squat with a small dumbbell) the
 * external load is a fraction of what moves, so there is no e1RM; volume
 * is still the external load's.
 */
export function setDerived(set: { load: Load; reps: number | null; rir: Rir; bodyweightDominant?: boolean }): SetDerived {
  const total = totalLoad(set.load);
  const usable = !total.assisted && set.reps !== null;
  const volumeKg = usable && set.reps !== null ? total.kg * set.reps : null;
  const atFailure = set.rir !== null && set.rir !== "not_recorded" && set.rir.high === 0;
  const e1rmKg =
    usable && set.reps !== null && atFailure && !set.bodyweightDominant && set.reps >= 1 && set.reps <= E1RM_MAX_REPS && total.kg > 0
      ? (total.kg / implementsSharing(set.load)) * (1 + set.reps / 30)
      : null;
  return { totalKg: total.kg, volumeKg, e1rmKg };
}

/**
 * Epley estimate for charts using effective reps (`reps + RIR.low`). This is
 * deliberately separate from `setDerived`: stored strict e1RM and progression
 * continue to require a set taken to failure.
 */
export function rirAdjustedE1rm(set: {
  load: Load | null;
  reps: number | null;
  rir: Rir;
  repsConfirmed?: boolean;
  bodyweightDominant?: boolean;
}): RirAdjustedE1rm | null {
  if (set.load === null || set.reps === null || set.rir === null || set.rir === "not_recorded" || set.bodyweightDominant) return null;
  if (!Number.isFinite(set.reps) || !Number.isFinite(set.rir.low) || set.reps < 1 || set.rir.low < 0) return null;

  const effectiveReps = set.reps + set.rir.low;
  if (effectiveReps > E1RM_MAX_REPS) return null;

  const total = totalLoad(set.load);
  if (total.assisted || !total.comparableAcrossImplements || total.kg <= 0) return null;

  return {
    e1rmKg: (total.kg / implementsSharing(set.load)) * (1 + effectiveReps / 30),
    repsSource: set.repsConfirmed === false ? "inferred" : "reported",
  };
}
