import { describe, expect, it } from "vitest";
import type { Who } from "../src/load";
import { draftNotice, forChips, forDate, forMember, openSheet, setTemplate, ownOnlyNotice, reopenSheet, SHEET_TABS, fabHidden, pickOpener, returnTarget, sheetPlacement, slotForTime, switchTab } from "../src/sheet";

const who = (over: Partial<Who> = {}): Who => ({ member: "Asha", members: ["Asha", "Kabir", "Noor"], today: "2026-10-06", time: "13:05", time_zone: "Asia/Kolkata", ...over }) as Who;

describe("slotForTime", () => {
  it("suggests the meal by the household's clock", () => {
    expect(["06:00", "10:29", "10:30", "14:59", "15:00", "18:29", "18:30", "23:59"].map(slotForTime)).toEqual([
      "breakfast", "breakfast", "lunch", "lunch", "snack", "snack", "dinner", "dinner",
    ]);
  });
});

describe("slotForTime without a usable time", () => {
  it("falls back to breakfast (deploy window: an older API gives no time)", () => {
    expect(slotForTime(undefined)).toBe("breakfast");
    expect(slotForTime("ab:cd")).toBe("breakfast");
    expect(openSheet(who({ time: undefined as never }), { date: null }, { tab: "food" }).slot).toBe("breakfast");
  });
});

describe("a set's template from a later session's card (review P1-1)", () => {
  const fromCard = () => openSheet(who(), { date: null }, { tab: "set", exercise: "Cable row", member: "Asha", template: "Upper A" });
  it("goes with another member or another day: a set for Kabir, or yesterday, never starts Asha's session", () => {
    expect(forMember(fromCard(), "Kabir")).toMatchObject({ forMember: "Kabir", template: null });
    expect(forDate(fromCard(), "2026-10-05")).toMatchObject({ date: "2026-10-05", template: null });
    // Picking the same member or day again keeps it.
    expect(forMember(fromCard(), "Asha").template).toBe("Upper A");
    expect(forDate(fromCard(), "2026-10-06").template).toBe("Upper A");
  });

  it("goes when an owner-only tab sets the member aside", () => {
    const kabir = openSheet(who(), { date: null }, { tab: "set", exercise: "Cable row", member: "Kabir", template: "Upper A" });
    expect(switchTab(who(), kabir, "reading").template).toBeNull();
  });

  it("is sent only for today", () => {
    expect(setTemplate(fromCard(), "2026-10-06")).toBe("Upper A");
    expect(setTemplate({ ...fromCard(), date: "2026-10-05" }, "2026-10-06")).toBeNull();
  });
});

describe("openSheet", () => {
  it("carries a set's template from the session card, and none otherwise (click test P2-16)", () => {
    expect(openSheet(who(), { date: null }, { tab: "set", exercise: "Cable row", template: "Upper A" }).template).toBe("Upper A");
    expect(openSheet(who(), { date: null }, { tab: "set" }).template).toBeNull();
  });

  it("opens for the signed-in member, on today, at the meal the household's clock suggests", () => {
    expect(openSheet(who(), { date: null }, { tab: "food" })).toEqual({ tab: "food", forMember: "Asha", date: "2026-10-06", slot: "lunch", exercise: null, template: null, workoutId: null, metric: null, bodyState: null, heldFor: null });
  });

  it("keeps the day being viewed, so a past day's entry goes to that day", () => {
    expect(openSheet(who(), { date: "2026-10-03" }, { tab: "food" }).date).toBe("2026-10-03");
  });

  it("follows a shortcut's meal, member and exercise", () => {
    expect(openSheet(who(), { date: null }, { tab: "food", slot: "dinner", member: "Kabir" })).toMatchObject({ forMember: "Kabir", slot: "dinner" });
    expect(openSheet(who(), { date: null }, { tab: "set", exercise: "Cable row" })).toMatchObject({ tab: "set", exercise: "Cable row" });
  });

  it("never takes the phone's clock: the slot follows whoami's time whatever the device says", () => {
    expect(openSheet(who({ time: "20:10" }), { date: null }, { tab: "food" }).slot).toBe("dinner");
  });
});

describe("for chips and the draft notice", () => {
  it("marks the member the entry is for, and says another member will confirm it", () => {
    const state = openSheet(who(), { date: null }, { tab: "food", member: "Kabir" });
    expect(forChips(who(), state)).toEqual([
      { name: "Asha", selected: false, you: true },
      { name: "Kabir", selected: true, you: false },
      { name: "Noor", selected: false, you: false },
    ]);
    expect(draftNotice(who(), state)).toBe("Kabir will confirm this.");
    expect(draftNotice(who(), openSheet(who(), { date: null }, { tab: "food" }))).toBeNull();
  });
});

