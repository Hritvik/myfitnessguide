// set_day_status is the member's own call, or the agent's (Hritvik, 7 Oct
// 2026): a member can't close another member's day. Every existing caller
// (the skills and the importer as the agent, the app on your own day) is
// unaffected.
import { describe, expect, it } from "vitest";
import { seedGym, toolWithinBudget } from "./budget";
import { setup } from "./harness";

const DAY = "2026-10-04";
const close = (member: string, skipped_meals = ["breakfast"]) => ({ member, date: DAY, status: "partial", skipped_meals });
const EVERY_MEAL = ["breakfast", "lunch", "snack", "dinner", "pre_workout", "post_workout"];

describe("set_day_status: whose day", () => {
  it("lets a member set their own day", async () => {
    const x = setup();
    expect(await x.ok("set_day_status", close("Hritvik"), "hritvik")).toMatchObject({ member: "Hritvik", date: DAY, status_set: "partial", skipped_meals: ["breakfast"] });
  });

  it("lets the agent set any member's day, as the skills and the importer do", async () => {
    const x = setup();
    expect(await x.ok("set_day_status", close("Asha"))).toMatchObject({ member: "Asha", status_set: "partial" });
    expect((await x.ok("day_meals", { member: "Asha", date: DAY }, "asha")).day_status).toBe("partial");
  });

  it("refuses a member's call about another member's day, writing nothing", async () => {
    const x = setup();
    const reply = await x.call("set_day_status", close("Asha"), "hritvik");
    expect(reply.http).toBe(403);
    expect(reply.body.error.code).toBe("not_visible");
    expect(x.t.get("SELECT count(*) AS n FROM day_status WHERE member_id = ?", x.h.asha)).toEqual({ n: 0 });
    expect(x.t.get("SELECT count(*) AS n FROM skipped_meal WHERE member_id = ?", x.h.asha)).toEqual({ n: 0 });
  });

  it("stays within the budget: your own day and the agent's, every meal skipped", async () => {
    const x = setup();
    seedGym(x, 40);
    await toolWithinBudget(x, "set_day_status", close("Hritvik", EVERY_MEAL), "hritvik");
    await toolWithinBudget(x, "set_day_status", close("Asha", EVERY_MEAL));
  });
});
