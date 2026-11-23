// A session's running order is explicit: each set has a position, log_set
// appends by default and can insert at a position, moving later sets down.
import { describe, expect, it } from "vitest";
import { setup } from "./harness";
import { seedTraining } from "./seed";

async function ready() {
  const x = setup();
  seedTraining(x);
  const session = (await x.ok("start_session", { member: "Hritvik", date: "2026-10-05", session_type: "strength" })).session.id;
  const log = (exercise: string, extra: Record<string, unknown> = {}) => x.ok("log_set", { session_id: session, exercise, reps: 10, rir: 2, load: "none", ...extra });
  const order = () => x.t.all("SELECT exercise_name, set_number, position FROM v_set WHERE session_id = ? ORDER BY position", session);
  return { x, session, log, order };
}

describe("set order", () => {
  it("appends each set at the end of the session's running order", async () => {
    const { log, order } = await ready();
    const first = await log("Push-up");
    await log("Push-up");
    await log("Cable lat pulldown");
    expect(first.set.position).toBe(1);
    expect(await order()).toEqual([
      { exercise_name: "Push-up", set_number: 1, position: 1 },
      { exercise_name: "Push-up", set_number: 2, position: 2 },
      { exercise_name: "Cable lat pulldown", set_number: 1, position: 3 },
    ]);
  });

  it("inserts a set at a position, moving the later sets down", async () => {
    const { log, order } = await ready();
    await log("Push-up");
    await log("Cable lat pulldown");
    const inserted = await log("Dumbbell curl", { position: 2 });
    expect(inserted.set.position).toBe(2);
    expect(await order()).toEqual([
      { exercise_name: "Push-up", set_number: 1, position: 1 },
      { exercise_name: "Dumbbell curl", set_number: 1, position: 2 },
      { exercise_name: "Cable lat pulldown", set_number: 1, position: 3 },
    ]);
  });

  it("refuses a position past the end", async () => {
    const { x, session } = await ready();
    const r = await x.call("log_set", { session_id: session, exercise: "Push-up", reps: 10, rir: 2, load: "none", position: 3 });
    expect(r.body).toMatchObject({ status: "needs_clarification", reason: "position_past_end" });
  });
});
