import type { AmountInput, AmountResolution, AmountUnit, Clarification, FoodSource, Yield } from "../types";

const DIMENSION: Record<AmountUnit, { dim: "mass" | "volume" | "count"; scale: number }> = {
  mg: { dim: "mass", scale: 0.001 },
  g: { dim: "mass", scale: 1 },
  kg: { dim: "mass", scale: 1000 },
  ml: { dim: "volume", scale: 1 },
  l: { dim: "volume", scale: 1000 },
  each: { dim: "count", scale: 1 },
};

/** Convert between units of one dimension; null across dimensions (no guessed density). */
export function convertUnit(value: number, from: AmountUnit, to: AmountUnit): number | null {
  const a = DIMENSION[from];
  const b = DIMENSION[to];
  if (a.dim !== b.dim) return null;
  return (value * a.scale) / b.scale;
}

function clarify(reason: Clarification["reason"], question: string, options: string[] = []): Clarification {
  return { kind: "clarify", reason, question, options };
}

/** The amount in `source`'s reference unit, or a clarification. */
function inReferenceUnit(input: AmountInput, source: FoodSource): number | Clarification {
  const refUnit = source.referenceAmount.unit;
  if (input.measure !== undefined) {
    const measure = source.measures?.find((m) => m.name === input.measure);
    if (!measure) {
      const names = (source.measures ?? []).map((m) => m.name);
      return clarify("unknown_measure", `How much is one ${input.measure} of ${source.food} (${source.state})?`, names);
    }
    return input.value * measure.amount;
  }
  if (input.unit === undefined) {
    return clarify("no_unit", `${input.value} what of ${source.food}? Give a unit or a measure.`);
  }
  const converted = convertUnit(input.value, input.unit, refUnit);
  if (converted === null) {
    return clarify(
      "unit_mismatch",
      `${source.food} (${source.state}) is given per ${refUnit}; how many ${refUnit} is ${input.value} ${input.unit}?`,
    );
  }
  return converted;
}

function resolved(
  source: FoodSource,
  amount: number,
  yieldApplied: Extract<AmountResolution, { kind: "resolved" }>["yieldApplied"],
): AmountResolution {
  return { kind: "resolved", sourceId: source.id, amount, multiples: amount / source.referenceAmount.value, yieldApplied };
}

/**
 * Turn an amount as entered into a number of reference amounts of one food
 * source. When the amount could match sources that differ only by state,
 * it asks rather than guessing; every failure is a clarification, never a
 * throw. A state with no source of its own converts through a yield.
 */
export function resolveAmount(
  input: AmountInput,
  sources: readonly FoodSource[],
  yields: readonly Yield[] = [],
): AmountResolution {
  const candidates = sources.filter((s) => s.food === input.food);
  if (candidates.length === 0) return clarify("unknown_food", `There is no food source for ${input.food}.`);
  const states = [...new Set(candidates.map((s) => s.state))].sort();

  let state = input.state;
  if (state === undefined) {
    const byMeasure =
      input.measure === undefined ? candidates : candidates.filter((s) => s.measures?.some((m) => m.name === input.measure));
    const possible = [...new Set((byMeasure.length > 0 ? byMeasure : candidates).map((s) => s.state))].sort();
    if (possible.length > 1) {
      return clarify("ambiguous_state", `Is that ${input.food} ${possible.join(" or ")}?`, possible);
    }
    state = possible[0] as string;
  }

  const direct = candidates.find((s) => s.state === state);
  if (direct) {
    const amount = inReferenceUnit(input, direct);
    return typeof amount === "number" ? resolved(direct, amount, null) : amount;
  }

  const routes = yields.filter(
    (y) => y.food === input.food && y.fromState === state && candidates.some((s) => s.state === y.toState),
  );
  if (routes.length === 0) {
    return clarify("unknown_state", `There is no ${input.food} ${state}; which state is it?`, states);
  }
  if (routes.length > 1) {
    const targets = routes.map((r) => r.toState).sort();
    return clarify("ambiguous_state", `Log ${input.food} ${state} as ${targets.join(" or ")}?`, targets);
  }
  const route = routes[0] as Yield;
  const target = candidates.find((s) => s.state === route.toState) as FoodSource;
  if (input.measure !== undefined || input.unit === undefined) {
    return clarify("no_unit", `Give ${input.food} ${state} by weight or volume, not a measure.`);
  }
  const before = convertUnit(input.value, input.unit, target.referenceAmount.unit);
  if (before === null) {
    return clarify(
      "unit_mismatch",
      `${target.food} (${target.state}) is given per ${target.referenceAmount.unit}; how many is ${input.value} ${input.unit}?`,
    );
  }
  const discardedFraction = route.discardedFraction ?? 0;
  const amount = before * (1 - discardedFraction) * route.factor;
  return resolved(target, amount, {
    fromState: route.fromState,
    toState: route.toState,
    factor: route.factor,
    discardedFraction,
  });
}
