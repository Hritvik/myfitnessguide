import { describe, expect, it } from "vitest";
import { arrange, CATALOGUE, CATALOGUE_PARTS, HEALTH_PARTS, HOUSEHOLD_PARTS, PROGRESS_PARTS, TODAY, TODAY_PARTS, TRAIN, TRAIN_PARTS, TWO, type Layout, type PartSpec } from "../src/layout";

/** Every part of a screen is "full" or on one of its layout's regions. */
const fits = (specs: readonly PartSpec[], layout: Layout) => specs.every((s) => s.side === "full" || layout.regions.includes(s.side));

describe("arrange", () => {
  const specs: PartSpec[] = [
    { key: "a", side: "full" },
    { key: "b", side: "left" },
    { key: "c", side: "right" },
    { key: "d", side: "left" },
    { key: "e", side: "right", only: "wide" },
    { key: "f", side: "full", only: "phone" },
  ];

  it("stacks every part in the declared order on the phone, leaving wide-only parts out", () => {
    expect(arrange(specs, false)).toEqual({ wide: false, stack: ["a", "b", "c", "d", "f"] });
  });

  it("puts full-width parts first and the rest in TWO's left and right on a wide screen, leaving phone-only parts out", () => {
    expect(arrange(specs, true)).toEqual({ wide: true, full: ["a"], regions: { left: ["b", "d"], right: ["c", "e"] } });
    expect(arrange(specs, true, TWO)).toEqual(arrange(specs, true));
  });

  it("moves a part after its named anchor on a wide screen only, by key", () => {
    const moved: PartSpec[] = [{ key: "x", side: "right", wideAfter: ["z"] }, { key: "y", side: "right" }, { key: "z", side: "right" }];
    expect(arrange(moved, true)).toMatchObject({ regions: { right: ["y", "z", "x"] } });
    expect(arrange(moved, false)).toMatchObject({ stack: ["x", "y", "z"] });
  });

  it("resolves an anchor that is itself a later-declared mover, and keeps a cycle in its declared places", () => {
    const fwd: PartSpec[] = [{ key: "a", side: "left", wideAfter: ["b"] }, { key: "b", side: "left", wideAfter: ["c"] }, { key: "c", side: "left" }, { key: "d", side: "left" }];
    expect(arrange(fwd, true)).toMatchObject({ regions: { left: ["c", "b", "a", "d"] } });
    const cycle: PartSpec[] = [{ key: "a", side: "left", wideAfter: ["b"] }, { key: "b", side: "left", wideAfter: ["a"] }, { key: "c", side: "left" }];
    expect(arrange(cycle, true)).toMatchObject({ regions: { left: ["c", "a", "b"] } });
  });

  it("keeps the move when an optional part is absent: the next present anchor is used, else the declared place", () => {
    const parts = (present: string[]) => PROGRESS_PARTS.filter((s) => !["chart", "weight", "headline"].includes(s.key) || present.includes(s.key));
    expect(arrange(parts(["headline", "chart", "weight"]), true)).toMatchObject({ regions: { left: ["headline", "chart", "weight", "log", "drafts"] } });
    expect(arrange(parts(["headline", "chart"]), true)).toMatchObject({ regions: { left: ["headline", "chart", "log", "drafts"] } });
    expect(arrange(parts([]), true)).toMatchObject({ regions: { left: ["log", "drafts"] } });
    expect(arrange(HOUSEHOLD_PARTS.filter((s) => s.key !== "others"), true)).toMatchObject({ regions: { right: ["waiting-you", "leftovers"] } });
  });

  it("puts each part in its layout's region, every region named, and leaves the phone's order alone", () => {
    const three: Layout = { name: "three", regions: ["x", "y", "z"] };
    const parts: PartSpec[] = [{ key: "a", side: "z" }, { key: "b", side: "full" }, { key: "c", side: "x" }];
    expect(arrange(parts, true, three)).toEqual({ wide: true, full: ["b"], regions: { x: ["c"], y: [], z: ["a"] } });
    expect(arrange(parts, false, three)).toEqual({ wide: false, stack: ["a", "b", "c"] });
  });

  it("refuses a part on a region its layout doesn't have", () => {
    expect(() => arrange([{ key: "a", side: "left" }], true, { name: "three", regions: ["x"] })).toThrow('Part "a" is on "left", which is not a region of the three layout.');
  });
});

describe("Today's parts", () => {
  it("keep the phone's order exactly, with the household only on a wide screen", () => {
    expect(arrange(TODAY_PARTS, false)).toEqual({ wide: false, stack: ["offline", "top", "strip", "left", "macros", "pots", "tiers", "close", "footer"] });
    expect(arrange(TODAY_PARTS, true, TODAY)).toEqual({
      wide: true,
      full: ["offline", "top", "strip"],
      regions: { rail: ["left", "macros"], meals: ["tiers"], tail: ["close", "footer"], house: ["pots", "glance"] },
    });
    expect(fits(TODAY_PARTS, TODAY)).toBe(true);
  });
});

describe("each tab's parts", () => {
  it("keep each phone screen's order exactly", () => {
    expect(arrange(TRAIN_PARTS, false)).toMatchObject({ stack: ["top", "message", "policy", "gaps", "rows", "question", "history"] });
    expect(arrange(PROGRESS_PARTS, false)).toMatchObject({ stack: ["top", "headline", "log", "drafts", "chart", "weight", "context", "recent", "week", "health"] });
    expect(arrange(HEALTH_PARTS, false)).toMatchObject({ stack: ["top", "overview", "drafts", "out", "gaps", "flags", "panels", "draws"] });
    expect(arrange(HOUSEHOLD_PARTS, false)).toMatchObject({ stack: ["top", "people", "waiting-you", "meals", "leftovers", "others"] });
  });

  it("place each wide screen's columns as the desktop spec lays them out", () => {
    expect(arrange(TRAIN_PARTS, true, TRAIN)).toEqual({ wide: true, full: ["top"], regions: { next: ["message", "policy", "gaps", "rows", "question"], list: ["history"], open: ["open"] } });
    expect(arrange(PROGRESS_PARTS, true)).toEqual({ wide: true, full: ["title"], regions: { left: ["headline", "chart", "weight", "log", "drafts"], right: ["context", "ranges", "readings", "recent", "week", "health"] } });
    expect(arrange(HEALTH_PARTS, true)).toEqual({ wide: true, full: ["top", "overview"], regions: { left: ["out", "gaps", "flags", "panels"], right: ["drafts", "draws"] } });
    expect(arrange(HOUSEHOLD_PARTS, true)).toEqual({ wide: true, full: ["top", "people"], regions: { left: ["meals"], right: ["waiting-you", "others", "leftovers"] } });
  });

  it("put the catalogue's list, then its record, in their own regions", () => {
    expect(arrange(CATALOGUE_PARTS, true, CATALOGUE)).toEqual({ wide: true, full: [], regions: { list: ["list"], record: ["record"] } });
    expect(fits(CATALOGUE_PARTS, CATALOGUE)).toBe(true);
  });

  it("sit on their layouts' regions", () => {
    for (const parts of [PROGRESS_PARTS, HEALTH_PARTS, HOUSEHOLD_PARTS]) expect(fits(parts, TWO)).toBe(true);
    expect(fits(TODAY_PARTS, TODAY)).toBe(true);
    expect(fits(TRAIN_PARTS, TRAIN)).toBe(true);
    expect(fits(CATALOGUE_PARTS, CATALOGUE)).toBe(true);
  });
});
