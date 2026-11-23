// Click test P2-16 (ticket 68): "Log a set" on a future session's card sends
// that card's template, so the set starts that session today (early),
// instead of landing in the session the schedule has for today.
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

// Monday is Upper A by the schedule; Lower A (with the calf raise) is Wednesday's.
const calf = { exercise: "calf raise", reps: 12, rir: 2, load: { value: 10, unit: "kg", basis: "per_leg" } };

describe("log_set and preview_set with a template", () => {
  it("previews and then starts the named programme session today, linking the set to its prescription", async () => {
    const { x, p } = await ready();
    const preview = await x.ok("preview_set", { member: "Hritvik", date: MONDAY, template: "Lower A", ...calf });
    expect(preview.session).toMatchObject({ would_create: true, template: "Lower A" });
    const body = await x.ok("log_set", { member: "Hritvik", date: MONDAY, template: "lower a", ...calf });
    expect(body.session).toMatchObject({ created: true, template: "Lower A" });
    expect(body.set.prescription_id).toBe(p.calf);
    expect(x.t.get("SELECT performed_on, template_id FROM session WHERE id = ?", body.session.id)).toEqual({ performed_on: MONDAY, template_id: p.lower });
    // The next set finds the same session.
    const again = await x.ok("log_set", { member: "Hritvik", date: MONDAY, template: "Lower A", ...calf, reps: 11 });
    expect(again.session).toMatchObject({ id: body.session.id, created: false, template: "Lower A" });
  });

  it("without a template still takes the schedule's session for the day", async () => {
    const { x } = await ready();
    const body = await x.ok("log_set", { member: "Hritvik", date: MONDAY, ...calf });
    expect(body.session).toMatchObject({ created: true, template: "Upper A" });
  });

  it("starts the named session beside a session that day following another, then keeps finding it", async () => {
    const { x, p } = await ready();
    const upper = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper A" })).session.id;
    const early = await x.ok("log_set", { member: "Hritvik", date: MONDAY, template: "Lower A", ...calf });
    expect(early.session).toMatchObject({ created: true, template: "Lower A" });
    expect(early.session.id).not.toBe(upper);
    expect(early.set.prescription_id).toBe(p.calf);
    const next = await x.ok("log_set", { member: "Hritvik", date: MONDAY, template: "Lower A", ...calf, reps: 10 });
    expect(next.session).toMatchObject({ id: early.session.id, created: false, template: "Lower A" });
    expect(next.set.set_number).toBe(2);
    // A plain session that day takes the template, as log_workout's does.
    const y = await ready();
    const plain = (await y.x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength" })).session.id;
    expect((await y.x.ok("log_set", { member: "Hritvik", date: MONDAY, template: "Lower A", ...calf })).session).toMatchObject({ id: plain, template: "Lower A" });
  });

  it("asks about a template the member hasn't got", async () => {
    const { x } = await ready();
    const unknown = await x.call("preview_set", { member: "Hritvik", date: MONDAY, template: "Push Z", ...calf });
    expect(unknown.body).toMatchObject({ status: "needs_clarification", reason: "unknown_template", path: ["template"] });
  });

  it("takes a template only with member and date", async () => {
    const { x } = await ready();
    const session = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength" })).session.id;
    const reply = await x.call("log_set", { session_id: session, template: "Lower A", ...calf });
    expect(reply.body).toMatchObject({ status: "error", error: { code: "session_or_member" } });
  });
});
