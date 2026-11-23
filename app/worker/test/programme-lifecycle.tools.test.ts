import { describe, expect, it } from "vitest";
import { toolWithinBudget } from "./budget";
import { setup } from "./harness";
import { seedTraining } from "./seed";

const TODAY = "2026-10-20";
const setupToday = () => setup({ now: `${TODAY}T07:30:00Z` });

const programmeInput = {
  member: "Hritvik",
  name: "Simple strength",
  schedule_kind: "weekday" as const,
  started_on: "2026-10-01",
  change_reason: "start the plan",
  templates: [{
    name: "Full body",
    session_type: "strength" as const,
    prescriptions: [{
      exercise: "bench",
      sets: 3,
      rep_low: 6,
      rep_high: 8,
      rir_target_low: 1,
      rir_target_high: 2,
      load: { value: 20, unit: "lb" as const, basis: "per_side" as const, implement: "Olympic bar and plates" },
      progression_rule: { kind: "manual" as const, cue: "add load after clean reps" },
      cue: "pause",
      fallback_note: "same pattern",
      fallbacks: [{ exercise: "db bench", note: "when the rack is busy" }],
    }],
  }],
  slots: [{ weekday: 1, template: "Full body" }],
};

describe("programme lifecycle", () => {
  it("enforces paired archive and supersession metadata in the database", () => {
    const x = setupToday();
    const base = { member_id: x.h.hritvik, name: "Base", schedule_kind: "rotation", active: 0, started_on: "2026-10-01", ended_on: TODAY };
    expect(() => x.t.insert("programme", { ...base, archived_reason: "missing timestamp" })).toThrow(/CHECK/);
    expect(() => x.t.insert("programme", { ...base, superseded_at: "2026-10-20T07:30:00Z" })).toThrow(/CHECK/);
    expect(() => x.t.insert("phase", {
      member_id: x.h.hritvik, name: "Archived", starts_on: "2026-10-01", ends_on: null,
      energy_stance: "maintenance", intent: "test", archived_at: "2026-10-20T07:30:00Z",
    })).toThrow(/CHECK/);
  });

  it("archives the active programme without deleting its graph, then restores a successor with new ids", async () => {
    const x = setupToday();
    const seeded = seedTraining(x);
    const original = (await x.ok("create_programme", programmeInput, "hritvik")).programme;
    const historical = x.t.insert("session", {
      member_id: x.h.hritvik, performed_on: "2026-10-12", gym_id: seeded.gym, session_type: "strength",
      template_id: original.templates[0].id, state: "confirmed", confirmed_at: "2026-10-12T07:00:00Z",
    });
    await x.ok("programme_change", {
      member: "Hritvik",
      change: { kind: "swap", date: "2026-10-26", template: "Full body", reason: "travel" },
    }, "hritvik");

    const archived = await x.ok("set_programme_archived", {
      member: "Hritvik", programme_id: original.id, archived: true, effective_on: TODAY, change_reason: "take a break",
    }, "hritvik");
    expect(archived).toMatchObject({ action: "archived", programme: { id: original.id, active: false, archived_reason: "take a break" } });
    expect((await x.call("set_programme_archived", {
      member: "Hritvik", programme_id: original.id, archived: true, effective_on: TODAY, change_reason: "probe",
    }, "asha")).http).toBe(403);
    expect(await x.ok("set_programme_archived", {
      member: "Hritvik", programme_id: original.id, archived: true, effective_on: TODAY, change_reason: "repeat",
    }, "hritvik")).toMatchObject({ action: "unchanged", programme: { id: original.id, archived_reason: "take a break" } });
    expect((await x.ok("programme", { member: "Hritvik" }, "hritvik")).programme).toBeNull();
    expect(x.t.get("SELECT count(*) AS n FROM prescription p JOIN session_template t ON t.id = p.template_id WHERE t.programme_id = ?", original.id)).toEqual({ n: 1 });

    const restored = await x.ok("set_programme_archived", {
      member: "Hritvik", programme_id: original.id, archived: false, effective_on: TODAY, change_reason: "ready to resume",
    }, "agent");
    expect(restored).toMatchObject({ action: "restored_as_successor", programme: { active: true, supersedes_programme_id: original.id } });
    expect(restored.programme.id).not.toBe(original.id);
    expect(restored.programme.templates[0].id).not.toBe(original.templates[0].id);
    expect(restored.programme.templates[0].prescriptions[0]).toMatchObject({
      cue: "pause", fallback_note: "same pattern", fallbacks: ["Dumbbell bench press"], progression_rule: { kind: "manual" },
    });
    expect(restored.programme.swaps).toEqual([expect.objectContaining({ date: "2026-10-26", template: "Full body", reason: "travel" })]);
    expect(x.t.get("SELECT archived_at, archived_reason, superseded_at FROM programme WHERE id = ?", original.id)).toEqual({
      archived_at: "2026-10-20T07:30:00Z", archived_reason: "take a break", superseded_at: null,
    });
    expect(x.t.get("SELECT template_id FROM session WHERE id = ?", historical)).toEqual({ template_id: original.templates[0].id });
  });

  it("refuses wrong-day, cross-member, record-only and session-conflicting programme lifecycle writes", async () => {
    const x = setupToday();
    const seeded = seedTraining(x);
    const original = (await x.ok("create_programme", programmeInput, "hritvik")).programme;
    const request = { member: "Hritvik", programme_id: original.id, archived: true, effective_on: TODAY, change_reason: "pause" };
    expect((await x.call("set_programme_archived", request, "asha")).http).toBe(403);
    expect((await x.call("set_programme_archived", { ...request, effective_on: "2026-10-21" }, "hritvik")).body).toMatchObject({ reason: "programme_archive_is_immediate" });
    expect((await x.call("set_programme_archived", { ...request, member: "Asha" }, "agent")).body).toMatchObject({ reason: "record_only_member" });
    expect((await x.call("set_programme_archived", { ...request, change_reason: "   " }, "hritvik")).body.status).toBe("invalid");

    x.t.insert("session", {
      member_id: x.h.hritvik, performed_on: "2026-10-21", gym_id: seeded.gym, session_type: "strength",
      template_id: original.templates[0].id, state: "confirmed", confirmed_at: "2026-10-20T07:00:00Z",
    });
    expect((await x.call("set_programme_archived", request, "hritvik")).body).toMatchObject({ reason: "future_programme_session" });

    const y = setupToday();
    const otherSeed = seedTraining(y);
    const other = (await y.ok("create_programme", programmeInput, "hritvik")).programme;
    y.t.insert("session", {
      member_id: y.h.hritvik, performed_on: TODAY, gym_id: otherSeed.gym, session_type: "strength",
      template_id: other.templates[0].id, state: "draft",
    });
    expect((await y.call("set_programme_archived", { ...request, programme_id: other.id }, "hritvik")).body).toMatchObject({ reason: "open_programme_session" });
  });

  it("keeps programme lifecycle calls inside the D1 statement budget", async () => {
    const x = setupToday();
    seedTraining(x);
    const original = (await x.ok("create_programme", programmeInput, "hritvik")).programme;
    await toolWithinBudget(x, "set_programme_archived", {
      member: "Hritvik", programme_id: original.id, archived: true, effective_on: TODAY, change_reason: "pause",
    }, "hritvik");
    await toolWithinBudget(x, "set_programme_archived", {
      member: "Hritvik", programme_id: original.id, archived: false, effective_on: TODAY, change_reason: "resume",
    }, "hritvik");
  });

  it("refuses to clone an archived programme with too many future swaps", async () => {
    const x = setupToday();
    seedTraining(x);
    const original = (await x.ok("create_programme", programmeInput, "hritvik")).programme;
    await x.ok("set_programme_archived", {
      member: "Hritvik", programme_id: original.id, archived: true, effective_on: TODAY, change_reason: "pause",
    }, "hritvik");
    for (let day = 1; day <= 61; day++) {
      const on = new Date(Date.UTC(2027, 0, day)).toISOString().slice(0, 10);
      x.t.insert("schedule_swap", { programme_id: original.id, on_date: on, template_id: null, reason: `planned rest ${day}` });
    }
    const reply = await x.call("set_programme_archived", {
      member: "Hritvik", programme_id: original.id, archived: false, effective_on: TODAY, change_reason: "resume",
    }, "hritvik");
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "programme_future_swaps_too_many" });
    expect(x.t.get("SELECT count(*) AS n FROM programme WHERE supersedes_programme_id = ?", original.id)).toEqual({ n: 0 });
  });
});

