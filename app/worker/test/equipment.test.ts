import { describe, expect, it } from "vitest";
import { TestDb } from "./db";
import { alias, exercise, gym, household, implement } from "./fixtures";

describe("gyms and implements", () => {
  it("an implement lists the exact loads it can produce, in its own unit", () => {
    const t = new TestDb();
    const h = household(t);
    const g = gym(t, h);
    const legCurl = implement(t, g, { name: "Leg curl stack", kind: "machine", unit: "lb", loading: "total" });
    for (const load of [10, 17.5, 25, 32.5, 45]) t.insert("implement_load", { implement_id: legCurl, load, unit: "lb" });
    expect(t.all("SELECT load FROM implement_load WHERE implement_id = ? ORDER BY load", legCurl).map((r) => r.load))
      .toEqual([10, 17.5, 25, 32.5, 45]);
  });

  it("refuses the same load twice on one implement", () => {
    const t = new TestDb();
    const h = household(t);
    const i = implement(t, gym(t, h));
    t.insert("implement_load", { implement_id: i, load: 20, unit: "kg" });
    expect(() => t.insert("implement_load", { implement_id: i, load: 20, unit: "kg" })).toThrow(/UNIQUE/);
  });

  it("stores assisted loads as negative numbers", () => {
    const t = new TestDb();
    const h = household(t);
    const assist = implement(t, gym(t, h), { name: "Assisted pull-up", kind: "machine", loading: "total" });
    expect(t.insert("implement_load", { implement_id: assist, load: -25, unit: "kg" })).toBeGreaterThan(0);
  });

  it("rejects an unknown unit, kind or loading", () => {
    const t = new TestDb();
    const h = household(t);
    const g = gym(t, h);
    expect(() => implement(t, g, { unit: "stone" })).toThrow(/CHECK/);
    expect(() => implement(t, g, { kind: "gadget" })).toThrow(/CHECK/);
    expect(() => implement(t, g, { loading: "per_hand" })).toThrow(/CHECK/);
  });

  it("marks a fixed bar whose maximum is unknown", () => {
    const t = new TestDb();
    const h = household(t);
    const bars = implement(t, gym(t, h), { name: "Fixed bars", kind: "fixed_bar", loading: "total", load_list_complete: 0 });
    expect(t.get("SELECT load_list_complete FROM implement WHERE id = ?", bars)).toEqual({ load_list_complete: 0 });
  });

  it("gives each member a home gym", () => {
    const t = new TestDb();
    const h = household(t);
    const g = gym(t, h);
    t.run("UPDATE member SET home_gym_id = ? WHERE id = ?", g, h.hritvik);
    expect(() => t.run("UPDATE member SET home_gym_id = 999 WHERE id = ?", h.hritvik)).toThrow(/FOREIGN KEY/);
  });
});

describe("exercises", () => {
  it("are canonical movements with aliases and movement-pattern and stimulus tags", () => {
    const t = new TestDb();
    const h = household(t);
    const e = exercise(t, h, { name: "Cable lat pulldown", implement_kind: "cable" });
    alias(t, h, "exercise", e, "Lat Pulldown");
    t.insert("exercise_tag", { exercise_id: e, kind: "movement_pattern", tag: "vertical_pull" });
    t.insert("exercise_tag", { exercise_id: e, kind: "stimulus", tag: "lats" });
    expect(t.get("SELECT e.name FROM alias a JOIN exercise e ON e.id = a.target_id WHERE a.kind = 'exercise' AND a.alias = 'lat pulldown'"))
      .toEqual({ name: "Cable lat pulldown" });
  });

  it("refuses an alias already used, in any case", () => {
    const t = new TestDb();
    const h = household(t);
    const a = exercise(t, h, { name: "Cable lat pulldown" });
    const b = exercise(t, h, { name: "Machine lat pulldown", implement_kind: "machine" });
    alias(t, h, "exercise", a, "Lat Pulldown");
    expect(() => alias(t, h, "exercise", b, "lat pulldown")).toThrow(/UNIQUE/);
  });

  it("rejects an unknown tag kind or a badly formed tag", () => {
    const t = new TestDb();
    const h = household(t);
    const e = exercise(t, h);
    expect(() => t.insert("exercise_tag", { exercise_id: e, kind: "mood", tag: "lats" })).toThrow(/CHECK/);
    expect(() => t.insert("exercise_tag", { exercise_id: e, kind: "stimulus", tag: "Upper Back!" })).toThrow(/CHECK/);
  });
});
