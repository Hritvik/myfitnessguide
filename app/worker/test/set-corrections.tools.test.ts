// Correcting a stored set (update_set), re-checking drafts against the
// inventory (revalidate_set / revalidate_session, add_implement_load),
// validating a session before it ends, and the compound-set and carry
// shapes session 48 needed.
import { describe, expect, it } from "vitest";
import { setup } from "./harness";
import { MONDAY, seedUpperA } from "./input-seed";
import { seedTraining } from "./seed";

async function ready() {
  const x = setup();
  const s = seedTraining(x);
  const p = seedUpperA(x, s);
  return { x, s, p };
}

const pulldown = (over: Record<string, unknown> = {}) => ({
  member: "Hritvik",
  date: MONDAY,
  exercise: "lat pulldown",
  reps: 12,
  rir: 2,
  load: { value: 40, unit: "kg", basis: "total" },
  ...over,
});

describe("update_set", () => {
  it("corrects a set in place, bumps its version and keeps the old value in its history", async () => {
    const { x } = await ready();
    const logged = await x.ok("log_set", pulldown());
    const id = logged.set.id as number;
    expect(logged.set.version).toBe(1);

    const updated = await x.ok("update_set", {
      set_id: id,
      version: 1,
      reason: "typed 37 kg, the stack was on 45",
      changes: { load: { value: 45, unit: "kg", basis: "total" } },
    });
    expect(updated.changed).toBe(true);
    expect(updated.version).toBe(2);
    expect(updated.set).toMatchObject({ id, load_value: 45, load_unit: "kg", state: "confirmed", version: 2 });
    expect(updated.changed_fields).toEqual(expect.arrayContaining(["load_value", "version"]));

    const history = await x.ok("get_set_history", { set_id: id });
    expect(history.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect(history.versions[0].data.load_value).toBe(40);
    expect(history.versions[1].data.load_value).toBe(45);
    expect(history.versions[1].reason).toBe("typed 37 kg, the stack was on 45");
  });

  it("refuses a correction made against a stale version instead of overwriting", async () => {
    const { x } = await ready();
    const logged = await x.ok("log_set", pulldown());
    await x.ok("update_set", { set_id: logged.set.id, version: 1, reason: "first", changes: { reps: 11 } });

    const stale = await x.call("update_set", { set_id: logged.set.id, version: 1, reason: "second", changes: { reps: 10 } });
    expect(stale.http).toBe(409);
    expect(stale.body.error.code).toBe("set_version_conflict");
    expect(stale.body.error.current_version).toBe(2);
    expect(x.t.get("SELECT reps FROM session_set WHERE id = ?", logged.set.id)).toEqual({ reps: 11 });
  });

  it("asks why, and writes nothing, when the reason is missing", async () => {
    const { x } = await ready();
    const logged = await x.ok("log_set", pulldown());
    const reply = await x.call("update_set", { set_id: logged.set.id, version: 1, changes: { reps: 10 } });
    expect(reply.body.status).toBe("needs_clarification");
    expect(reply.body.reason).toBe("reason_needed");
    expect(x.t.get("SELECT reps FROM session_set WHERE id = ?", logged.set.id)).toEqual({ reps: 12 });
  });

  it("refuses a set number another set of the same exercise already has", async () => {
    const { x } = await ready();
    const first = await x.ok("log_set", pulldown());
    const second = await x.ok("log_set", pulldown({ reps: 10 }));
    const reply = await x.call("update_set", {
      set_id: second.set.id,
      version: 1,
      reason: "wrong number",
      changes: { set_number: first.set.set_number },
    });
    expect(reply.http).toBe(409);
    expect(reply.body.error.code).toBe("set_number_taken");
  });
});

describe("revalidating drafts after the inventory learns a load", () => {
  it("add_implement_load confirms the draft sets that were waiting on that load", async () => {
    const { x, s } = await ready();
    const draft = await x.ok("log_set", {
      member: "Hritvik",
      date: MONDAY,
      exercise: "db curl",
      reps: 10,
      rir: 2,
      load: { value: 11, unit: "kg", basis: "per_hand" },
    });
    expect(draft.set).toMatchObject({ state: "draft", version: 1 });
    expect(x.t.get("SELECT draft_reason FROM session_set WHERE id = ?", draft.set.id)).toEqual({ draft_reason: "off_list" });

    const added = await x.ok("add_implement_load", { implement_id: s.dumbbells, loads: [11] });
    expect(added.revalidated_sets).toContain(draft.set.id);
    expect(added.still_draft).toEqual([]);
    expect(x.t.get("SELECT state, draft_reason FROM session_set WHERE id = ?", draft.set.id)).toEqual({
      state: "confirmed",
      draft_reason: null,
    });
  });

  it("revalidate_set re-checks without confirming when asked not to, and offers the load", async () => {
    const { x } = await ready();
    const draft = await x.ok("log_set", {
      member: "Hritvik",
      date: MONDAY,
      exercise: "db curl",
      reps: 10,
      rir: 2,
      load: { value: 11, unit: "kg", basis: "per_hand" },
    });
    const checked = await x.ok("revalidate_set", { set_id: draft.set.id, confirm: false });
    expect(checked.confirmed).toBe(false);
    expect(checked.still_draft.reason).toBe("off_list");
    expect(checked.offer).toMatchObject({ tool: "add_implement_load", implement_id: expect.any(Number) });
    expect(x.t.get("SELECT state FROM session_set WHERE id = ?", draft.set.id)).toEqual({ state: "draft" });
  });

  it("revalidate_session reports every draft still off the list in one call", async () => {
    const { x } = await ready();
    const one = await x.ok("log_set", {
      member: "Hritvik",
      date: MONDAY,
      exercise: "db curl",
      reps: 10,
      rir: 2,
      load: { value: 11, unit: "kg", basis: "per_hand" },
    });
    const two = await x.ok("log_set", {
      member: "Hritvik",
      date: MONDAY,
      exercise: "db curl",
      reps: 8,
      rir: 2,
      load: { value: 12, unit: "kg", basis: "per_hand" },
    });
    const reply = await x.ok("revalidate_session", { session_id: one.session.id });
    expect(reply.confirmed_sets).toEqual([]);
    expect(reply.still_draft.map((d: { id: number }) => d.id)).toEqual(expect.arrayContaining([one.set.id, two.set.id]));
  });
});

describe("validate_session", () => {
  it("lists the off-list drafts and the offer that would clear them, and writes nothing", async () => {
    const { x } = await ready();
    const draft = await x.ok("log_set", {
      member: "Hritvik",
      date: MONDAY,
      exercise: "db curl",
      reps: 10,
      rir: 2,
      load: { value: 11, unit: "kg", basis: "per_hand" },
    });
    const reply = await x.ok("validate_session", { session_id: draft.session.id });
    expect(reply.ready).toBe(false);
    expect(reply.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "off_list", set_ids: [draft.set.id] })]),
    );
    expect(reply.drafts).toEqual([{ id: draft.set.id, reason: "off_list" }]);
    expect(x.t.get("SELECT state FROM session_set WHERE id = ?", draft.set.id)).toEqual({ state: "draft" });
  });

  it("says a clean session is ready", async () => {
    const { x } = await ready();
    const logged = await x.ok("log_set", pulldown());
    const reply = await x.ok("validate_session", { session_id: logged.session.id });
    expect(reply).toMatchObject({ ready: true, blockers: [], drafts: [] });
  });
});

