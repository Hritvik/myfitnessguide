/**
 * Shared generators and helpers for the plan builders' property tests
 * (ticket 67, part 2). Every value here is invented: no household data.
 *
 * fast-check runs each property with a fresh random seed and prints the
 * seed and the shrunk counterexample when one fails; replay it with
 * `fc.assert(prop, { seed, path })`.
 */
import fc from "fast-check";
import type { Plan, Step } from "../../src/writes";

/** Digits with at most one decimal point: what a member means by a number, and what every form sends back as typed. */
export const PLAIN_DECIMAL = /^(\d+(\.\d*)?|\.\d+)$/;

/** A positive amount as a number, three decimals at most, from `min` to `max`. */
export const amount = (min = 0.001, max = 100_000): fc.Arbitrary<number> =>
  fc.integer({ min: Math.round(min * 1000), max: Math.round(max * 1000) }).map((k) => k / 1000);

/** A whole number from `min` to `max`. */
export const whole = (min: number, max: number): fc.Arbitrary<number> => fc.integer({ min, max });

/** The ways a member types a number: as is, with trailing zeros, a leading zero or stray spaces around it. */
export const typed = (v: fc.Arbitrary<number>): fc.Arbitrary<{ value: number; text: string }> =>
  fc
    .tuple(v, fc.constantFrom("plain", "fixed3", "leading0"), fc.constantFrom("", " ", "  ", "\t"), fc.constantFrom("", " ", "\n"))
    .map(([value, how, before, after]) => {
      const body = how === "fixed3" ? value.toFixed(3) : how === "leading0" && value >= 1 ? `0${String(value)}` : String(value);
      return { value, text: `${before}${body}${after}` };
    });

/** Awkward text a form must refuse or take as typed: empty, signs, commas, units, emoji, 5,000 characters, and anything at all. */
export const AWKWARD = [
  "", " ", "   ", "\t\n", "0", "0.0", "-0", "-1", "-12.5", "2,5", "1,000", "120g", "120 g", "2 eggs", "1/2", "½", "abc",
  "💪", "🍚🍚", "12💪", "NaN", "Infinity", "-Infinity", "null", "undefined", "١٢", "１２", "12..5", "1.2.3", ".", "−5",
  "9".repeat(400), "x".repeat(5000), "1".repeat(5000), " 4 2 ",
] as const;

export const anyText: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...AWKWARD),
  fc.string({ unit: "grapheme", maxLength: 40 }),
  fc.string({ unit: "binary", maxLength: 40 }),
);

/** Text for a free-text field: any graphemes (emoji included), whitespace, or up to 5,000 characters. */
export const freeText: fc.Arbitrary<string> = fc.oneof(
  fc.string({ unit: "grapheme", maxLength: 80 }),
  fc.constantFrom("", " ", "\t\n ", "💪🏽 legs day 🦵", "x".repeat(5000), ` ${"दाल ".repeat(1200)} `),
);

/** Notations JavaScript's Number reads as 50 (or Infinity): what a member never means by an amount, so every form refuses them (typed.ts, ticket 67 B1). */
export const NOT_DECIMAL = ["0x32", "5e1", "+50", "0b110010", "0o62", "1e400"] as const;

export const isPlan = (r: unknown): r is Plan => typeof r === "object" && r !== null && "steps" in r;
export const isError = (r: unknown): r is { error: string } => typeof r === "object" && r !== null && "error" in r && typeof (r as { error: unknown }).error === "string";

/** The one step of a one-step plan; fails the property when the plan has more. */
export function onlyStep(p: Plan): Step {
  if (p.steps.length !== 1) throw new Error(`expected one step, got ${p.steps.length}`);
  return p.steps[0] as Step;
}

/** Every number anywhere in a step's input, so a property can say none of them is 100× what was typed. */
export function numbersIn(x: unknown): number[] {
  if (typeof x === "number") return [x];
  if (Array.isArray(x)) return x.flatMap(numbersIn);
  if (typeof x === "object" && x !== null) return Object.values(x).flatMap(numbersIn);
  return [];
}

/** A refusal is an error with words in it, never a plan, never a throw. */
export function expectRefused(r: unknown): void {
  if (!isError(r) || r.error.trim() === "" || isPlan(r)) throw new Error(`expected a refusal, got ${JSON.stringify(r)?.slice(0, 200)}`);
}
