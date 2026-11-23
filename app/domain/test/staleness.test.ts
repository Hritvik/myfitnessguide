import { describe, expect, it } from "vitest";
import { stalenessTop } from "../src/index";
import type { StalenessItem } from "../src/index";

// Ported from shared/test_gymcalc.py TestStalenessTop2 (R5): at most two
// nudges, never-performed items outrank stale ones.
describe("stalenessTop (gymcalc staleness_top2 port)", () => {
  const TODAY = "2026-09-17";

  const registry = (): StalenessItem[] => [
    { name: "waist", last: "2026-07-26", everyDays: 7, message: "Waist last measured 26 Jul - one reading ever." },
    { name: "hr", last: null, everyDays: 7, message: "Still zero HR data - wear the watch." },
    { name: "dead_hang", last: null, everyDays: 7, message: "Dead Hang has never been performed." },
    { name: "weight", last: "2026-09-16", everyDays: 2, message: "Log a fasted weight." },
  ];

  it("returns at most two", () => {
    expect(stalenessTop(registry(), TODAY)).toHaveLength(2);
  });

  it("never performed outranks merely stale", () => {
    const got = stalenessTop(registry(), TODAY);
    expect(got).toContain("Still zero HR data - wear the watch.");
    expect(got).toContain("Dead Hang has never been performed.");
  });

  it("recent items are never returned", () => {
    const items: StalenessItem[] = [
      { name: "weight", last: "2026-09-16", everyDays: 2, message: "Log a fasted weight." },
    ];
    expect(stalenessTop(items, TODAY)).toEqual([]);
  });

  it("a stale item is returned when nothing is never-done", () => {
    const items: StalenessItem[] = [
      { name: "waist", last: "2026-07-26", everyDays: 7, message: "Waist is overdue." },
      { name: "weight", last: "2026-09-16", everyDays: 2, message: "Log a fasted weight." },
    ];
    expect(stalenessTop(items, TODAY)).toEqual(["Waist is overdue."]);
  });

  it("an empty registry gives nothing", () => {
    expect(stalenessTop([], TODAY)).toEqual([]);
  });

  it("the cap is a parameter", () => {
    expect(stalenessTop(registry(), TODAY, 3)).toEqual([
      "Still zero HR data - wear the watch.",
      "Dead Hang has never been performed.",
      "Waist last measured 26 Jul - one reading ever.",
    ]);
  });
});
