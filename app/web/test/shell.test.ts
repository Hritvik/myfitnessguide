import { describe, expect, it } from "vitest";
import { parsePlace } from "../src/route";
import { buildShell, buildSidebar, catalogueMenuHref, TOP_MENU_LINKS, topMenuLinks } from "../src/shell";

const who = { member: "Asha", members: ["Asha", "Kabir", "Noor"], today: "2026-10-06", time: "13:05", time_zone: "Asia/Kolkata" };

describe("the tab bar", () => {
  it("has four labelled tabs, the current one active, each keeping the member", () => {
    const shell = buildShell(who, parsePlace("/train", "?member=Kabir"), {});
    expect(shell.tabs.map((t) => [t.label, t.active, t.href])).toEqual([
      ["Today", false, "/?member=Kabir"],
      ["Train", true, "/train?member=Kabir"],
      ["Progress", false, "/progress?member=Kabir"],
      ["Household", false, "/household?member=Kabir"],
    ]);
  });

  it("sends a tab back to its last sub-page", () => {
    const shell = buildShell(who, parsePlace("/", ""), { progress: { section: "progress", view: "health", range: "all", week: null } });
    expect(shell.tabs.find((t) => t.tab === "progress")?.href).toBe("/progress/health?range=all");
  });
});

describe("the member bar", () => {
  it("defaults to the signed-in member, listed first and marked as you", () => {
    const shell = buildShell(who, parsePlace("/", ""), {});
    expect(shell.viewing).toBe("Asha");
    expect(shell.ownView).toBe(true);
    expect(shell.pills.map((p) => [p.name, p.selected, p.isMe, p.href])).toEqual([
      ["Asha", true, true, "/"],
      ["Kabir", false, false, "/?member=Kabir"],
      ["Noor", false, false, "/?member=Noor"],
    ]);
  });

  it("keeps the route when switching member, and ignores a name that isn't a member", () => {
    expect(buildShell(who, parsePlace("/", "?date=2026-10-01"), {}).pills[1]?.href).toBe("/?date=2026-10-01&member=Kabir");
    expect(buildShell(who, parsePlace("/", "?member=Stranger"), {}).viewing).toBe("Asha");
  });
});

describe("Progress privacy follows the view", () => {
  it("keeps Trajectory and Health owner-only while Nutrition is household-visible", () => {
    expect(buildShell(who, parsePlace("/progress", ""), {}).progress).toEqual({ private: false });
    expect(buildShell(who, parsePlace("/progress", "?member=Kabir"), {}).progress).toEqual({ private: true, message: "Progress is private to Kabir." });
    expect(buildShell(who, parsePlace("/progress/health", "?member=Kabir"), {}).progress).toEqual({ private: true, message: "Health is private to Kabir." });
    expect(buildShell(who, parsePlace("/progress/nutrition", "?member=Kabir"), {}).progress).toEqual({ private: false });
  });
});

describe("the sidebar", () => {
  it("lists the four sections, then the catalogue's five, the current one active", () => {
    const side = buildSidebar(who, parsePlace("/catalogue/gyms/1", ""), {});
    expect(side.main.map((l) => [l.label, l.active, l.href])).toEqual([
      ["Today", false, "/"],
      ["Train", false, "/train"],
      ["Progress", false, "/progress"],
      ["Household", false, "/household"],
    ]);
    expect(side.catalogue.map((l) => [l.label, l.active, l.href])).toEqual([
      ["Foods & recipes", false, "/catalogue"],
      ["Workouts", false, "/catalogue/workouts"],
      ["Exercises", false, "/catalogue/exercises"],
      ["Gyms & equipment", true, "/catalogue/gyms/1"],
      ["Words I've learned", false, "/catalogue/words"],
    ]);
  });

  it("sends a catalogue link back to the record last open in its pane, and keeps the member on the four sections", () => {
    const memory = { catalogue: { section: "catalogue" as const, view: { pane: "foods" as const, record: { kind: "food" as const, ref: "FS007" } } } };
    const side = buildSidebar(who, parsePlace("/train", "?member=Kabir"), memory);
    expect(side.catalogue[0]?.href).toBe("/catalogue/food/FS007");
    expect(side.main[1]).toMatchObject({ label: "Train", active: true, href: "/train?member=Kabir" });
  });
});

describe("the catalogue on the phone", () => {
  it("is reached from the top menu: the record last open, else Foods & recipes, with no member", () => {
    expect(catalogueMenuHref({})).toBe("/catalogue");
    const memory = { catalogue: { section: "catalogue" as const, view: { pane: "foods" as const, record: { kind: "food" as const, ref: "FS007" } } } };
    expect(catalogueMenuHref(memory)).toBe("/catalogue/food/FS007");
    expect(parsePlace(catalogueMenuHref({}), "").route).toMatchObject({ section: "catalogue" });
  });

  it("is left by the tab bar, which stays: four sections, none active, each a real link out", () => {
    const shell = buildShell(who, parsePlace("/catalogue", ""), {});
    expect(shell.tabs.map((t) => [t.label, t.active, t.href])).toEqual([
      ["Today", false, "/"],
      ["Train", false, "/train"],
      ["Progress", false, "/progress"],
      ["Household", false, "/household"],
    ]);
  });
});

describe("the top menu", () => {
  it("links to the catalogue and to the words screen; feedback stays its own sheet", () => {
    expect(TOP_MENU_LINKS).toEqual([
      { label: "Catalogue", href: "/catalogue" },
      { label: "What I've learned", href: "/catalogue/words" },
    ]);
  });

  it("keeps the Catalogue entry on the record last open, as the sidebar does", () => {
    const memory = { catalogue: { section: "catalogue" as const, view: { pane: "foods" as const, record: { kind: "food" as const, ref: "FS007" } } } };
    expect(topMenuLinks(memory)).toEqual([
      { label: "Catalogue", href: "/catalogue/food/FS007" },
      { label: "What I've learned", href: "/catalogue/words" },
    ]);
    expect(topMenuLinks({})).toEqual(TOP_MENU_LINKS);
  });
});