describe("compound sets and carries", () => {
  it("stores a drop set's segments, sums their volume, and keeps the opening segment on the row", async () => {
    const { x } = await ready();
    const body = await x.ok("log_set", {
      member: "Hritvik",
      date: MONDAY,
      exercise: "db curl",
      structure: "drop_set",
      rir: 0,
      segments: [
        { load: { value: 10, unit: "kg", basis: "per_hand" }, reps: 10 },
        { load: { value: 7.5, unit: "kg", basis: "per_hand" }, reps: 8 },
      ],
    });
    expect(body.set).toMatchObject({ structure: "drop_set", reps: 10, total_reps: 18, state: "confirmed" });
    expect(body.set.segments).toHaveLength(2);
    expect(body.set.volume_kg).toBeCloseTo(10 * 2 * 10 + 7.5 * 2 * 8, 5);
    const view = x.t.get("SELECT structure, total_reps, volume_kg FROM v_set WHERE id = ?", body.set.id);
    expect(view).toMatchObject({ structure: "drop_set", total_reps: 18 });
    expect(view?.volume_kg as number).toBeCloseTo(body.set.volume_kg as number, 5);
  });

  it("corrects one segment of a stored drop set", async () => {
    const { x } = await ready();
    const body = await x.ok("log_set", {
      member: "Hritvik",
      date: MONDAY,
      exercise: "db curl",
      structure: "drop_set",
      rir: 0,
      segments: [
        { load: { value: 10, unit: "kg", basis: "per_hand" }, reps: 10 },
        { load: { value: 7.5, unit: "kg", basis: "per_hand" }, reps: 8 },
      ],
    });
    const updated = await x.ok("update_set", {
      set_id: body.set.id,
      version: 1,
      reason: "the back-off was 8 kg, not 7.5",
      changes: {
        segments: [
          { load: { value: 10, unit: "kg", basis: "per_hand" }, reps: 10 },
          { load: { value: 8, unit: "kg", basis: "per_hand" }, reps: 8 },
        ],
      },
    });
    expect(updated.set.segments[1].load.value).toBe(8);
    expect(updated.set.volume_kg).toBeCloseTo(10 * 2 * 10 + 8 * 2 * 8, 5);
  });

  it("records a suitcase carry per side, with the distance each side covered", async () => {
    const { x } = await ready();
    x.t.insert("exercise", { household_id: x.h.id, name: "Suitcase carry", implement_kind: "dumbbell" });
    const body = await x.ok("log_set", {
      member: "Hritvik",
      date: MONDAY,
      exercise: "Suitcase carry",
      carry_type: "suitcase",
      load: { value: 20, unit: "kg", basis: "per_hand" },
      sides: [
        { side: "left", distance_m: 40 },
        { side: "right", distance_m: 40 },
      ],
    });
    expect(body.set).toMatchObject({ carry_type: "suitcase", distance_basis: "per_side", reps: null, state: "confirmed" });
    expect(body.set.sides).toEqual([
      { side: "left", distance_m: 40 },
      { side: "right", distance_m: 40 },
    ]);
    expect(body.set.distance).toEqual({ value: 80, unit: "m" });
  });
});

