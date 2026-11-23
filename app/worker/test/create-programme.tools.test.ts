import { describe, expect, it } from "vitest";
import { toolWithinBudget } from "./budget";
import { setup } from "./harness";
import { seedTraining } from "./seed";

const base = {
  member: "Hritvik",
  name: "Everyday strength",
  schedule_kind: "rotation" as const,
  started_on: "2026-10-05",
  change_reason: "starting the programme we agreed in chat",
  templates: [
    {
      name: "Full body A",
      session_type: "strength" as const,
      prescriptions: [{ exercise: "bench", sets: 3, rep_low: 6, rep_high: 8 }],
    },
  ],
  slots: [{ rotation_position: 1, template: "Full body A" }],
};

describe("public create_programme", () => {
  it("lets the member create a complete rotation programme and returns its canonical graph", async () => {
    const x = setup();
    seedTraining(x);

    const body = await x.ok("create_programme", base, "hritvik");

    expect(body.programme).toMatchObject({
      member: "Hritvik",
      name: "Everyday strength",
      schedule_kind: "rotation",
      active: true,
      started_on: "2026-10-05",
      templates: [
        {
          name: "Full body A",
          session_type: "strength",
          slots: [{ rotation_position: 1 }],
          prescriptions: [{ position: 1, exercise: "Barbell bench press", sets: 3, target: { kind: "reps", low: 6, high: 8 } }],
        },
      ],
    });
    expect(x.t.get("SELECT reason FROM write_log WHERE tool = 'create_programme'")).toEqual({
      reason: "starting the programme we agreed in chat",
    });
  });

  it("allows the household agent but refuses another member", async () => {
    const agent = setup();
    seedTraining(agent);
    expect((await agent.call("create_programme", base, "agent")).body.status).toBe("ok");

    const other = setup();
    seedTraining(other);
    const reply = await other.call("create_programme", base, "asha");
    expect(reply.http).toBe(403);
  });

  it("requires a rationale and rejects record-only members or a second active programme", async () => {
    const noReason = setup();
    seedTraining(noReason);
    expect((await noReason.call("create_programme", { ...base, change_reason: undefined }, "hritvik")).body).toMatchObject({ status: "invalid" });

    const recordOnly = setup();
    seedTraining(recordOnly);
    expect((await recordOnly.call("create_programme", { ...base, member: "Asha" }, "agent")).body).toMatchObject({
      status: "needs_clarification",
      reason: "record_only_member",
    });

    const existing = setup();
    seedTraining(existing);
    await existing.ok("create_programme", base, "hritvik");
    expect((await existing.call("create_programme", { ...base, name: "Another" }, "hritvik")).body).toMatchObject({
      status: "needs_clarification",
      reason: "programme_exists",
    });
  });

  it("prefers the semantic change reason in the audit log", async () => {
    const x = setup();
    seedTraining(x);
    await x.ok("create_programme", { ...base, reason: "reserved transport fallback" }, "hritvik");
    expect(x.t.get("SELECT reason FROM write_log WHERE tool = 'create_programme'")).toEqual({
      reason: "starting the programme we agreed in chat",
    });
  });

  it("returns loads, target details, progression and coaching notes in the canonical graph", async () => {
    const x = setup();
    seedTraining(x);
    const body = await x.ok("create_programme", {
      ...base,
      templates: [{
        name: "Full body A",
        session_type: "strength",
        prescriptions: [
          {
            exercise: "bench",
            sets: 3,
            rep_low: 6,
            rep_high: 8,
            rir_target_low: 1,
            rir_target_high: 2,
            rest_s: 150,
            load: { value: 20, unit: "lb", basis: "per_side", implement: "Olympic bar and plates" },
            progression_rule: { kind: "rep_top", target_sets: 3, rep_top: 8, rir_floor: "from_prescription", increment: "smallest_step" },
            cue: "Pause on the chest",
            fallback_note: "Use dumbbells if the rack is busy",
          },
          { exercise: "incline walk", target: { kind: "duration", low_s: 600, high_s: 900 }, sets: 1 },
        ],
      }],
    }, "hritvik");
    expect(body.programme.templates[0].prescriptions[0]).toMatchObject({
      target: { kind: "reps", low: 6, high: 8 },
      rir_target: { low: 1, high: 2 },
      current_load: { value: 20, unit: "lb", basis: "per_side", implement: { name: "Olympic bar and plates" } },
      progression_rule: { kind: "rep_top", target_sets: 3, rep_top: 8, rir_floor: "from_prescription", increment: "smallest_step" },
      cue: "Pause on the chest",
      fallback_note: "Use dumbbells if the rack is busy",
    });
    expect(body.programme.templates[0].prescriptions[1]).toMatchObject({
      target: { kind: "duration", low_s: 600, high_s: 900 },
      current_load: null,
      progression_rule: null,
    });
  });

  it("creates a realistic five-day programme within the write query budget", async () => {
    const x = setup();
    seedTraining(x);
    const templates = Array.from({ length: 5 }, (_, templateIndex) => ({
      name: `Day ${templateIndex + 1}`,
      session_type: "strength" as const,
      prescriptions: Array.from({ length: 6 }, () => ({ exercise: "bench", sets: 3, rep_low: 6, rep_high: 8 })),
    }));
    const run = await toolWithinBudget(
      x,
      "create_programme",
      {
        ...base,
        templates,
        slots: templates.map((template, index) => ({ rotation_position: index + 1, template: template.name })),
      },
      "hritvik",
      30,
    );
    expect(run.body.programme.templates).toHaveLength(5);
  });

  it("bounds the programme graph exposed at the system boundary", async () => {
    const x = setup();
    seedTraining(x);
    const tooManySlots = Array.from({ length: 31 }, (_, index) => ({ rotation_position: index + 1, template: "Full body A" }));
    const reply = await x.call("create_programme", { ...base, slots: tooManySlots }, "hritvik");
    expect(reply.body).toMatchObject({ status: "invalid" });
  });

  it("bounds total prescriptions before building a D1 payload", async () => {
    const x = setup();
    seedTraining(x);
    const templates = Array.from({ length: 4 }, (_, templateIndex) => ({
      name: `Large day ${templateIndex + 1}`,
      session_type: "strength" as const,
      prescriptions: Array.from({ length: 46 }, () => ({ exercise: "bench", sets: 3, rep_low: 6, rep_high: 8 })),
    }));
    const reply = await x.call("create_programme", {
      ...base,
      templates,
      slots: templates.map((template, index) => ({ rotation_position: index + 1, template: template.name })),
    }, "hritvik");
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "programme_too_large" });
    expect(x.t.get("SELECT count(*) AS n FROM programme")).toEqual({ n: 0 });
  });

  it("persists the maximum accepted graph with bounded multibyte coaching text", async () => {
    const x = setup();
    seedTraining(x);
    const note = "漢".repeat(1_000);
    const templates = Array.from({ length: 3 }, (_, templateIndex) => ({
      name: `Maximum day ${templateIndex + 1}`,
      session_type: "strength" as const,
      prescriptions: Array.from({ length: 60 }, () => ({
        exercise: "bench",
        sets: 3,
        rep_low: 6,
        rep_high: 8,
        progression_rule: { kind: "manual" as const, cue: note },
        cue: note,
        fallback_note: note,
      })),
    }));
    const run = await toolWithinBudget(x, "create_programme", {
      ...base,
      templates,
      slots: templates.map((template, index) => ({ rotation_position: index + 1, template: template.name })),
    }, "hritvik", 30);
    expect(run.body.programme.templates.flatMap((template: { prescriptions: unknown[] }) => template.prescriptions)).toHaveLength(180);
  });

  it.each([
    ["at least one slot", { ...base, slots: [] }, "slots_needed"],
    [
      "unique weekday slots",
      {
        ...base,
        schedule_kind: "weekday" as const,
        slots: [
          { weekday: 1, template: "Full body A" },
          { weekday: 1, template: "Full body A" },
        ],
      },
      "duplicate_schedule_slot",
    ],
    [
      "contiguous rotation positions",
      { ...base, slots: [{ rotation_position: 2, template: "Full body A" }] },
      "rotation_positions",
    ],
  ])("validates the final graph has %s before writing", async (_label, input, reason) => {
    const x = setup();
    seedTraining(x);
    const before = x.t.get("SELECT count(*) AS n FROM record_version");

    const reply = await x.call("create_programme", input, "hritvik");

    expect(reply.body).toMatchObject({ status: "needs_clarification", reason });
    expect(x.t.get("SELECT count(*) AS n FROM programme")).toEqual({ n: 0 });
    expect(x.t.get("SELECT count(*) AS n FROM record_version")).toEqual(before);
  });
});
