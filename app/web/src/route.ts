/**
 * The app's routes (spec §3; desktop spec §2): /, /train, /progress,
 * /progress/health and /household, with ?member= and ?date= (and ?range= /
 * ?week= on Progress); and the catalogue: /catalogue (Foods & recipes),
 * /catalogue/food/:ref, /catalogue/recipe/:ref, /catalogue/workouts[/:id],
 * /catalogue/exercises[/:id], /catalogue/gyms[/:id], /catalogue/words and the new-record forms /catalogue/new/food and /catalogue/new/recipe.
 * The agent can link to any of them; anything unknown opens Today, and an
 * unknown catalogue path opens /catalogue. Progress has /progress/nutrition;
 * Train has /train/lifts and /train/lift/:id (any words after the id are
 * cosmetic and ignored); /train/board still opens Train.
 *
 * `Section` is the route's discriminant (the four tabs and the catalogue)
 * for route memory, home routes and page titles; `TABS` stays the phone's
 * four-tab bar, and the sidebar has its own list (shell.ts).
 */
import { isIsoDate } from "./dates";

export type Tab = "today" | "train" | "progress" | "household";
export const TABS: readonly Tab[] = ["today", "train", "progress", "household"];
export type Section = Tab | "catalogue";
export type Range = "4w" | "12w" | "6m" | "1y" | "all";
export const RANGES: readonly Range[] = ["4w", "12w", "6m", "1y", "all"];
export function isRange(value: string | null): value is Range {
  return value !== null && (RANGES as readonly string[]).includes(value);
}
/** The span each period covers, in days; `all` has no fixed span. 6 months is 182 days and a year 365. */
export const RANGE_DAYS: Record<Exclude<Range, "all">, number> = { "4w": 28, "12w": 84, "6m": 182, "1y": 365 };
export type ProgressView = "overview" | "body" | "nutrition" | "health";

export type CatalogueView =
  | { pane: "foods"; record: { kind: "food" | "recipe"; ref: string } | null; creating?: "food" | "recipe" }
  | { pane: "workouts" | "exercises" | "gyms"; id: number | null }
  | { pane: "words" };

/** The panes that open a record by a numeric id (workouts, exercises, gyms). */
export type IdPane = Extract<CatalogueView, { id: number | null }>;

export type Route =
  | { section: "today"; date: string | null }
  | { section: "train"; view: "session" }
  /** `slug` is written by hrefOf and never parsed; `unknown` makes the list explain that no such lift exists. */
  | { section: "train"; view: "lifts"; lift: number | null; slug?: string; unknown?: true }
  | { section: "progress"; view: ProgressView; range: Range; week: string | null }
  | { section: "household"; date: string | null }
  | { section: "catalogue"; view: CatalogueView };

export interface Place {
  route: Route;
  member: string | null;
}

const dateParam = (q: URLSearchParams, key: string): string | null => {
  const v = q.get(key);
  return isIsoDate(v) ? v : null;
};

/** A path segment as written; an undecodable one reads as empty. */
const decoded = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return "";
  }
};

/** A record id in a path: a positive whole number of at most 10 digits. */
const ID = /^[1-9]\d{0,9}$/;

/** /train (Session), /train/lifts and /train/lift/:id[/…] (Lifts). */
function trainRoute(parts: readonly string[]): Route {
  const [, view, arg] = parts;
  if (view === "lifts") return { section: "train", view: "lifts", lift: null };
  if (view === "lift") {
    if (arg === undefined) return { section: "train", view: "lifts", lift: null };
    return ID.test(arg)
      ? { section: "train", view: "lifts", lift: Number(arg) }
      : { section: "train", view: "lifts", lift: null, unknown: true };
  }
  return { section: "train", view: "session" };
}

/** /catalogue's sub-paths; an id is a positive whole number, else the pane's list. */
function catalogueView(parts: readonly string[]): CatalogueView {
  const [, pane, arg] = parts;
  // /catalogue/new/food and /catalogue/new/recipe: the new-record forms.
  if (pane === "new" && (arg === "food" || arg === "recipe")) return { pane: "foods", record: null, creating: arg };
  if ((pane === "food" || pane === "recipe") && arg !== undefined) {
    // A ref stays as written: the API matches refs without case.
    const ref = decoded(arg).trim();
    if (ref !== "") return { pane: "foods", record: { kind: pane, ref } };
  }
  if (pane === "workouts" || pane === "exercises" || pane === "gyms") {
    return { pane, id: arg !== undefined && ID.test(arg) ? Number(arg) : null };
  }
  if (pane === "words") return { pane: "words" };
  return { pane: "foods", record: null };
}