describe("the Reading tab", () => {
  it("sits before Tell Claude", () => {
    expect(SHEET_TABS.map((t) => t.label)).toEqual(["Food", "Workout", "Set", "Reading", "Tell Claude"]);
  });

  it("is always for the signed-in member, whatever the shortcut or the chip said, and carries the cadence's metric and body state", () => {
    expect(openSheet(who(), { date: null }, { tab: "reading", member: "Kabir", metric: "weight", bodyState: "fasted" })).toMatchObject({ tab: "reading", forMember: "Asha", metric: "weight", bodyState: "fasted" });
    const forKabir = openSheet(who(), { date: null }, { tab: "food", member: "Kabir" });
    expect(switchTab(who(), forKabir, "reading").forMember).toBe("Asha");
    expect(switchTab(who(), forKabir, "set")).toEqual({ ...forKabir, tab: "set" });
  });

  it("gives the for member back when you leave the Reading tab", () => {
    const forKabir = openSheet(who(), { date: null }, { tab: "food", member: "Kabir" });
    const reading = switchTab(who(), forKabir, "reading");
    expect(reading).toMatchObject({ tab: "reading", forMember: "Asha", heldFor: "Kabir" });
    expect(switchTab(who(), reading, "food")).toEqual({ ...forKabir, tab: "food" });
    expect(switchTab(who(), reading, "set")).toMatchObject({ tab: "set", forMember: "Kabir", heldFor: null });
    // Opened for yourself, there is nothing to give back.
    const mine = switchTab(who(), openSheet(who(), { date: null }, { tab: "food" }), "reading");
    expect(mine.heldFor).toBeNull();
    expect(switchTab(who(), mine, "food").forMember).toBe("Asha");
  });

  it("says readings are private in place of the for chips, and nothing on the other tabs", () => {
    expect(ownOnlyNotice(openSheet(who(), { date: null }, { tab: "reading" }))).toBe(
      "Readings are private, so you log only your own. For someone else's, tell Claude in chat: it becomes their draft for them to confirm.",
    );
    expect(ownOnlyNotice(openSheet(who(), { date: null }, { tab: "food" }))).toBeNull();
  });
});

describe("where the sheet sits", () => {
  it("is the phone's modal bottom sheet below 1024 px, unchanged", () => {
    expect(sheetPlacement(false)).toEqual({ scrim: "sheet-scrim", modal: true });
  });

  it("is a side panel on a wide screen, not modal, so the day stays usable beside it", () => {
    expect(sheetPlacement(true)).toEqual({ scrim: "sheet-scrim panel", modal: undefined });
  });
});

describe("the + while the panel is open", () => {
  it("is hidden only on a wide screen with the sheet open, never on the phone", () => {
    expect([fabHidden(true, true), fabHidden(true, false), fabHidden(false, true), fabHidden(false, false)]).toEqual([true, false, false, false]);
  });
});

describe("focus back to what opened the sheet", () => {
  const el = (isConnected = true) => ({ isConnected });
  it("prefers the element the handler handed over, even when activeElement is body (Safari, Firefox on macOS)", () => {
    const from = el(), body = el();
    expect(pickOpener(from, body, false, true)).toBe(from);
  });
  it("falls back to a focused control outside the sheet, never body or something inside the sheet", () => {
    const a = el();
    expect(pickOpener(null, a, false, false)).toBe(a);
    expect(pickOpener(null, a, false, true)).toBeNull();
    expect(pickOpener(null, a, true, false)).toBeNull();
  });
  it("falls back to the + when the opener has left the page", () => {
    const gone = el(false), fab = el();
    expect(returnTarget(gone, fab)).toBe(fab);
    expect(returnTarget(null, fab)).toBe(fab);
    const here = el();
    expect(returnTarget(here, fab)).toBe(here);
    expect(returnTarget(gone, null)).toBeNull();
  });
});

// Final review P1-1: a meal's Add, Train, the strip, Progress, N or Shift+N beside the open panel.
describe("opening the + again while the sheet is busy", () => {
  const w = who();
  it("keeps a held Tell Claude send: the same state, so the tab (its Try again and its key) stays mounted", () => {
    const held = openSheet(w, { date: null }, { tab: "text" });
    const next = reopenSheet(held, true, openSheet(w, { date: null }, { tab: "food", slot: "dinner" }));
    expect(next).toBe(held);
    expect(next.tab).toBe("text");
  });
  it("keeps a held or in-flight Food plan when asked to open on another tab", () => {
    const food = { ...openSheet(w, { date: null }, { tab: "food", slot: "lunch" }), forMember: "Kabir" };
    for (const target of [{ tab: "workout" as const }, { tab: "text" as const }, { tab: "food" as const, slot: "dinner" as const }]) {
      expect(reopenSheet(food, true, openSheet(w, { date: null }, target))).toBe(food);
    }
  });
  it("opens on the new target when the sheet is open and idle, or closed", () => {
    const idle = openSheet(w, { date: null }, { tab: "text" });
    const food = openSheet(w, { date: null }, { tab: "food", slot: "dinner" });
    expect(reopenSheet(idle, false, food)).toBe(food);
    expect(reopenSheet(null, false, food)).toBe(food);
    expect(reopenSheet(null, true, food)).toBe(food);
  });
});
