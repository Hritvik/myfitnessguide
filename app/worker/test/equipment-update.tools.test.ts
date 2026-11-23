// Correcting and retiring equipment: a rename is always safe, a change that
// would alter what stored loads mean is refused while the kit is in use, and
// retiring keeps every set's history readable.
import { describe, expect, it } from "vitest";
import { setup } from "./harness";
import { seedTraining } from "./seed";

async function inUse(x: ReturnType<typeof setup>, implement: number) {
  const session = (await x.ok("start_session", { member: "Hritvik", date: "2026-10-05", session_type: "strength" })).session.id;
  return (await x.ok("log_set", {
    session_id: session, exercise: "db curl", reps: 10, rir: 2,
    load: { value: 10, unit: "kg", basis: "per_hand", implement },
  })).set.id as number;
}

describe("update_implement", () => {
  it("renames a piece and refuses a name another piece at the gym already has", async () => {
    const x = setup();
    const s = seedTraining(x);
    const body = await x.ok("update_implement", { implement_id: s.dumbbells, name: "Dumbbells (kg)" });
    expect(body.implement).toMatchObject({ name: "Dumbbells (kg)" });
    const inv = await x.ok("inventory", { gym: s.gym });
    expect(inv.implements.find((i: { id: number }) => i.id === s.dumbbells).name).toBe("Dumbbells (kg)");
    const asked = await x.call("update_implement", { implement_id: s.dumbbells, name: "Lat pulldown stack" });
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "duplicate_implement" });
  });

  it("corrects kind and loading while the kit is unused", async () => {
    const x = setup();
    const s = seedTraining(x);
    const body = await x.ok("update_implement", { implement_id: s.dumbbells, kind: "cable", loading: "plates_only" });
    expect(body.implement).toMatchObject({ kind: "cable", loading: "plates_only" });
  });

  it("refuses a change that would alter stored loads, but still allows a rename", async () => {
    const x = setup();
    const s = seedTraining(x);
    await inUse(x, s.dumbbells);
    const asked = await x.call("update_implement", { implement_id: s.dumbbells, kind: "cable" });
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "reclassify_in_use" });
    expect(asked.body.question).toContain("set_implement_archived");
    const renamed = await x.ok("update_implement", { implement_id: s.dumbbells, name: "Dumbbells (kg)" });
    expect(renamed.implement.name).toBe("Dumbbells (kg)");
  });

  it("asks for a change", async () => {
    const x = setup();
    const s = seedTraining(x);
    const reply = await x.call("update_implement", { implement_id: s.dumbbells });
    expect(reply.http).toBe(400);
    expect(reply.body).toMatchObject({ status: "error", error: { code: "no_changes" } });
  });
});

describe("set_implement_archived", () => {
  it("retires a piece out of inventory, keeps its history, and restores it", async () => {
    const x = setup();
    const s = seedTraining(x);
    const setId = await inUse(x, s.dumbbells);
    const missing = await x.call("set_implement_archived", { implement_id: s.dumbbells, archived: true });
    expect(missing.body).toMatchObject({ status: "needs_clarification", reason: "reason_needed" });
    const body = await x.ok("set_implement_archived", { implement_id: s.dumbbells, archived: true, change_reason: "sold" });
    expect(body).toMatchObject({ action: "archived", implement: { archived: true, archived_reason: "sold" } });
    const inv = await x.ok("inventory", { gym: s.gym });
    expect(inv.implements.some((i: { id: number }) => i.id === s.dumbbells)).toBe(false);
    const history = await x.ok("get_set_history", { set_id: setId });
    expect(history.set.implement).toBe("Dumbbells");
    const back = await x.ok("set_implement_archived", { implement_id: s.dumbbells, archived: false, change_reason: "back in service" });
    expect(back).toMatchObject({ action: "restored", implement: { archived: false, archived_reason: null } });
    expect((await x.ok("inventory", { gym: s.gym })).implements.some((i: { id: number }) => i.id === s.dumbbells)).toBe(true);
  });

  it("says unchanged without a reason when it is already in that state", async () => {
    const x = setup();
    const s = seedTraining(x);
    const body = await x.ok("set_implement_archived", { implement_id: s.dumbbells, archived: false });
    expect(body).toMatchObject({ action: "unchanged", implement: { archived: false } });
  });
});