export function parsePlace(pathname: string, search: string): Place {
  const q = new URLSearchParams(search);
  const member = q.get("member") || null;
  const parts = pathname.split("/").filter(Boolean);
  let route: Route;
  switch (parts[0]) {
    case "train":
      route = trainRoute(parts);
      break;
    case "progress": {
      const r = q.get("range");
      const view: ProgressView = parts[1] === "health" ? "health" : parts[1] === "nutrition" ? "nutrition" : parts[1] === "body" ? "body" : "overview";
      route = { section: "progress", view, range: isRange(r) ? r : "12w", week: dateParam(q, "week") };
      break;
    }
    case "household":
      route = { section: "household", date: dateParam(q, "date") };
      break;
    case "catalogue":
      route = { section: "catalogue", view: catalogueView(parts) };
      break;
    default:
      route = { section: "today", date: dateParam(q, "date") };
  }
  return { route, member };
}

/** A catalogue view's path: the ref encoded, a pane's list without an id. */
export function cataloguePath(view: CatalogueView): string {
  switch (view.pane) {
    case "foods":
      if (view.creating && !view.record) return `/catalogue/new/${view.creating}`;
      return view.record ? `/catalogue/${view.record.kind}/${encodeURIComponent(view.record.ref)}` : "/catalogue";
    case "words":
      return "/catalogue/words";
    default:
      return view.id === null ? `/catalogue/${view.pane}` : `/catalogue/${view.pane}/${view.id}`;
  }
}

export function hrefOf(place: Place): string {
  const q = new URLSearchParams();
  let path = "/";
  const r = place.route;
  switch (r.section) {
    case "today":
      if (r.date) q.set("date", r.date);
      break;
    case "train":
      if (r.view === "session") path = "/train";
      else if (r.lift === null) path = "/train/lifts";
      else path = r.slug ? `/train/lift/${r.lift}/${encodeURIComponent(r.slug)}` : `/train/lift/${r.lift}`;
      break;
    case "progress":
      path =
        r.view === "health" ? "/progress/health"
        : r.view === "nutrition" ? "/progress/nutrition"
        : r.view === "body" ? "/progress/body"
        : "/progress";
      if (r.range !== "12w") q.set("range", r.range);
      if (r.week) q.set("week", r.week);
      break;
    case "household":
      path = "/household";
      if (r.date) q.set("date", r.date);
      break;
    case "catalogue":
      path = cataloguePath(r.view);
      break;
  }
  if (place.member) q.set("member", place.member);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export type RouteMemory = Partial<Record<Section, Route>>;

const HOME: Record<Section, Route> = {
  today: { section: "today", date: null },
  train: { section: "train", view: "session" },
  progress: { section: "progress", view: "overview", range: "12w", week: null },
  household: { section: "household", date: null },
  catalogue: { section: "catalogue", view: { pane: "foods", record: null } },
};

/** Each section keeps its sub-page: the last route seen on it. */
export function remember(memory: RouteMemory, route: Route): RouteMemory {
  return { ...memory, [route.section]: route };
}

export function sectionRoute(memory: RouteMemory, section: Section): Route {
  return memory[section] ?? HOME[section];
}

const PANE_TITLE = {
  workouts: ["Workouts", "Workout"],
  exercises: ["Exercises", "Exercise"],
  gyms: ["Gyms & equipment", "Gym"],
} as const;

/**
 * The page's title for a route (the browser tab, history, a shared link):
 * the section's name, Health for its page, and in the catalogue the pane's
 * name or the record's kind; an open record's own name replaces it once
 * loaded (`useTitle`).
 */
export function pageTitle(route: Route): string {
  switch (route.section) {
    case "today":
      return "Today";
    case "train":
      return route.view === "session" ? "Train" : route.lift === null ? "Lifts" : "Lift";
    case "progress":
      return route.view === "health" ? "Health" : route.view === "nutrition" ? "Nutrition" : route.view === "body" ? "Body" : "Progress";
    case "household":
      return "Household";
    case "catalogue": {
      const v = route.view;
      if (v.pane === "foods" && v.creating && !v.record) return v.creating === "food" ? "New food" : "New recipe";
      if (v.pane === "foods") return v.record ? (v.record.kind === "food" ? "Food" : "Recipe") : "Foods & recipes";
      if (v.pane === "words") return "Words I've learned";
      return PANE_TITLE[v.pane][v.id === null ? 0 : 1];
    }
  }
}
