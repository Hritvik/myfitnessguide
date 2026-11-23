/**
 * Varied free text for every plan builder that sends words (ticket 67,
 * part 2): whitespace, emoji, scripts, control characters and 5,000
 * characters never crash a builder, and are either sent verbatim (trimmed)
 * or refused as blank or too long.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addMeasurePlan, amendPlan, forgetWordPlan, removeLinePlan, teachWordPlan } from "../../src/catalogue";
import { feedbackPlan } from "../../src/feedback";
import { MAX_TEXT, sendInput } from "../../src/freetext";
import { cardioPlan } from "../../src/setEntry";
import { rejectDraftPlan } from "../../src/waiting";
import { saveAsWorkoutPlan } from "../../src/workout";
import { resolveFlagPlan } from "../../src/writes";
import { freeText, isError, onlyStep } from "./arbitraries";

/** Each builder with its words field, and where the words land in the one step it sends. */
const WORDS: { form: string; build: (t: string) => unknown; sent: (input: Record<string, unknown>) => unknown }[] = [
  { form: "feedback", build: (t) => feedbackPlan("idea", t, { route: "/today" }), sent: (i) => i.text },
  { form: "resolve a flag", build: (t) => resolveFlagPlan(4, t), sent: (i) => i.resolution },
  { form: "not mine: reason", build: (t) => rejectDraftPlan({ table: "intake_item", id: 3 }, t), sent: (i) => i.reason },
  { form: "Catalogue reason", build: (t) => amendPlan({ table: "food_source", id: 1 }, { kcal: 350 }, t, "Saved."), sent: (i) => i.reason },
  { form: "remove a line: reason", build: (t) => removeLinePlan("R900", 2, "Test rice", t), sent: (i) => i.reason },
  { form: "forget a word: reason", build: (t) => forgetWordPlan(5, "chawal", t), sent: (i) => i.reason },
  { form: "teach a word", build: (t) => teachWordPlan("food_source", "FS900", { word: t }, "Household word", false), sent: (i) => i.alias },
  { form: "measure name", build: (t) => addMeasurePlan("FS900", { name: t, amount: "60" }, "Weighed"), sent: (i) => i.name },
  { form: "save as workout", build: (t) => saveAsWorkoutPlan(11, t), sent: (i) => i.name },
];

describe.each(WORDS)("$form", ({ build, sent }) => {
  it("sends the words trimmed and otherwise verbatim, or refuses blank; never throws", () => {
    fc.assert(
      fc.property(freeText, (text) => {
        const r = build(text);
        if (isError(r)) {
          expect(text.trim()).toBe("");
          return;
        }
        expect(sent(onlyStep(r as never).input)).toBe(text.trim());
      }),
    );
  });
});

describe("Tell Claude: the inbox text", () => {
  it("sends the trimmed text with one span over all of it, or refuses blank or over the Worker's cap", () => {
    fc.assert(
      fc.property(fc.oneof(freeText, fc.integer({ min: MAX_TEXT - 2, max: MAX_TEXT + 2 }).map((n) => "é".repeat(n)), fc.constant(`  ${"🍚".repeat(2500)}  `)), (raw) => {
        const r = sendInput("Asha", "2026-10-08", "lunch", raw);
        const text = raw.trim();
        if (isError(r)) {
          expect(text === "" || text.length > MAX_TEXT).toBe(true);
          return;
        }
        expect(r.input.text).toBe(text);
        expect(r.input.spans).toEqual([{ text, start: 0, end: text.length }]);
        expect(text.length).toBeLessThanOrEqual(MAX_TEXT);
      }),
    );
  });
});

describe("a cardio activity", () => {
  it("goes in trimmed, or not at all when blank; never blocks the minutes", () => {
    fc.assert(
      fc.property(freeText, (activity) => {
        const r = cardioPlan("Asha", "2026-10-08", { activity, minutes: "20", km: "", avgHr: "" });
        if (isError(r)) throw new Error(r.error);
        const block = (onlyStep(r).input.blocks as Record<string, unknown>[])[0] as Record<string, unknown>;
        if (activity.trim() === "") expect(block).not.toHaveProperty("activity");
        else expect(block.activity).toBe(activity.trim());
      }),
    );
  });
});
