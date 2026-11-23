import { describe, expect, it } from "vitest";
import { buildDayClose, closedDayNotice, closeAsk, dayStatusPlan, skippedToSend, unskipPlan } from "../src/dayClose";
import { meals, today } from "./fixtures";

describe("buildDayClose", () => {
  it("offers the meals with nothing logged on your own open day, the skipped ones already on", () => {
    expect(buildDayClose(today())).toEqual({
      status: "open",
      heading: "Close the day",
      text: "When this day's logging is done, close it, so a meal with nothing logged never reads as a low-intake day.",
      meals: [
        { slot: "snack", label: "Snack", skipped: true },
        { slot: "dinner", label: "Dinner", skipped: false },
      ],
    });
  });

  it("words a closed day and its skipped meals", () => {
    expect(buildDayClose(today({ meals: meals({ day_status: "complete" }) }))).toMatchObject({ status: "complete", heading: "Day closed", text: "Closed: everything eaten is logged. Skipped: Snack." });
    expect(buildDayClose(today({ meals: meals({ day_status: "partial" }) }))?.text).toBe("Closed: some of what was eaten isn't logged. Skipped: Snack.");
  });

  it("never offers a meal as skipped while a Tell Claude text for it is waiting, and a closed day still names what the API has skipped (decision 75)", () => {
    const entry = (slot: string) => ({ id: 1, member: "Asha", date: "2026-10-06", meal_slot: slot, text: "poha and chai", spans: [], status: "pending" as const, note: null, created_at: "2026-10-06T03:00:00Z" });
    expect(buildDayClose(today({ waiting: [entry("dinner")] }))?.meals).toEqual([{ slot: "snack", label: "Snack", skipped: true }]);
    const close = buildDayClose(today({ waiting: [entry("snack")] }));
    expect(close?.meals).toEqual([{ slot: "dinner", label: "Dinner", skipped: false }]);
    // Closing again sends only what is offered, so a waiting meal's old skip is cleared by set_day_status.
    expect(skippedToSend(close!, ["snack", "dinner"])).toEqual(["dinner"]);
    expect(buildDayClose(today({ meals: meals({ day_status: "complete" }), waiting: [entry("snack")] }))?.text).toBe("Closed: everything eaten is logged. Skipped: Snack.");
  });

  it("is not offered on another member's day", () => {
    expect(buildDayClose(today({ viewing: "Kabir" }))).toBeNull();
  });
});

describe("skippedToSend", () => {
  it("drops a meal ticked as skipped that has had something logged since, so it is never sent as skipped", () => {
    // The fixture's day offers Snack (skipped) and Dinner; Lunch has food in it.
    const close = buildDayClose(today());
    expect(close).not.toBeNull();
    expect(skippedToSend(close!, ["dinner", "snack", "lunch"])).toEqual(["snack", "dinner"]);
    expect(skippedToSend(close!, ["lunch"])).toEqual([]);
  });
});

describe("dayStatusPlan", () => {
  it("closes with the skipped meals in one write, and reopens without touching them", () => {
    const close = dayStatusPlan("Asha", "2026-10-05", "partial", ["snack", "dinner"]);
    expect(close.steps).toEqual([{ tool: "set_day_status", input: { member: "Asha", date: "2026-10-05", status: "partial", skipped_meals: ["snack", "dinner"], idempotency_key: expect.any(String) } }]);
    expect(close.done).toBe("Day closed.");
    const open = dayStatusPlan("Asha", "2026-10-05", "open", ["snack"]);
    expect(open.steps[0]?.input).not.toHaveProperty("skipped_meals");
    expect(open.done).toBe("Reopened.");
  });
});

describe("unticking a skip the API holds (click test P2-10)", () => {
  it("on an open day, saves the other skips at once, so the meal stops reading skipped; a tick of its own waits for the close", () => {
    const close = buildDayClose(today())!;
    const plan = unskipPlan("Asha", "2026-10-06", close, "snack");
    expect(plan?.steps).toEqual([{ tool: "set_day_status", input: { member: "Asha", date: "2026-10-06", status: "open", skipped_meals: [], idempotency_key: expect.any(String) } }]);
    expect(plan?.done).toBe("Snack is no longer skipped.");
    expect(unskipPlan("Asha", "2026-10-06", close, "dinner")).toBeNull();
  });
});

describe("closing with meals neither logged nor skipped (click test P2-11)", () => {
  it("asks once, naming them; nothing to ask when every offered meal is ticked", () => {
    const close = buildDayClose(today())!;
    expect(closeAsk(close, ["snack"])).toBe("Dinner has nothing logged and isn't marked skipped, so it will read \"not recorded\". Close the day anyway?");
    expect(closeAsk(close, [])).toBe("Snack and Dinner have nothing logged and aren't marked skipped, so they will read \"not recorded\". Close the day anyway?");
    expect(closeAsk(close, ["snack", "dinner"])).toBeNull();
  });
});

describe("logging into a closed day (click test P2-12)", () => {
  it("says the day is closed and stays so, and where to reopen it", () => {
    expect(closedDayNotice("partial", "2026-10-07", "Asha", "Asha")).toBe("Wed 7 Oct is closed: some of it isn't logged. What you log here counts, and the day stays closed; reopen it on Today if more is coming.");
    expect(closedDayNotice("complete", "2026-10-07", "Kabir", "Asha")).toBe("Kabir's Wed 7 Oct is closed: everything is logged. What you log here counts, and the day stays closed.");
    expect(closedDayNotice("open", "2026-10-07", "Asha", "Asha")).toBeNull();
  });
});
