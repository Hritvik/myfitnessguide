import { describe, expect, it } from "vitest";
import { toolWithinBudget } from "./budget";
import { setup } from "./harness";
import { seedTraining } from "./seed";
import { programmeRevisionConflict } from "../src/app";

const setupToday = () => setup({ now: "2026-10-20T07:30:00Z" });

const initial = {
  member: "Hritvik",
  name: "Everyday strength",
  schedule_kind: "rotation" as const,
  started_on: "2026-10-05",
  change_reason: "starting the plan",
  templates: [{
    name: "Full body A",
    session_type: "strength" as const,
    prescriptions: [{
      exercise: "bench",
      sets: 3,
      rep_low: 6,
      rep_high: 8,
      rir_target_low: 1,
      rir_target_high: 2,
      load: { value: 20, unit: "lb" as const, basis: "per_side" as const, implement: "Olympic bar and plates" },
      progression_rule: { kind: "rep_top" as const, target_sets: 3, rep_top: 8, rir_floor: "from_prescription" as const },
      cue: "Pause on the chest",
      fallback_note: "Use dumbbells when needed",
    }],
  }],
  slots: [{ rotation_position: 1, template: "Full body A" }],
};

describe("public update_programme", () => {
  it("enforces same-member revision lineage in the database", () => {
    const x = setupToday();
    const predecessor = x.t.insert("programme", {
      member_id: x.h.hritvik, name: "Original", schedule_kind: "rotation", active: 0, started_on: "2026-10-01", ended_on: "2026-10-20",
    });
    expect(() => x.t.insert("programme", {
      member_id: x.h.asha, name: "Cross-member successor", schedule_kind: "rotation", active: 1, started_on: "2026-10-20", supersedes_programme_id: predecessor,
    })).toThrow(/programme_revision_other_member/);
  });

  it("creates a successor for a metadata-only revision while preserving history and cloning current prescription details", async () => {
    const x = setupToday();
    const seeded = seedTraining(x);
    const predecessor = (await x.ok("create_programme", initial, "hritvik")).programme;
    const oldPrescription = predecessor.templates[0].prescriptions[0].id;
    x.t.insert("prescription_fallback", { prescription_id: oldPrescription, exercise_id: seeded.dbBench, rank: 1, note: "same pattern" });
    await x.ok("programme_change", {
      member: "Hritvik",
      change: { kind: "load_change", prescription_id: oldPrescription, date: "2026-10-12", load: { value: 25, unit: "lb", basis: "per_side" }, reason: "completed the rep range" },
    }, "hritvik");

    const body = await x.ok("update_programme", {
      member: "Hritvik",
      programme_id: predecessor.id,
      effective_on: "2026-10-20",
      change_reason: "renamed after reviewing the plan",
      name: "Sustainable strength",
    }, "hritvik");

    expect(body.revision).toMatchObject({ predecessor_id: predecessor.id, effective_on: "2026-10-20", change_reason: "renamed after reviewing the plan", historical_sessions_changed: 0 });
    expect(body.programme).toMatchObject({
      name: "Sustainable strength",
      supersedes_programme_id: predecessor.id,
      active: true,
      templates: [{ prescriptions: [{
        exercise: "Barbell bench press",
        current_load: { value: 25, unit: "lb", basis: "per_side" },
        progression_rule: { kind: "rep_top" },
        cue: "Pause on the chest",
        fallback_note: "Use dumbbells when needed",
        fallbacks: ["Dumbbell bench press"],
      }] }],
    });
    expect(x.t.get("SELECT active, ended_on, superseded_at, superseded_reason, archived_at FROM programme WHERE id = ?", predecessor.id)).toEqual({
      active: 0,
      ended_on: "2026-10-20",
      superseded_at: "2026-10-20T07:30:00Z",
      superseded_reason: "renamed after reviewing the plan",
      archived_at: null,
    });
    expect(x.t.get("SELECT count(*) AS n FROM session WHERE template_id IN (SELECT id FROM session_template WHERE programme_id = ?)", predecessor.id)).toEqual({ n: 0 });
    expect((await x.ok("programme", { member: "Hritvik" }, "hritvik")).programme.id).toBe(body.programme.id);
  });

  it("replaces the full structure atomically and leaves historical session links untouched", async () => {
    const x = setupToday();
    const seeded = seedTraining(x);
    const predecessor = (await x.ok("create_programme", initial, "hritvik")).programme;
    const oldTemplate = predecessor.templates[0].id;
    const historicalSession = x.t.insert("session", {
      member_id: x.h.hritvik, performed_on: "2026-10-12", gym_id: seeded.gym, session_type: "strength", template_id: oldTemplate,
      started_at: "2026-10-12T06:00:00Z", ended_at: "2026-10-12T07:00:00Z", state: "confirmed", confirmed_at: "2026-10-12T07:00:00Z",
    });

    const body = await x.ok("update_programme", {
      member: "Hritvik",
      effective_on: "2026-10-20",
      change_reason: "moving to a two day split",
      name: "Two day split",
      schedule_kind: "rotation",
      templates: [
        { name: "Push", session_type: "strength", prescriptions: [{ exercise: "bench", sets: 3, rep_low: 5, rep_high: 7, fallbacks: [{ exercise: "db bench", note: "same movement" }] }] },
        { name: "Pull", session_type: "strength", prescriptions: [{ exercise: "pulldown", sets: 3, rep_low: 8, rep_high: 10 }] },
      ],
      slots: [{ rotation_position: 1, template: "Push" }, { rotation_position: 2, template: "Pull" }],
    }, "agent");

    expect(body.programme.templates.map((template: { name: string }) => template.name)).toEqual(["Push", "Pull"]);
    expect(body.programme.templates[0].prescriptions[0].fallbacks).toEqual(["Dumbbell bench press"]);
    expect(x.t.get("SELECT f.note FROM prescription_fallback f JOIN prescription p ON p.id = f.prescription_id JOIN session_template t ON t.id = p.template_id WHERE t.programme_id = ?", body.programme.id)).toEqual({ note: "same movement" });
    expect(body.revision.historical_sessions_changed).toBe(0);
    expect(x.t.get("SELECT template_id FROM session WHERE id = ?", historicalSession)).toEqual({ template_id: oldTemplate });
  });

  it("blocks replacement while the predecessor has an open session", async () => {
    const x = setupToday();
    const seeded = seedTraining(x);
    const predecessor = (await x.ok("create_programme", initial, "hritvik")).programme;
    x.t.insert("session", {
      member_id: x.h.hritvik, performed_on: "2026-10-20", gym_id: seeded.gym, session_type: "strength", template_id: predecessor.templates[0].id,
      started_at: "2026-10-20T06:00:00Z", state: "draft",
    });

    const reply = await x.call("update_programme", {
      member: "Hritvik", effective_on: "2026-10-20", change_reason: "new split", name: "Blocked rename",
    }, "hritvik");

    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "open_programme_session" });
    expect(x.t.get("SELECT name, active FROM programme WHERE id = ?", predecessor.id)).toEqual({ name: "Everyday strength", active: 1 });
  });

  it("does not mistake a confirmed legacy session without ended_at for an open draft", async () => {
    const x = setupToday();
    const seeded = seedTraining(x);
    const predecessor = (await x.ok("create_programme", initial, "hritvik")).programme;
    x.t.insert("session", {
      member_id: x.h.hritvik, performed_on: "2026-10-12", gym_id: seeded.gym, session_type: "strength", template_id: predecessor.templates[0].id,
      started_at: "2026-10-12T06:00:00Z", ended_at: null, state: "confirmed", confirmed_at: "2026-10-12T07:00:00Z",
    });

    const body = await x.ok("update_programme", {
      member: "Hritvik", effective_on: "2026-10-20", change_reason: "rename after the completed legacy session", name: "Legacy-safe rename",
    }, "hritvik");
    expect(body.programme.name).toBe("Legacy-safe rename");
  });

  it("enforces ownership, record-only mode, selector validity, and complete structural replacements", async () => {
    const owner = setupToday();
    seedTraining(owner);
    const predecessor = (await owner.ok("create_programme", initial, "hritvik")).programme;
    const request = { member: "Hritvik", effective_on: "2026-10-20", change_reason: "agreed update", name: "New name" };
    expect((await owner.call("update_programme", request, "asha")).http).toBe(403);
    expect((await owner.call("update_programme", { ...request, programme_id: predecessor.id + 999 }, "hritvik")).body).toMatchObject({ status: "needs_clarification", reason: "programme_selector" });
    expect((await owner.call("update_programme", { ...request, templates: initial.templates }, "hritvik")).body).toMatchObject({ status: "needs_clarification", reason: "complete_programme_structure" });

    const recordOnly = setupToday();
    seedTraining(recordOnly);
    expect((await recordOnly.call("update_programme", { ...request, member: "Asha" }, "agent")).body).toMatchObject({ status: "needs_clarification", reason: "record_only_member" });
  });

  it("validates before writing and stays within the D1 statement budget", async () => {
    const x = setupToday();
    seedTraining(x);
    const predecessor = (await x.ok("create_programme", initial, "hritvik")).programme;
    const before = x.t.get("SELECT count(*) AS n FROM programme");
    const invalid = await x.call("update_programme", {
      member: "Hritvik", effective_on: "2026-10-20", change_reason: "invalid replacement",
      schedule_kind: "rotation", templates: initial.templates, slots: [{ rotation_position: 2, template: "Full body A" }],
    }, "hritvik");
    expect(invalid.body).toMatchObject({ status: "needs_clarification", reason: "rotation_positions" });
    expect(x.t.get("SELECT count(*) AS n FROM programme")).toEqual(before);
    expect(x.t.get("SELECT active FROM programme WHERE id = ?", predecessor.id)).toEqual({ active: 1 });

    const run = await toolWithinBudget(x, "update_programme", {
      member: "Hritvik", effective_on: "2026-10-20", change_reason: "rename only", name: "Budgeted revision",
    }, "hritvik", 30);
    expect(run.body.programme.name).toBe("Budgeted revision");
  });

  it("requires immediate activation and refuses predecessor sessions after the cutoff", async () => {
    const x = setupToday();
    const seeded = seedTraining(x);
    const predecessor = (await x.ok("create_programme", initial, "hritvik")).programme;
    for (const effective_on of ["2026-10-19", "2026-10-21"]) {
      const reply = await x.call("update_programme", { member: "Hritvik", effective_on, change_reason: "wrong day", name: "Not yet" }, "hritvik");
      expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "programme_revision_is_immediate" });
    }
    x.t.insert("session", {
      member_id: x.h.hritvik, performed_on: "2026-10-21", gym_id: seeded.gym, session_type: "strength", template_id: predecessor.templates[0].id,
      started_at: "2026-10-21T06:00:00Z", ended_at: "2026-10-21T07:00:00Z", state: "confirmed", confirmed_at: "2026-10-21T07:00:00Z",
    });
    const reply = await x.call("update_programme", { member: "Hritvik", effective_on: "2026-10-20", change_reason: "conflicts", name: "Blocked" }, "hritvik");
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "future_programme_session" });
  });

  it("preserves future swaps by template name and refuses a structural revision that removes a referenced template", async () => {
    const x = setupToday();
    seedTraining(x);
    const weekday = { ...initial, schedule_kind: "weekday" as const, slots: [{ weekday: 1, template: "Full body A" }] };
    const predecessor = (await x.ok("create_programme", weekday, "hritvik")).programme;
    x.t.insert("schedule_swap", { programme_id: predecessor.id, on_date: "2026-10-22", template_id: predecessor.templates[0].id, reason: "travel" });
    x.t.insert("schedule_swap", { programme_id: predecessor.id, on_date: "2026-10-23", template_id: null, reason: "rest" });

    const removed = await x.call("update_programme", {
      member: "Hritvik", effective_on: "2026-10-20", change_reason: "replace all", schedule_kind: "weekday",
      templates: [{ name: "Different", session_type: "strength", prescriptions: [{ exercise: "bench", sets: 3, rep_low: 6, rep_high: 8 }] }],
      slots: [{ weekday: 1, template: "Different" }],
    }, "hritvik");
    expect(removed.body).toMatchObject({ status: "needs_clarification", reason: "programme_swaps_need_mapping" });

    const body = await x.ok("update_programme", { member: "Hritvik", effective_on: "2026-10-20", change_reason: "rename", name: "Renamed" }, "hritvik");
    expect(body.programme.swaps).toMatchObject([
      { date: "2026-10-22", template: "Full body A", reason: "travel" },
      { date: "2026-10-23", template: null, reason: "rest" },
    ]);
  });

  it("refuses to clone more than the bounded number of future swaps", async () => {
    const x = setupToday();
    seedTraining(x);
    const weekday = { ...initial, schedule_kind: "weekday" as const, slots: [{ weekday: 1, template: "Full body A" }] };
    const predecessor = (await x.ok("create_programme", weekday, "hritvik")).programme;
    for (let day = 1; day <= 61; day++) {
      const on = new Date(Date.UTC(2027, 0, day)).toISOString().slice(0, 10);
      x.t.insert("schedule_swap", { programme_id: predecessor.id, on_date: on, template_id: null, reason: `planned rest ${day}` });
    }
    const reply = await x.call("update_programme", {
      member: "Hritvik", effective_on: "2026-10-20", change_reason: "rename", name: "Too many swaps",
    }, "hritvik");
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "programme_future_swaps_too_many" });
    expect(x.t.get("SELECT active FROM programme WHERE id = ?", predecessor.id)).toEqual({ active: 1 });
  });

  it("refuses to copy dated swaps into a rotation schedule that ignores them", async () => {
    const x = setupToday();
    seedTraining(x);
    const weekday = { ...initial, schedule_kind: "weekday" as const, slots: [{ weekday: 2, template: "Full body A" }] };
    const predecessor = (await x.ok("create_programme", weekday, "hritvik")).programme;
    x.t.insert("schedule_swap", { programme_id: predecessor.id, on_date: "2026-10-27", template_id: predecessor.templates[0].id, reason: "festival week" });

    const reply = await x.call("update_programme", {
      member: "Hritvik", effective_on: "2026-10-20", change_reason: "switching to a rotation", schedule_kind: "rotation",
      templates: initial.templates, slots: [{ rotation_position: 1, template: "Full body A" }],
    }, "hritvik");
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "programme_swaps_need_mapping" });
  });

  it("accepts a bounded clone and refuses an oversized aggregate fallback payload before staging writes", async () => {
    const bounded = setupToday();
    const boundedSeed = seedTraining(bounded);
    const boundedPredecessor = (await bounded.ok("create_programme", initial, "hritvik")).programme;
    bounded.t.insert("prescription_fallback", {
      prescription_id: boundedPredecessor.templates[0].prescriptions[0].id,
      exercise_id: boundedSeed.dbBench,
      rank: 1,
      note: "a".repeat(300_000),
    });
    expect((await bounded.ok("update_programme", { member: "Hritvik", effective_on: "2026-10-20", change_reason: "bounded rename", name: "Within bound" }, "hritvik")).programme.name).toBe("Within bound");

    const x = setupToday();
    const seeded = seedTraining(x);
    const predecessor = (await x.ok("create_programme", initial, "hritvik")).programme;
    x.t.insert("prescription_fallback", {
      prescription_id: predecessor.templates[0].prescriptions[0].id,
      exercise_id: seeded.dbBench,
      rank: 1,
      note: "漢".repeat(400_000),
    });
    const before = x.t.get("SELECT count(*) AS n FROM programme");
    const reply = await x.call("update_programme", { member: "Hritvik", effective_on: "2026-10-20", change_reason: "rename", name: "Too large" }, "hritvik");
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "programme_fallbacks_too_large" });
    expect(x.t.get("SELECT count(*) AS n FROM programme")).toEqual(before);
  });

  it("maps concurrent active/successor uniqueness races to a retryable programme conflict", () => {
    for (const column of ["supersedes_programme_id", "member_id"]) {
      const error = programmeRevisionConflict(`UNIQUE constraint failed: programme.${column}`);
      expect(error).toMatchObject({ code: "programme_changed", httpStatus: 409 });
    }
    expect(programmeRevisionConflict("UNIQUE constraint failed: schedule_slot.programme_id")).toBeNull();
  });
});
