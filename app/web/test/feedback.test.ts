import { describe, expect, it } from "vitest";
import { feedbackContext, feedbackPlan } from "../src/feedback";

describe("feedback", () => {
  it("attaches the route, the day viewed, the version, phone or desktop, and the time", () => {
    const now = new Date("2026-10-06T08:15:00Z");
    expect(feedbackContext({ path: "/train", search: "?member=Kabir", date: null, version: "a1b2c3d", width: 390, now })).toEqual({ route: "/train?member=Kabir", date: null, version: "a1b2c3d", viewport: "phone", at: "2026-10-06T08:15:00.000Z" });
    expect(feedbackContext({ path: "/", search: "", date: "2026-10-04", version: "a1b2c3d", width: 1280, now }).viewport).toBe("desktop");
  });

  it("caps the route at the Worker's 300 characters", () => {
    const route = feedbackContext({ path: "/", search: `?q=${"x".repeat(500)}`, date: null, version: "v", width: 390, now: new Date("2026-10-06T08:15:00Z") }).route as string;
    expect(route).toHaveLength(300);
  });

  it("sends one submit_feedback, and needs some words", () => {
    expect(feedbackPlan("confusing", "  ", {})).toEqual({ error: "Say what happened, or what you'd like." });
    const plan = feedbackPlan("bug", "The sheet jumped", { route: "/" });
    expect("steps" in plan && plan.steps[0]).toEqual({ tool: "submit_feedback", input: { type: "bug", text: "The sheet jumped", context: { route: "/" }, idempotency_key: expect.any(String) } });
  });
});