describe("equipment aliases", () => {
  it("resolves the household's word for an implement in a set's load", async () => {
    const { x, s } = await ready();
    // A second cable makes the implement ambiguous until the household's word names one.
    const crossover = x.t.insert("implement", { gym_id: s.gym, name: "Cable crossover", kind: "cable", unit: "kg", loading: "total", load_list_complete: 1 });
    for (const load of [20, 25, 30, 35, 40, 45]) x.t.insert("implement_load", { implement_id: crossover, load, unit: "kg" });
    x.t.insert("exercise", { household_id: x.h.id, name: "Cable fly", implement_kind: "cable" });
    const fly = (load: Record<string, unknown> = {}) => ({
      member: "Hritvik",
      date: MONDAY,
      exercise: "Cable fly",
      reps: 12,
      rir: 2,
      load: { value: 20, unit: "kg", basis: "total", ...load },
    });
    const ambiguous = await x.call("log_set", fly());
    expect(ambiguous.body.status).toBe("needs_clarification");
    expect(ambiguous.body.reason).toBe("implement_needed");

    await x.ok("learn_alias", { alias: "the stack", kind: "implement", target: s.stack, reason: "what the member calls the lat pulldown" });
    const logged = await x.ok("log_set", fly({ implement: "the stack" }));
    expect(logged.set.implement).toBe("Lat pulldown stack");
  });

  it("refuses an implement word that is already another implement's name", async () => {
    const { x, s } = await ready();
    const reply = await x.call("learn_alias", { alias: "Lat pulldown stack", kind: "implement", target: s.dumbbells, reason: "test" });
    expect(reply.body.status).toBe("needs_clarification");
    expect(reply.body.reason).toBe("alias_is_a_name");
  });
});