describe("phase lifecycle", () => {
  it("creates and updates a phase atomically, allowing touching boundaries but refusing overlap", async () => {
    const x = setupToday();
    const base = await x.ok("upsert_phase", {
      member: "Hritvik", name: "Base", starts_on: "2026-09-01", ends_on: "2026-09-30",
      energy_stance: "maintenance", intent: "build consistency", change_reason: "plan the block",
    }, "hritvik");
    const cut = await x.ok("upsert_phase", {
      member: "Hritvik", name: "Cut", starts_on: "2026-10-01", ends_on: null,
      energy_stance: "deficit", intent: "reduce waist", change_reason: "begin cut",
    }, "agent");
    expect(base.phase.id).not.toBe(cut.phase.id);

    const overlap = await x.call("upsert_phase", {
      member: "Hritvik", name: "Overlap", starts_on: "2026-09-30", ends_on: "2026-10-02",
      energy_stance: "maintenance", intent: "invalid", change_reason: "try overlap",
    }, "hritvik");
    expect(overlap.body).toMatchObject({ status: "needs_clarification", reason: "phase_overlap" });

    const updated = await x.ok("upsert_phase", {
      member: "Hritvik", phase: cut.phase.id, name: "Gentle cut", starts_on: "2026-10-01", ends_on: "2026-12-31",
      energy_stance: "deficit", intent: "slow recomposition", change_reason: "make it sustainable",
    }, "hritvik");
    expect(updated).toMatchObject({ action: "updated", phase: { id: cut.phase.id, name: "Gentle cut", intent: "slow recomposition" } });
    expect(() => x.t.insert("phase", {
      member_id: x.h.hritvik, name: "DB overlap", starts_on: "2026-12-01", ends_on: "2027-01-01",
      energy_stance: "maintenance", intent: "must be rejected",
    })).toThrow(/phase_overlap/);
  });

  it("archives and safely restores a phase while normal reads exclude archived phases", async () => {
    const x = setupToday();
    const created = await x.ok("upsert_phase", {
      member: "Hritvik", name: "Cut", starts_on: "2026-10-01", ends_on: null,
      energy_stance: "deficit", intent: "reduce waist", change_reason: "start",
    }, "hritvik");
    await x.ok("set_phase_archived", { member: "Hritvik", phase: created.phase.id, archived: true, change_reason: "not using it" }, "hritvik");
    expect((await x.ok("programme", { member: "Hritvik", date: TODAY }, "hritvik")).phases).toEqual([]);
    expect(x.t.get("SELECT archived_at, archived_reason FROM phase WHERE id = ?", created.phase.id)).toEqual({
      archived_at: "2026-10-20T07:30:00Z", archived_reason: "not using it",
    });
    await x.ok("upsert_phase", {
      member: "Hritvik", name: "Maintenance", starts_on: "2026-10-01", ends_on: null,
      energy_stance: "maintenance", intent: "hold", change_reason: "replacement",
    }, "hritvik");
    expect((await x.call("set_phase_archived", { member: "Hritvik", phase: created.phase.id, archived: false, change_reason: "restore" }, "hritvik")).body).toMatchObject({ reason: "phase_overlap" });
  });

  it("enforces phase privacy and reasons while allowing record-only members and staying in budget", async () => {
    const x = setupToday();
    const input = {
      member: "Hritvik", name: "Base", starts_on: "2026-10-01", ends_on: null,
      energy_stance: "maintenance", intent: "build", change_reason: "start",
    };
    expect((await x.call("upsert_phase", input, "asha")).http).toBe(403);
    expect((await x.call("upsert_phase", { ...input, change_reason: "   " }, "hritvik")).body.status).toBe("invalid");
    const run = await toolWithinBudget(x, "upsert_phase", input, "hritvik");
    await toolWithinBudget(x, "set_phase_archived", {
      member: "Hritvik", phase: run.body.phase.id, archived: true, change_reason: "done",
    }, "hritvik");

    const recordOnly = await x.ok("upsert_phase", {
      ...input, member: "Asha", name: "Personal recomp", intent: "balance strength and nutrition",
    }, "agent");
    expect(recordOnly).toMatchObject({ action: "created", phase: { member_id: x.h.asha, name: "Personal recomp" } });
    expect((await x.call("set_phase_archived", {
      member: "Asha", phase: recordOnly.phase.id, archived: true, change_reason: "strategy changed",
    }, "hritvik")).http).toBe(403);
    expect(await x.ok("set_phase_archived", {
      member: "Asha", phase: recordOnly.phase.id, archived: true, change_reason: "strategy changed",
    }, "asha")).toMatchObject({ action: "archived" });
    expect((await x.call("set_phase_archived", {
      member: "Asha", phase: recordOnly.phase.id, archived: true, change_reason: "probe archived state",
    }, "hritvik")).http).toBe(403);
    expect(await x.ok("set_phase_archived", {
      member: "Asha", phase: recordOnly.phase.id, archived: true, change_reason: "repeat",
    }, "agent")).toMatchObject({ action: "unchanged", phase: { archived_reason: "strategy changed" } });
  });
});
