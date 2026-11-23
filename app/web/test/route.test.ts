import { describe, expect, it } from "vitest";
import { cataloguePath, hrefOf, pageTitle, parsePlace, remember, sectionRoute } from "../src/route";

describe("parsePlace", () => {
  it("reads Today with a date and a member", () => {
    expect(parsePlace("/", "?date=2026-09-28&member=Kabir")).toEqual({ route: { section: "today", date: "2026-09-28" }, member: "Kabir" });
  });

  it("ignores a date that isn't a real date", () => {
    expect(parsePlace("/", "?date=2026-02-30").route).toEqual({ section: "today", date: null });
  });

  it("reads Progress and Health with the range (12 weeks by default) and the week", () => {
    expect(parsePlace("/progress", "").route).toEqual({ section: "progress", view: "overview", range: "12w", week: null });
    expect(parsePlace("/progress/health", "?range=all").route).toEqual({ section: "progress", view: "health", range: "all", week: null });
    expect(parsePlace("/progress", "?week=2026-09-20&range=4w").route).toEqual({ section: "progress", view: "overview", range: "4w", week: "2026-09-20" });
  });

  it("reads the five periods the spec names (4w, 12w, 6m, 1y, all), falling back to 12 weeks", () => {
    for (const range of ["4w", "12w", "6m", "1y", "all"]) {
      expect(parsePlace("/progress", `?range=${range}`).route).toEqual({ section: "progress", view: "overview", range, week: null });
    }
    expect(parsePlace("/progress", "?range=8w").route).toEqual({ section: "progress", view: "overview", range: "12w", week: null });
  });

  it("reads the Body drill-down of the Progress summary", () => {
    expect(parsePlace("/progress/body", "").route).toEqual({ section: "progress", view: "body", range: "12w", week: null });
    expect(parsePlace("/progress/body", "?range=6m").route).toEqual({ section: "progress", view: "body", range: "6m", week: null });
  });

  it("opens Train's Session view, Household with a date, and Today for anything unknown", () => {
    expect(parsePlace("/train", "").route).toEqual({ section: "train", view: "session" });
    expect(parsePlace("/train/board", "").route).toEqual({ section: "train", view: "session" });
    expect(parsePlace("/household", "?date=2026-10-05").route).toEqual({ section: "household", date: "2026-10-05" });
    expect(parsePlace("/nope", "").route).toEqual({ section: "today", date: null });
  });

  it("reads every catalogue route", () => {
    const view = (path: string) => parsePlace(path, "").route;
    expect(view("/catalogue")).toEqual({ section: "catalogue", view: { pane: "foods", record: null } });
    expect(view("/catalogue/food/FS041")).toEqual({ section: "catalogue", view: { pane: "foods", record: { kind: "food", ref: "FS041" } } });
    expect(view("/catalogue/recipe/R014")).toEqual({ section: "catalogue", view: { pane: "foods", record: { kind: "recipe", ref: "R014" } } });
    expect(view("/catalogue/workouts")).toEqual({ section: "catalogue", view: { pane: "workouts", id: null } });
    expect(view("/catalogue/workouts/3")).toEqual({ section: "catalogue", view: { pane: "workouts", id: 3 } });
    expect(view("/catalogue/exercises/12")).toEqual({ section: "catalogue", view: { pane: "exercises", id: 12 } });
    expect(view("/catalogue/gyms/1")).toEqual({ section: "catalogue", view: { pane: "gyms", id: 1 } });
    expect(view("/catalogue/words")).toEqual({ section: "catalogue", view: { pane: "words" } });
  });

  // Review Focus 3: links typed or shared by hand.
  it("keeps a ref as written, decodes it, and opens a pane's list (or /catalogue) for anything it can't read", () => {
    const view = (path: string) => (parsePlace(path, "").route as { view: unknown }).view;
    expect(view("/catalogue/food/fs041")).toEqual({ pane: "foods", record: { kind: "food", ref: "fs041" } });
    expect(view("/catalogue/food/FS%20041")).toEqual({ pane: "foods", record: { kind: "food", ref: "FS 041" } });
    expect(view("/catalogue/food/%E0%A4")).toEqual({ pane: "foods", record: null });
    expect(view("/catalogue/food/")).toEqual({ pane: "foods", record: null });
    expect(view("/catalogue/food/%20")).toEqual({ pane: "foods", record: null });
    expect(view("/catalogue/workouts/abc")).toEqual({ pane: "workouts", id: null });
    expect(view("/catalogue/gyms/0")).toEqual({ pane: "gyms", id: null });
    expect(view("/catalogue/gyms/1.5")).toEqual({ pane: "gyms", id: null });
    expect(view("/catalogue/words/")).toEqual({ pane: "words" });
    expect(view("/catalogue/nowhere/7")).toEqual({ pane: "foods", record: null });
  });
});

