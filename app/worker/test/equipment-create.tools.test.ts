// Creating a gym and a piece of equipment through the API: the inventory is
// facts, so a member can state a ladder once ("5 to 100 lb in 5s") or a mixed
// rack (pounds plus a few kilograms) and the loads are recorded as stated.
import { describe, expect, it } from "vitest";
import { setup } from "./harness";
import { seedTraining } from "./seed";

describe("create_gym", () => {
  it("adds a gym and makes it the named members' home gym", async () => {
    const x = setup();
    const body = await x.ok("create_gym", { name: "New gym", home_of: ["Hritvik"] });
    expect(body.gym).toMatchObject({ name: "New gym", home_of: ["Hritvik"] });
    expect(x.t.get("SELECT home_gym_id FROM member WHERE name = 'Hritvik'")).toEqual({ home_gym_id: body.gym.id });
  });

  it("asks before creating a second gym of the same name", async () => {
    const x = setup();
    await x.ok("create_gym", { name: "New gym" });
    const asked = await x.call("create_gym", { name: "New gym" });
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "duplicate_gym" });
  });
});

describe("create_implement", () => {
  it("creates a mixed rack from a stated ladder plus the kilogram dumbbells", async () => {
    const x = setup();
    const s = seedTraining(x);
    const body = await x.ok("create_implement", {
      gym: s.gym,
      name: "Commercial dumbbells",
      kind: "dumbbell",
      unit: "lb",
      loading: "total",
      ranges: [{ from: 5, to: 100, step: 5, unit: "lb" }],
      loads: [{ value: 7.5, unit: "kg" }, { value: 10, unit: "kg" }, { value: 12.5, unit: "kg" }],
    });
    const loads = body.implement.loads as { value: number; unit: string }[];
    expect(loads).toHaveLength(23);
    expect(loads).toContainEqual({ value: 100, unit: "lb" });
    expect(loads).toContainEqual({ value: 12.5, unit: "kg" });
    expect(body.implement).toMatchObject({ gym: "Cult Koramangala", load_list_complete: true });
    const inv = await x.ok("inventory", { gym: s.gym });
    expect(inv.implements.find((i: { name: string }) => i.name === "Commercial dumbbells").loads).toHaveLength(23);
  });

  it("asks before creating a second implement of the same name at a gym", async () => {
    const x = setup();
    const s = seedTraining(x);
    await x.ok("create_implement", { gym: s.gym, name: "Rack", kind: "dumbbell", unit: "kg", loading: "total", loads: [5] });
    const asked = await x.call("create_implement", { gym: s.gym, name: "Rack", kind: "dumbbell", unit: "kg", loading: "total", loads: [10] });
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "duplicate_implement" });
  });

  it("asks which loads a non-plate-loaded implement produces", async () => {
    const x = setup();
    const s = seedTraining(x);
    const asked = await x.call("create_implement", { gym: s.gym, name: "Mystery stack", kind: "machine", unit: "kg", loading: "total" });
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "loads_needed" });
  });

  it("allows a plate-loaded implement with no listed loads", async () => {
    const x = setup();
    const s = seedTraining(x);
    const body = await x.ok("create_implement", {
      gym: s.gym, name: "Leg press", kind: "plate_loaded", unit: "kg", loading: "plates_only",
    });
    expect(body.implement).toMatchObject({ name: "Leg press", loads: [] });
  });

  it("checks a stated ladder before writing", async () => {
    const x = setup();
    const s = seedTraining(x);
    const backwards = await x.call("create_implement", {
      gym: s.gym, name: "Backwards", kind: "machine", unit: "kg", loading: "total",
      ranges: [{ from: 40, to: 20, step: 5, unit: "kg" }],
    });
    expect(backwards.body).toMatchObject({ status: "needs_clarification", reason: "range_backwards" });
    const huge = await x.call("create_implement", {
      gym: s.gym, name: "Huge", kind: "machine", unit: "kg", loading: "total",
      ranges: [{ from: 1, to: 999, step: 1, unit: "kg" }],
    });
    expect(huge.body).toMatchObject({ status: "needs_clarification", reason: "range_too_large" });
    expect(x.t.all("SELECT name FROM implement WHERE name IN ('Backwards', 'Huge')")).toEqual([]);
  });
});
