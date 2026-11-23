// The household rule (Worker decision 135): health data, and every free
// text that can cite it (a target's reasoning, a goal point, a phase's
// intent, a prescription's coach notes, a member note's versions, heart
// rate zones, the old Sheets audit), is its member's alone, through every
// read path: the tools, history and query. Asha reads Hritvik's; the
// owner and the agent still see everything. Invented data only.
import { describe, expect, it } from "vitest";
import { importWrite } from "../src/importing";
import { writeLog } from "./fixtures";
import { setup, type Harness } from "./harness";
import { seedTraining } from "./seed";

const SECRET = "BMR 1650 kcal and fat mass 18 kg from the BIA scan; TSH 3.1";
const DAY = "2026-10-05";

async function hritviksPrivateThings(x: Harness) {
  seedTraining(x);
  const r = await importWrite(x.db, "create_programme", {
    member: "Hritvik", name: "Programme", schedule_kind: "rotation", started_on: "2026-09-01",
    templates: [{ name: "Upper", session_type: "strength", prescriptions: [
      { exercise: "Treadmill walk", target: { kind: "duration", low_s: 1200, high_s: 1500 }, progression_rule: { kind: "manual" }, cue: `Zone 2. ${SECRET}`, fallback_note: `Bike instead. ${SECRET}` },
    ] }],
    slots: [{ rotation_position: 1, template: "Upper" }],
  }, { at: "2026-10-05T07:00:00Z", origin: { file: "hritvik", tab: "Program", row: 1 } });
  expect(r.status).toBe("ok");
  const prescription = (x.t.get("SELECT id FROM prescription") as { id: number }).id;
  const target = (await x.ok("set_target", {
    member: "Hritvik", effective_from: "2026-10-01", provenance: "agent", reasoning: SECRET,
    values: [{ nutrient: "kcal", kind: "target", value: 2100 }, { nutrient: "protein_g", kind: "target", value: 150 }, { nutrient: "fat_g", kind: "target", value: 60 }, { nutrient: "carbs_g", kind: "remainder" }],
  })).target.id as number;
  const goal = (await x.ok("set_goal_point", { member: "Hritvik", metric: "waist_navel", week_of: "2026-10-11", value: 88, unit: "cm", tier: "planned", note: SECRET, reason: "Guide end target" })).goal_point.id as number;
  await x.ok("upsert_phase", { member: "Hritvik", name: "Recomp", starts_on: "2026-09-01", ends_on: null, energy_stance: "deficit", intent: SECRET, change_reason: "start recomp" });
  const phase = (x.t.get("SELECT id FROM phase") as { id: number }).id;
  await x.ok("write_member_note", { member: "Hritvik", topic: "bia", body: SECRET });
  const noteVersion = (x.t.get("SELECT id FROM member_note_version") as { id: number }).id;
  const zone = x.t.insert("hr_zone", { member_id: x.h.hritvik, zone: 2, low_bpm: 115, high_bpm: 135, status: "provisional", set_on: DAY, basis: `Karvonen from a resting HR reading; ${SECRET}` });
  const w = writeLog(x.t, { tool: "test" });
  x.t.insert("record_version", { write_id: w, table_name: "hr_zone", record_id: zone, version: 1, action: "create", data: JSON.stringify(x.t.get("SELECT * FROM hr_zone WHERE id = ?", zone)), created_at: "2026-10-05T07:00:00Z" });
  const a = await importWrite(x.db, "add_legacy_audit_entry", { source_file: "hritvik", member: "Hritvik", logged_on: "2026-09-01", action: "update reading", reason: SECRET, prior_value: "fat mass 19 kg" },
    { at: "2026-10-05T07:00:00Z", origin: { file: "hritvik", tab: "Agent Audit", row: 2 } });
  expect(a.status).toBe("ok");
  const audit = (x.t.get("SELECT id FROM legacy_audit_entry") as { id: number }).id;
  return { prescription, target, goal, phase, noteVersion, zone, audit };
}

const leaks = (body: unknown) => JSON.stringify(body).includes("BMR 1650") || JSON.stringify(body).includes("fat mass");

