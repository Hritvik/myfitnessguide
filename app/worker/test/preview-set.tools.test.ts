// preview_set is log_set without the write: the same planSet, so the
// feedback a member sees while typing is exactly what saving returns.
import { describe, expect, it } from "vitest";
import { LOG_SET_BUDGET, toolWithinBudget } from "./budget";
import { setup } from "./harness";
import { busyInput, MONDAY, seedUpperA } from "./input-seed";
import { seedTraining } from "./seed";

async function ready() {
  const x = setup();
  const s = seedTraining(x);
  seedUpperA(x, s);
  return { x, s };
}

const pulldown = (over: Record<string, unknown> = {}) => ({ member: "Hritvik", date: MONDAY, exercise: "lat pulldown", reps: 12, rir: 2, load: { value: 40, unit: "kg", basis: "total" }, ...over });
const counts = (x: Awaited<ReturnType<typeof ready>>["x"]) =>
  x.t.get("SELECT (SELECT count(*) FROM session) AS sessions, (SELECT count(*) FROM session_set) AS sets, (SELECT count(*) FROM write_log) AS writes");
const withoutIds = (set: Record<string, unknown>) => {
  const { id: _i, session_id: _s, ...rest } = set;
  return rest;
};

describe("preview_set", () => {
  it("returns what log_set then returns, and writes nothing", async () => {
    const { x } = await ready();
    const before = counts(x);
    const preview = await x.ok("preview_set", pulldown(), "hritvik");
    expect(counts(x)).toEqual(before);
    expect(preview.session).toEqual({ id: null, would_create: true, template: "Upper A", workout: null });
    expect(preview.set).toMatchObject({ id: null, session_id: null });
    const logged = await x.ok("log_set", pulldown(), "hritvik");
    expect(withoutIds(preview.set)).toEqual(withoutIds(logged.set));
    for (const k of ["snap", "offer", "implausible", "read_from"]) expect(preview[k]).toEqual(logged[k]);
    expect(preview.state).toBe(logged.set.state);
  });

  it("flags a load off the gym's list as a draft with the offer log_set would make", async () => {
    const { x, s } = await ready();
    const preview = await x.ok("preview_set", pulldown({ load: { value: 47.5, unit: "kg", basis: "total" } }), "hritvik");
    expect(preview.snap.status).toBe("off_list");
    expect(preview.state).toBe("draft");
    expect(preview.offer).toMatchObject({ tool: "add_implement_load", implement_id: s.stack });
  });

  it("warns of a load implausible against the member's history", async () => {
    const { x } = await ready();
    for (let n = 0; n < 3; n++) await x.ok("log_set", pulldown(), "hritvik");
    // 70 kg against today's heaviest 40 kg: a ratio of 1.75, past the domain's 1.6.
    const preview = await x.ok("preview_set", pulldown({ load: { value: 70, unit: "kg", basis: "total" }, rir: 0 }), "hritvik");
    expect(preview.implausible).toMatchObject({ referenceKg: 40 });
  });

  it("asks what log_set would ask", async () => {
    const { x } = await ready();
    const reply = await x.call("preview_set", pulldown({ rir: undefined }), "hritvik");
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "rir_needed", path: ["rir"] });
  });

  it("previews into a stored session by session_id", async () => {
    const { x } = await ready();
    const logged = await x.ok("log_set", pulldown(), "hritvik");
    const preview = await x.ok("preview_set", { session_id: logged.session.id, exercise: "lat pulldown", reps: 11, rir: 1, load: { value: 40, unit: "kg", basis: "total" } }, "hritvik");
    expect(preview.session).toEqual({ id: logged.session.id, would_create: false, template: null, workout: null });
    expect(preview.set).toMatchObject({ set_number: 2, position: 2, session_id: logged.session.id });
  });

  it("previews another member's set as a draft", async () => {
    const { x } = await ready();
    const preview = await x.ok("preview_set", { member: "Asha", date: MONDAY, exercise: "pushups", reps: 15, load: "none" }, "hritvik");
    expect(preview.state).toBe("draft");
  });

  it(`stays within LOG_SET_BUDGET (${LOG_SET_BUDGET}), log_set's own, at 40 implements`, async () => {
    const { x } = await busyInput(40);
    await toolWithinBudget(x, "preview_set", pulldown(), "hritvik", LOG_SET_BUDGET);
  });
});