describe("hrefOf", () => {
  it("round-trips, leaving defaults out", () => {
    for (const url of [
      "/", "/?date=2026-09-28", "/train", "/progress", "/progress/health?range=all", "/progress/body?range=6m", "/progress?range=1y", "/progress?week=2026-09-20", "/household?member=Noor",
      "/catalogue", "/catalogue/food/FS041", "/catalogue/recipe/R014", "/catalogue/workouts", "/catalogue/workouts/3", "/catalogue/exercises/12", "/catalogue/gyms", "/catalogue/words",
    ]) {
      const [path, search = ""] = url.split("?");
      expect(hrefOf(parsePlace(path as string, search ? `?${search}` : ""))).toBe(url);
    }
  });

  it("encodes a ref in the path", () => {
    expect(cataloguePath({ pane: "foods", record: { kind: "food", ref: "FS 041" } })).toBe("/catalogue/food/FS%20041");
  });
});

describe("section memory", () => {
  it("returns to a section's last sub-page, and to its home before any visit", () => {
    let memory = remember({}, { section: "progress", view: "health", range: "12w", week: null });
    memory = remember(memory, { section: "today", date: "2026-10-01" });
    memory = remember(memory, { section: "catalogue", view: { pane: "gyms", id: 1 } });
    expect(sectionRoute(memory, "progress")).toEqual({ section: "progress", view: "health", range: "12w", week: null });
    expect(sectionRoute(memory, "train")).toEqual({ section: "train", view: "session" });
    expect(sectionRoute(memory, "catalogue")).toEqual({ section: "catalogue", view: { pane: "gyms", id: 1 } });
    expect(sectionRoute({}, "catalogue")).toEqual({ section: "catalogue", view: { pane: "foods", record: null } });
  });
});