describe("Asha can't read Hritvik's health-derived text", () => {
  it("next_prescription gives another member's prescription without its coach notes; the owner and the agent get them", async () => {
    const x = setup();
    await hritviksPrivateThings(x);
    const hers = await x.ok("next_prescription", { member: "Hritvik", date: DAY }, "asha");
    expect(hers.prescriptions[0]).toMatchObject({ exercise: "Treadmill walk", cue: null, fallback_note: null });
    expect(leaks(hers)).toBe(false);
    for (const as of ["hritvik", "agent"] as const) {
      const p = (await x.ok("next_prescription", { member: "Hritvik", date: DAY }, as)).prescriptions[0];
      expect(p.cue).toContain(SECRET);
      expect(p.fallback_note).toContain(SECRET);
    }
  });

  it("programme leaves out another member's coach notes and phase intent; the owner gets them", async () => {
    const x = setup();
    await hritviksPrivateThings(x);
    const hers = await x.ok("programme", { member: "Hritvik", date: DAY }, "asha");
    expect(hers.templates[0].prescriptions[0]).toMatchObject({ cue: null, fallback_note: null });
    // Phases are the member's own altogether (decision 137).
    expect(hers.phases).toEqual([]);
    expect(hers.current_phase).toBeNull();
    expect(leaks(hers)).toBe(false);
    const his = await x.ok("programme", { member: "Hritvik", date: DAY }, "hritvik");
    expect(his.templates[0].prescriptions[0].cue).toContain(SECRET);
    expect(his.phases[0].intent).toBe(SECRET);
    expect(his.current_phase.intent).toBe(SECRET);
  });

  it("targets gives another member the numbers, never the reasoning; the owner gets it", async () => {
    const x = setup();
    await hritviksPrivateThings(x);
    const hers = await x.ok("targets", { member: "Hritvik", date: DAY }, "asha");
    expect(hers.target.values.find((v: { nutrient: string }) => v.nutrient === "kcal")).toMatchObject({ value: 2100 });
    expect(hers.target).not.toHaveProperty("reasoning");
    expect(leaks(hers)).toBe(false);
    expect((await x.ok("targets", { member: "Hritvik", date: DAY }, "hritvik")).target.reasoning).toBe(SECRET);
    expect((await x.ok("targets", { member: "Hritvik", date: DAY })).target.reasoning).toBe(SECRET);
  });

  it("history of every owner-only record is not_visible to another member and readable by its owner", async () => {
    const x = setup();
    const ids = await hritviksPrivateThings(x);
    const refs = [
      ["target", ids.target], ["goal_point", ids.goal], ["phase", ids.phase], ["prescription", ids.prescription],
      ["member_note_version", ids.noteVersion], ["hr_zone", ids.zone], ["legacy_audit_entry", ids.audit],
    ] as const;
    for (const [table, id] of refs) {
      const hers = await x.call("history", { table, id }, "asha");
      expect([table, hers.http, hers.body.error?.code]).toEqual([table, 403, "not_visible"]);
      expect(leaks(hers.body)).toBe(false);
      const his = await x.call("history", { table, id }, "hritvik");
      expect([table, his.http]).toEqual([table, 200]);
    }
  });

  it("amend of another member's target or goal point is refused before it shows the record", async () => {
    const x = setup();
    const ids = await hritviksPrivateThings(x);
    for (const [table, id, changes] of [["target", ids.target, { provenance: "member" }], ["goal_point", ids.goal, { tier: "stretch" }]] as const) {
      const r = await x.call("amend", { record: { table, id }, changes, reason: "invented" }, "asha");
      expect([table, r.http, r.body.error?.code]).toEqual([table, 403, "not_visible"]);
      expect(leaks(r.body)).toBe(false);
    }
  });

  it("query refuses v_target, v_goal_point, v_prescription, v_phase and v_hr_zone to members; the agent reads them", async () => {
    const x = setup();
    await hritviksPrivateThings(x);
    for (const view of ["v_target", "v_goal_point", "v_prescription", "v_phase", "v_hr_zone"]) {
      const r = await x.call("query", { sql: `SELECT * FROM ${view}` }, "asha");
      expect([view, r.http, r.body.error?.code]).toEqual([view, 403, "not_visible"]);
      // Hidden inside a CTE or a join too.
      expect((await x.call("query", { sql: `WITH a AS (SELECT * FROM ${view}) SELECT * FROM v_food_source JOIN a ON 1 = 1` }, "asha")).http).toBe(403);
      expect(leaks((await x.ok("query", { sql: `SELECT * FROM ${view}` })).rows)).toBe(true);
    }
  });

  it("another member's numeric target still reaches the household views that show kcal and protein left", async () => {
    const x = setup();
    await hritviksPrivateThings(x);
    const day = await x.ok("day_totals", { member: "Hritvik", date: DAY }, "asha");
    expect(day.target).toMatchObject({ kcal: 2100 });
    expect(leaks(day)).toBe(false);
  });
});

