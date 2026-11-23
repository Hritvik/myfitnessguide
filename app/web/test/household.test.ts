import { describe, expect, it } from "vitest";
import { buildHousehold, glanceRows } from "../src/household";
import type { HouseholdOverview } from "../src/types";
import { dalCook } from "./fixtures";

const WHO = { member: "Asha", members: ["Asha", "Kabir", "Noor"], today: "2026-10-06", time: "13:05", time_zone: "Asia/Kolkata" };

function overview(over: Partial<HouseholdOverview> = {}): HouseholdOverview {
  return {
    date: "2026-10-06",
    members: [
      { member: "Asha", you: true, day_status: "open", kcal_left: 406.2, protein_left: 50.8, drafts: { count: 1, oldest: { table: "portion", id: 7, deadline: "2026-10-07T07:30:00Z", waits: null } }, last_session: { date: "2026-10-05", session_type: "strength", template: "Upper A" } },
      { member: "Kabir", you: false, day_status: "complete", kcal_left: -120, protein_left: 12, drafts: { count: 1, oldest: { table: "session_set", id: 9, deadline: null, waits: "end_of_session" } }, last_session: { date: "2026-10-04", session_type: "class", template: null } },
      { member: "Noor", you: false, day_status: "open", kcal_left: null, protein_left: null, drafts: { count: 0, oldest: null }, last_session: null },
    ],
    meals: [{ date: "2026-10-06", cooks: [dalCook({ ask: null })] }],
    leftovers: [{ cook_id: 12, cook: "Rajma", cooked_on: "2026-10-04", component_id: 31, component: null, fraction: 0.3, kcal: 210.4, since: "2026-10-04" }],
    waiting: [{ table: "intake_item", id: 40, about: "Kabir", summary: "Greek yogurt", deadline: "2026-10-08T03:00:00Z", waits: null }],
    ...over,
  };
}

describe("Household", () => {
  it("gives a row per member: what is left, the day, drafts waiting on them, and their last session, linking to their Today", () => {
    const view = buildHousehold(overview(), WHO);
    expect(view.members).toEqual([
      { name: "Asha", you: true, left: "406 kcal and 51 g protein left", status: "Day open", drafts: "1 draft waiting on you; the oldest confirms by itself Wed 13:00.", last: "Last session Mon 5 Oct, Upper A", href: "/" },
      { name: "Kabir", you: false, left: "Over by 120 kcal; 12 g protein left", status: "Day complete", drafts: "1 draft waiting on Kabir; the oldest waits for the end of the session.", last: "Last session Sun 4 Oct, dance", href: "/?member=Kabir" },
      { name: "Noor", you: false, left: "No target set", status: "Day open", drafts: null, last: null, href: "/?member=Noor" },
    ]);
  });

  it("draws the shared meals with the pot card, never with an ask", () => {
    const view = buildHousehold(overview(), WHO);
    expect(view.meals).toHaveLength(1);
    expect(view.meals[0]).toMatchObject({ label: "Tue 6 Oct" });
    expect(view.meals[0]?.pots[0]).toMatchObject({ title: "Masoor dal", ask: null, settle: [] });
  });

  it("lists leftovers with how much and since when, eaten by any member or discarded", () => {
    expect(buildHousehold(overview(), WHO).leftovers).toEqual([
      { componentId: 31, fraction: 0.3, title: "Rajma", amount: "30% of the pot, about 210 kcal", since: "Left over since Sun 4 Oct", eaters: ["Asha", "Kabir", "Noor"], discardable: true },
    ]);
  });

  it("shows a past day's leftovers read-only: no one to mark them eaten, nothing to discard", () => {
    const [row] = buildHousehold(overview({ date: "2026-10-04" }), WHO).leftovers;
    expect(row).toMatchObject({ eaters: [], discardable: false, since: "Left over since Sun 4 Oct" });
  });

  it("lists what you logged for others, read-only", () => {
    expect(buildHousehold(overview(), WHO).waiting).toEqual([{ key: "intake_item:40", text: "Greek yogurt for Kabir: confirms by itself Thu 08:30." }]);
  });

  it("has plain empty states", () => {
    const view = buildHousehold(overview({ meals: [], leftovers: [], waiting: [] }), WHO);
    expect(view).toMatchObject({ meals: [], leftovers: [], waiting: [], empty: { meals: "No shared meals in these three days.", leftovers: "No leftovers.", waiting: "Nothing you logged is waiting." } });
  });

  it("shows a member with no data plainly: no zero for what is unknown", () => {
    const [, , noor] = buildHousehold(overview(), WHO).members;
    expect(noor).toMatchObject({ left: "No target set", drafts: null, last: null });
  });

  it("says a draft with no deadline waits for you on your own row, for them on another's", () => {
    const m = overview().members;
    const none = { count: 1, oldest: { table: "portion", id: 1, deadline: null, waits: null } };
    const view = buildHousehold(overview({ members: [{ ...m[0]!, drafts: none }, { ...m[1]!, drafts: none }] }), WHO);
    expect(view.members[0]?.drafts).toBe("1 draft waiting on you; the oldest waits for you.");
    expect(view.members[1]?.drafts).toBe("1 draft waiting on Kabir; the oldest waits for them.");
  });
});

describe("the household at a glance (Today, wide)", () => {
  it("gives each member what is left and how many drafts wait on them, from household_overview", () => {
    expect(glanceRows(overview())).toEqual([
      { name: "Asha", you: true, left: "406 kcal and 51 g protein left", drafts: "1 draft" },
      { name: "Kabir", you: false, left: "Over by 120 kcal; 12 g protein left", drafts: "1 draft" },
      { name: "Noor", you: false, left: "No target set", drafts: "None" },
    ]);
  });
});

describe("a member's left that leaves out unknown items (ticket 72)", () => {
  const partial = (unknown: { kcal: number; protein: number }, kcal_left = 406.2): HouseholdOverview => ({
    date: "2026-10-06",
    members: [{ member: "Asha", you: true, day_status: "open", kcal_left, protein_left: 50.8, unknown_items: unknown, drafts: { count: 0, oldest: null }, last_session: null }],
    meals: [], leftovers: [], waiting: [],
  });

  it("says at most, with the count, in the table and at a glance", () => {
    expect(buildHousehold(partial({ kcal: 1, protein: 1 }), WHO).members[0]?.left).toBe("At most 406 kcal and at most 51 g protein left · 1 item unknown");
    expect(glanceRows(partial({ kcal: 1, protein: 1 }))[0]?.left).toBe("At most 406 kcal and at most 51 g protein left · 1 item unknown");
  });

  it("says over by at least, when over", () => {
    expect(glanceRows(partial({ kcal: 2, protein: 0 }, -120))[0]?.left).toBe("Over by 120+ kcal; 51 g protein left · 2 items unknown");
  });

  it("reads as before with nothing unknown", () => {
    expect(glanceRows(partial({ kcal: 0, protein: 0 }))[0]?.left).toBe("406 kcal and 51 g protein left");
  });
});
