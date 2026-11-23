import { describe, expect, it } from "vitest";
import { buildToday } from "../src/today";
import { buildHistory } from "../src/train";
import { stressHousehold } from "./fixtures";

describe("the stress household (wide-layout spec §7)", () => {
  const s = stressHousehold();

  it("has an 11-item dinner with one item of unknown kcal and protein", () => {
    const dinner = buildToday(s.today).tiers.find((t) => t.slot === "dinner");
    expect(dinner?.items).toHaveLength(11);
    const raw = s.today.meals.slots.find((sl) => sl.slot === "dinner")?.items ?? [];
    expect(raw.filter((i) => i.kcal === null && i.protein === null).map((i) => i.name)).toEqual(["Tofu"]);
  });

  it("gives Kabir no target and nothing logged", () => {
    expect(s.kabir.totals.left).toBeNull();
    expect(buildToday(s.kabir).tiers.every((t) => t.items.length === 0)).toBe(true);
  });

  it("lists 23 sessions, newest first", () => {
    expect(buildHistory(s.sessions)).toHaveLength(23);
    expect(s.sessions.sessions[0]!.date > s.sessions.sessions[22]!.date).toBe(true);
  });
});