describe("the rest of a programme's coach text, and who may change it (decision 138)", () => {
  async function ruled(x: Harness) {
    seedTraining(x);
    const r = await importWrite(x.db, "create_programme", {
      member: "Hritvik", name: "Programme", schedule_kind: "rotation", started_on: "2026-09-01",
      templates: [{ name: "Upper", session_type: "strength", prescriptions: [
        { exercise: "Treadmill walk", target: { kind: "duration", low_s: 1200, high_s: 1500 }, progression_rule: { kind: "manual", cue: `Rule. ${SECRET}` } },
      ] }],
      slots: [{ rotation_position: 1, template: "Upper" }],
    }, { at: "2026-10-05T07:00:00Z", origin: { file: "hritvik", tab: "Program", row: 1 } });
    expect(r.status).toBe("ok");
    return (x.t.get("SELECT id FROM prescription") as { id: number }).id;
  }

  it("a progression rule's cue is the owner's: next_prescription and programme leave it out for another member", async () => {
    const x = setup();
    await ruled(x);
    const next = await x.ok("next_prescription", { member: "Hritvik", date: DAY }, "asha");
    expect(next.prescriptions[0].progression_rule).toEqual({ kind: "manual" });
    const prog = await x.ok("programme", { member: "Hritvik", date: DAY }, "asha");
    expect(prog.templates[0].prescriptions[0].progression_rule).toEqual({ kind: "manual" });
    expect(leaks(next) || leaks(prog)).toBe(false);
    expect((await x.ok("next_prescription", { member: "Hritvik", date: DAY }, "hritvik")).prescriptions[0].progression_rule.cue).toContain(SECRET);
    expect((await x.ok("programme", { member: "Hritvik", date: DAY }, "hritvik")).templates[0].prescriptions[0].progression_rule.cue).toContain(SECRET);
  });

  it("another member can't change someone's programme or target; the owner and the agent can", async () => {
    const x = setup();
    const p = await ruled(x);
    const change = { kind: "load_change", prescription_id: p, date: DAY, load: { value: 5, unit: "kg", basis: "total" }, reason: "invented" };
    const refusedProgramme = await x.call("programme_change", { member: "Hritvik", change }, "asha");
    expect([refusedProgramme.http, refusedProgramme.body.error?.code]).toEqual([403, "not_visible"]);
    const phase = { member: "Hritvik", name: "Cut", starts_on: "2026-10-01", ends_on: null, energy_stance: "deficit", intent: "invented", change_reason: "invented" };
    const refusedPhase = await x.call("upsert_phase", phase, "asha");
    expect([refusedPhase.http, refusedPhase.body.error?.code]).toEqual([403, "not_visible"]);
    const t = await x.call("set_target", { member: "Hritvik", effective_from: "2026-10-01", provenance: "member", reasoning: "invented", values: [{ nutrient: "kcal", kind: "target", value: 1000 }] }, "asha");
    expect([t.http, t.body.error?.code]).toEqual([403, "not_visible"]);
    expect((await x.call("upsert_phase", phase, "hritvik")).http).toBe(200);
    expect((await x.call("set_target", { member: "Hritvik", effective_from: "2026-10-02", provenance: "member", reasoning: "invented", values: [{ nutrient: "kcal", kind: "target", value: 2000 }] }, "hritvik")).http).toBe(200);
    expect((await x.call("set_target", { member: "Asha", effective_from: "2026-10-02", provenance: "agent", reasoning: "invented", values: [{ nutrient: "kcal", kind: "target", value: 1800 }] })).http).toBe(200);
  });
});
