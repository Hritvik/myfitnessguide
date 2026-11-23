// Feedback about the app: sent from any screen, seen by its sender and the
// agent, triaged by them.
import { describe, expect, it } from "vitest";
import { seedGym, toolWithinBudget } from "./budget";
import { setup } from "./harness";

const context = { route: "/?date=2026-10-04", date: "2026-10-04", version: "a1b2c3d", viewport: "phone", at: "2026-10-05T07:29:00Z" };

describe("feedback", () => {
  it("stores a member's feedback with its context, new", async () => {
    const x = setup();
    const body = await x.ok("submit_feedback", { type: "confusing", text: "Which button saves the meal?", context, idempotency_key: "fb-1" }, "asha");
    expect(body.feedback).toEqual({ id: expect.any(Number), member: "Asha", type: "confusing", text: "Which button saves the meal?", context, status: "new", note: null, created_at: "2026-10-05T07:30:00Z" });
  });

  it("shows a member only their own, and the agent everyone's", async () => {
    const x = setup();
    await x.ok("submit_feedback", { type: "bug", text: "The sheet jumped", context, idempotency_key: "fb-1" }, "asha");
    await x.ok("submit_feedback", { type: "idea", text: "Weekly view of protein", context, idempotency_key: "fb-2" }, "hritvik");
    expect((await x.ok("feedback_list", {}, "asha")).feedback.map((f: { member: string }) => f.member)).toEqual(["Asha"]);
    expect((await x.ok("feedback_list", {})).feedback.map((f: { member: string }) => f.member).sort()).toEqual(["Asha", "Hritvik"]);
    expect((await x.ok("feedback_list", { status: "done" })).feedback).toEqual([]);
  });

  it("is triaged with a note by the agent or its sender, and by nobody else", async () => {
    const x = setup();
    const f = (await x.ok("submit_feedback", { type: "bug", text: "The sheet jumped", context, idempotency_key: "fb-1" }, "asha")).feedback;
    expect((await x.call("triage_feedback", { id: f.id, status: "ticketed", note: "map ticket 40", idempotency_key: "t-0" }, "hritvik")).body.error.code).toBe("not_yours");
    expect((await x.call("history", { table: "feedback", id: f.id }, "hritvik")).body.error.code).toBe("not_visible");
    expect((await x.ok("history", { table: "feedback", id: f.id }, "asha")).versions).toBeDefined();
    expect((await x.ok("history", { table: "feedback", id: f.id })).versions).toBeDefined();
    expect((await x.ok("triage_feedback", { id: f.id, status: "ticketed", note: "map ticket 40", idempotency_key: "t-1", speaker: "Hritvik" })).feedback).toMatchObject({ status: "ticketed", note: "map ticket 40" });
    expect((await x.ok("triage_feedback", { id: f.id, status: "done", note: "fixed in the sheet", idempotency_key: "t-2" }, "asha")).feedback.status).toBe("done");
    expect((await x.ok("feedback_list", { status: "done" }, "asha")).feedback).toHaveLength(1);
  });

  it("takes feedback from the agent for the member it is talking with", async () => {
    const x = setup();
    expect((await x.ok("submit_feedback", { type: "idea", text: "Ask about water too", idempotency_key: "fb-1", speaker: "Hritvik" })).feedback).toMatchObject({ member: "Hritvik", context: {} });
  });

  it("stays within the budget", async () => {
    const x = setup();
    seedGym(x, 40);
    await toolWithinBudget(x, "submit_feedback", { type: "idea", text: "t", context, idempotency_key: "fb-b" }, "hritvik", 30);
    await toolWithinBudget(x, "feedback_list", {});
    await toolWithinBudget(x, "triage_feedback", { id: 1, status: "discussed", note: "n", idempotency_key: "fb-t" }, "hritvik", 30);
  });
});
