// Import-only tools: the household, members, gyms, exercises, programmes,
// goal points and legacy audit rows, which have no API path yet.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { importWrite } from "../src/importing";
import { setup } from "./harness";
import { SqliteDb } from "./sqlite";

const AT = "2026-10-05T19:07:21Z";
let row = 0;
const meta = () => ({ at: AT, origin: { file: "base", tab: "People", row: ++row } });

async function ok(db: SqliteDb, tool: string, input: Record<string, unknown>) {
  const r = await importWrite(db, tool, input, meta());
  if (r.status !== "ok") throw new Error(`${tool}: ${JSON.stringify(r)}`);
  return r;
}

describe("create_household and create_member", () => {
  it("creates the household once and its members with their programming mode", async () => {
    const db = new SqliteDb();
    expect(db.raw).toBeInstanceOf(DatabaseSync);
    await ok(db, "create_household", { name: "Household" });
    expect((await importWrite(db, "create_household", { name: "Again" }, meta())).status).toBe("error");
    await ok(db, "create_member", { name: "Ana", email: "ana@example.com", programming_mode: "prescribed", sex: "female", week_anchor_date: "2026-07-26" });
    await ok(db, "create_member", { name: "Ben", email: "ben@example.com", programming_mode: "record_only" });
    expect(db.test.all("SELECT name, programming_mode, sex, week_anchor_date FROM member ORDER BY id")).toEqual([
      { name: "Ana", programming_mode: "prescribed", sex: "female", week_anchor_date: "2026-07-26" },
      { name: "Ben", programming_mode: "record_only", sex: null, week_anchor_date: null },
    ]);
    const dup = await importWrite(db, "create_member", { name: "ana", email: "x@example.com", programming_mode: "prescribed" }, meta());
    expect(dup).toMatchObject({ status: "needs_clarification", reason: "duplicate_member" });
  });
});

describe("create_gym", () => {
  it("creates a gym and makes it the home gym of the members named", async () => {
    const x = setup();
    const r = await ok(x.db, "create_gym", { name: "Hritvik's gym", home_of: ["Hritvik"] });
    const gym = (r.gym as { id: number }).id;
    expect(x.t.get("SELECT home_gym_id FROM member WHERE id = ?", x.h.hritvik)).toEqual({ home_gym_id: gym });
  });
});

describe("create_exercise", () => {
  it("creates an exercise with aliases and refuses a name already taken", async () => {
    const x = setup();
    await ok(x.db, "create_exercise", { name: "Lat Pulldown", implement_kind: "cable", aliases: ["lat pulldown (wide grip)"] });
    expect(x.t.all("SELECT alias FROM alias WHERE kind = 'exercise'")).toEqual([{ alias: "lat pulldown (wide grip)" }]);
    const dup = await importWrite(x.db, "create_exercise", { name: "LAT PULLDOWN (WIDE GRIP)", implement_kind: "cable" }, meta());
    expect(dup).toMatchObject({ status: "needs_clarification", reason: "duplicate_exercise" });
  });
});

describe("create_programme", () => {
  it("creates templates, ordered prescriptions and schedule slots", async () => {
    const x = setup();
    await ok(x.db, "create_exercise", { name: "Bench Press", implement_kind: "barbell" });
    await ok(x.db, "create_exercise", { name: "Leg Press", implement_kind: "plate_loaded" });
    const r = await ok(x.db, "create_programme", {
      member: "Hritvik", name: "Programme", schedule_kind: "rotation", started_on: "2026-07-27",
      templates: [
        { name: "Upper A", session_type: "strength", prescriptions: [
          { exercise: "Bench Press", sets: 4, rep_low: 6, rep_high: 8, rir_target_low: 2, rir_target_high: 2, rest_s: 150,
            load: { value: 35.9, unit: "kg", basis: "total" }, progression_rule: { kind: "rep_top", target_sets: 4, rep_top: 8, rir_floor: 2 }, cue: "Arch" },
        ] },
        { name: "Lower A", session_type: "strength", prescriptions: [
          { exercise: "Leg Press", sets: 3, rep_low: 10, rep_high: 12, rir_target_low: 2, rir_target_high: 2 },
        ] },
      ],
      slots: [{ rotation_position: 1, template: "Upper A" }, { rotation_position: 2, template: "Lower A" }],
    });
    expect(r.programme).toMatchObject({ templates: 2, prescriptions: 2 });
    expect(x.t.all("SELECT t.name, p.position, p.load_value, json_extract(p.progression_rule, '$.rep_top') AS top FROM prescription p JOIN session_template t ON t.id = p.template_id ORDER BY p.id")).toEqual([
      { name: "Upper A", position: 1, load_value: 35.9, top: 8 },
      { name: "Lower A", position: 1, load_value: null, top: null },
    ]);
    expect(x.t.all("SELECT rotation_position FROM schedule_slot ORDER BY rotation_position")).toHaveLength(2);
  });

  it("refuses prescriptions for a record-only member and an unknown exercise", async () => {
    const x = setup();
    const base = { name: "P", schedule_kind: "rotation", started_on: "2026-07-27", slots: [{ rotation_position: 1, template: "A" }] };
    const recordOnly = await importWrite(x.db, "create_programme", { ...base, member: "Asha", templates: [{ name: "A", session_type: "strength", prescriptions: [] }] }, meta());
    expect(recordOnly).toMatchObject({ status: "needs_clarification", reason: "record_only_member" });
    const unknown = await importWrite(x.db, "create_programme", {
      ...base, member: "Hritvik",
      templates: [{ name: "A", session_type: "strength", prescriptions: [{ exercise: "Nope", sets: 1, rep_low: 1, rep_high: 2, rir_target_low: 1, rir_target_high: 1 }] }],
    }, meta());
    expect(unknown).toMatchObject({ status: "needs_clarification", reason: "unknown_exercise" });
  });
});

describe("create_goal_point", () => {
  it("creates a dated goal on a metric or an exercise", async () => {
    const x = setup();
    await ok(x.db, "create_exercise", { name: "Bench Press", implement_kind: "barbell" });
    await ok(x.db, "create_goal_point", { member: "Hritvik", metric: "waist_navel", week_of: "2026-08-02", tier: "planned", basis: "absolute", value_low: 94.8, value_high: 94.8, unit: "cm" });
    await ok(x.db, "create_goal_point", { member: "Hritvik", exercise: "Bench Press", week_of: "2027-06-01", tier: "planned", basis: "absolute", value_low: 65, value_high: 65, unit: "kg" });
    expect(x.t.all("SELECT metric, exercise_id IS NOT NULL AS ex FROM goal_point ORDER BY id")).toEqual([{ metric: "waist_navel", ex: 0 }, { metric: null, ex: 1 }]);
  });
});

describe("add_legacy_audit_entry", () => {
  it("keeps an old Agent Audit row as history, with time not recorded when blank", async () => {
    const x = setup();
    await ok(x.db, "add_legacy_audit_entry", { source_file: "hritvik", member: "Hritvik", logged_on: "2026-07-30", agent: "Codex", action: "Log meals", target: "Nutrition!A2", reason: "r", prior_value: "p", result: "done" });
    expect(x.t.get("SELECT source_file, member_id, logged_time, action FROM legacy_audit_entry")).toEqual({ source_file: "hritvik", member_id: x.h.hritvik, logged_time: null, action: "Log meals" });
  });
});
