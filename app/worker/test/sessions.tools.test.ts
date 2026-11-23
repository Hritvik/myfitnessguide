import { describe, expect, it } from "vitest";
import { setup, type Harness } from "./harness";
import { seedTraining } from "./seed";

async function pulldowns(x: Harness, s: ReturnType<typeof seedTraining>, date: string, load: number, warmUp = false) {
  const id = (await x.ok("start_session", { member: "Hritvik", date, session_type: "strength" })).session.id;
  if (warmUp) await x.ok("log_set", { session_id: id, exercise: "lat pulldown", set_type: "warm_up", reps: 10, rir: 4, load: { value: 20, unit: "kg", basis: "total", implement: s.stack } });
  await x.ok("log_set", { session_id: id, exercise: "lat pulldown", reps: 10, rir: 0, load: { value: load, unit: "kg", basis: "total", implement: s.stack } });
  await x.ok("end_session", { session_id: id });
  return id;
}

describe("sessions", () => {
  it("lists sessions newest first, with working sets, volume and every set", async () => {
    const x = setup();
    const s = seedTraining(x);
    await pulldowns(x, s, "2026-09-28", 40);
    const latest = await pulldowns(x, s, "2026-10-05", 45, true);
    const body = await x.ok("sessions", { member: "Hritvik" }, "hritvik");
    expect(body).toMatchObject({ member: "Hritvik", from: "2026-08-11", to: "2026-10-05" });
    expect(body.sessions.map((x: { date: string }) => x.date)).toEqual(["2026-10-05", "2026-09-28"]);
    const [today] = body.sessions;
    expect(today).toMatchObject({ id: latest, session_type: "strength", template: null, gym: "Cult Koramangala", state: "confirmed", working_sets: 1, cardio: null });
    expect(today.volume_kg).toBeCloseTo(450, 9);
    expect(today.sets_without_volume).toBe(0);
    expect(today.sets.map((x: { set_type: string; reps: number }) => [x.set_type, x.reps])).toEqual([["warm_up", 10], ["working", 10]]);
    expect(today.sets[1]).toMatchObject({ exercise: "Cable lat pulldown", load_value: 45, load_unit: "kg", rir: { low: 0, high: 0 } });
  });

  it("counts working sets whose volume is unknown instead of treating them as zero", async () => {
    const x = setup();
    const s = seedTraining(x);
    const id = (await x.ok("start_session", { member: "Hritvik", date: "2026-10-05", session_type: "strength" })).session.id;
    await x.ok("log_set", { session_id: id, exercise: "push-up", reps: 12, rir: 2, load: "none" });
    const [session] = (await x.ok("sessions", { member: "Hritvik", from: "2026-10-05", to: "2026-10-05" })).sessions;
    expect(session).toMatchObject({ working_sets: 1, sets_without_volume: 1, volume_kg: 0 });
    expect(s.pushup).toBeTypeOf("number");
  });

  it("names a record only when a session's best e1RM beats every earlier one on the same implement", async () => {
    const x = setup();
    const s = seedTraining(x);
    await pulldowns(x, s, "2026-09-28", 40);
    await pulldowns(x, s, "2026-10-05", 45);
    const [latest, first] = (await x.ok("sessions", { member: "Hritvik" })).sessions;
    expect(latest.records).toHaveLength(1);
    expect(latest.records[0].exercise).toBe("Cable lat pulldown");
    expect(latest.records[0].e1rm_kg).toBeCloseTo(60, 9);
    expect(latest.records[0].previous_best_kg).toBeCloseTo(40 * (1 + 10 / 30), 9);
    expect(first.records).toEqual([]);
  });

  it("summarises a cardio session's blocks and energy", async () => {
    const x = setup();
    seedTraining(x);
    await x.ok("log_cardio", { member: "Hritvik", date: "2026-10-04", session_type: "class", energy_kcal: 280, blocks: [{ kind: "steady", duration_s: 1800 }, { kind: "steady", duration_s: 1200 }] });
    const [dance] = (await x.ok("sessions", { member: "Hritvik" })).sessions;
    expect(dance).toMatchObject({ session_type: "class", working_sets: 0, cardio: { blocks: 2, duration_s: 3000 }, energy_kcal: 280, sets: [] });
  });

  it("a record is measured against the best before that session, not the best of the whole history", async () => {
    const x = setup();
    const s = seedTraining(x);
    await pulldowns(x, s, "2026-09-14", 40);
    await pulldowns(x, s, "2026-09-21", 50);
    await pulldowns(x, s, "2026-09-28", 45);
    const byDate = Object.fromEntries((await x.ok("sessions", { member: "Hritvik" })).sessions.map((s_: { date: string; records: unknown[] }) => [s_.date, s_.records.length]));
    // 50 beat 40; 45 beat nothing (50 came before it).
    expect(byDate).toEqual({ "2026-09-14": 0, "2026-09-21": 1, "2026-09-28": 0 });
  });

  it("takes a range, and is household data any member may read", async () => {
    const x = setup();
    const s = seedTraining(x);
    await pulldowns(x, s, "2026-09-28", 40);
    await pulldowns(x, s, "2026-10-05", 45);
    const ranged = await x.ok("sessions", { member: "Hritvik", from: "2026-09-01", to: "2026-09-30" }, "asha");
    expect(ranged.sessions.map((x: { date: string }) => x.date)).toEqual(["2026-09-28"]);
  });

  it("is visible to the owner, another member and the agent", async () => {
    const x = setup();
    const s = seedTraining(x);
    await pulldowns(x, s, "2026-10-05", 45);
    for (const caller of ["hritvik", "asha", "agent"] as const) {
      const body = await x.ok("sessions", { member: "Hritvik" }, caller);
      expect(body.sessions, caller).toHaveLength(1);
    }
  });

  it("a rejected heavier set neither shows nor creates a record (a rejected draft is deleted)", async () => {
    const x = setup();
    const s = seedTraining(x);
    await pulldowns(x, s, "2026-09-28", 40);
    const id = await pulldowns(x, s, "2026-10-05", 45);
    const draft = x.t.insert("session_set", {
      session_id: id, exercise_id: s.pulldown, set_number: 9, set_type: "working", reps: 10, load_status: "entered", load_value: 60, load_unit: "kg",
      load_basis: "total", load_implement_id: s.stack, rir_status: "recorded", rir_low: 0, rir_high: 0, state: "draft", position: 9,
    });
    await x.ok("reject", { records: [{ table: "session_set", id: draft }], reason: "wrong set" }, "hritvik");
    const [latest] = (await x.ok("sessions", { member: "Hritvik" })).sessions;
    expect(latest.sets.map((y: { id: number }) => y.id)).not.toContain(draft);
    expect(latest.records).toHaveLength(1);
    expect(latest.records[0].e1rm_kg).toBeCloseTo(60, 9);
  });
});