describe("charts routes (spec §7)", () => {
  it("reads Nutrition with its range and member, and writes it back", () => {
    expect(parsePlace("/progress/nutrition", "?range=4w&member=Kabir")).toEqual({ route: { section: "progress", view: "nutrition", range: "4w", week: null }, member: "Kabir" });
    expect(hrefOf({ route: { section: "progress", view: "nutrition", range: "12w", week: null }, member: "Kabir" })).toBe("/progress/nutrition?member=Kabir");
  });

  it("reads the lift list and a lift by id; any words after the id are ignored", () => {
    expect(parsePlace("/train/lifts", "").route).toEqual({ section: "train", view: "lifts", lift: null });
    expect(parsePlace("/train/lift/12", "").route).toEqual({ section: "train", view: "lifts", lift: 12 });
    for (const path of ["/train/lift/12/any-words", "/train/lift/12/", "/train/lift/12/Bench%20Press", "/train/lift/12/a/b"]) {
      expect(parsePlace(path, "").route, path).toEqual({ section: "train", view: "lifts", lift: 12 });
    }
    expect(parsePlace("/train/lift/9999999999", "").route).toEqual({ section: "train", view: "lifts", lift: 9999999999 });
  });

  it("shows the list, saying there is no such lift, for a lift segment that isn't an id", () => {
    for (const path of ["/train/lift/hack-squat", "/train/lift/0", "/train/lift/12abc", "/train/lift/99999999999", "/train/lift/-3"]) {
      expect(parsePlace(path, "").route, path).toEqual({ section: "train", view: "lifts", lift: null, unknown: true });
    }
    expect(parsePlace("/train/lift", "").route).toEqual({ section: "train", view: "lifts", lift: null });
  });

  it("writes a lift's link with its cosmetic slug, the list's, and Train's", () => {
    expect(hrefOf({ route: { section: "train", view: "lifts", lift: 12, slug: "barbell-bench-press" }, member: null })).toBe("/train/lift/12/barbell-bench-press");
    expect(hrefOf({ route: { section: "train", view: "lifts", lift: 12 }, member: "Kabir" })).toBe("/train/lift/12?member=Kabir");
    expect(hrefOf({ route: { section: "train", view: "lifts", lift: null }, member: null })).toBe("/train/lifts");
    expect(hrefOf({ route: { section: "train", view: "session" }, member: null })).toBe("/train");
  });

  it("titles Nutrition, Lifts and a lift", () => {
    expect(pageTitle({ section: "progress", view: "nutrition", range: "12w", week: null })).toBe("Nutrition");
    expect(pageTitle({ section: "train", view: "lifts", lift: null })).toBe("Lifts");
    expect(pageTitle({ section: "train", view: "lifts", lift: 12 })).toBe("Lift");
    expect(pageTitle({ section: "train", view: "session" })).toBe("Train");
  });

  it("remembers Lifts for Train and Nutrition for Progress; Train's home is Session", () => {
    let memory = remember({}, { section: "train", view: "lifts", lift: 12 });
    memory = remember(memory, { section: "progress", view: "nutrition", range: "4w", week: null });
    expect(sectionRoute(memory, "train")).toEqual({ section: "train", view: "lifts", lift: 12 });
    expect(sectionRoute(memory, "progress")).toEqual({ section: "progress", view: "nutrition", range: "4w", week: null });
    expect(sectionRoute({}, "train")).toEqual({ section: "train", view: "session" });
  });
});

describe("the page title", () => {
  it("names the route's page, never a static Today", () => {
    const title = (path: string) => pageTitle(parsePlace(path, "").route);
    expect(["/", "/train", "/progress", "/progress/body", "/progress/health", "/household", "/nowhere"].map(title)).toEqual(["Today", "Train", "Progress", "Body", "Health", "Household", "Today"]);
    expect(pageTitle(parsePlace("/progress", "?range=4w&member=Asha").route)).toBe("Progress");
  });

  it("names each catalogue page; a record's own name replaces it once loaded", () => {
    const title = (path: string) => pageTitle(parsePlace(path, "").route);
    expect(["/catalogue", "/catalogue/food/FS041", "/catalogue/recipe/R014", "/catalogue/workouts", "/catalogue/workouts/3", "/catalogue/exercises", "/catalogue/exercises/2", "/catalogue/gyms", "/catalogue/gyms/1", "/catalogue/words"].map(title)).toEqual([
      "Foods & recipes", "Food", "Recipe", "Workouts", "Workout", "Exercises", "Exercise", "Gyms & equipment", "Gym", "Words I've learned",
    ]);
  });
});

describe("the new-record forms in the route", () => {
  it("round-trip /catalogue/new/food and /catalogue/new/recipe, and leave on any other path", () => {
    for (const kind of ["food", "recipe"] as const) {
      const place = parsePlace(`/catalogue/new/${kind}`, "");
      expect(place.route).toEqual({ section: "catalogue", view: { pane: "foods", record: null, creating: kind } });
      expect(place.route.section === "catalogue" && cataloguePath(place.route.view)).toBe(`/catalogue/new/${kind}`);
    }
    expect(pageTitle(parsePlace("/catalogue/new/recipe", "").route)).toBe("New recipe");
    expect(parsePlace("/catalogue/new/other", "").route).toEqual({ section: "catalogue", view: { pane: "foods", record: null } });
    expect(parsePlace("/catalogue/food/FS001", "").route).toEqual({ section: "catalogue", view: { pane: "foods", record: { kind: "food", ref: "FS001" } } });
  });
});
