/**
 * Each screen's parts (desktop spec §2; wide-layout spec §4): declared once,
 * in the phone's order, each on a side for the wide layout: "full", or a
 * region of the screen's `Layout`. The phone stacks them in that order (its
 * DOM is exactly the screen's as it was); the wide layout puts the
 * full-width parts first, then the layout's regions. A part only one layout
 * shows says so; `wideAfter` moves a part, on the wide layout only, to just
 * after the first of the named parts that is present (by key, so an absent
 * optional part never shifts it); none present leaves it in its declared
 * place.
 */

/** The space steps a layout rule may use (wide-layout spec §2): the --gap-* tokens on :root. */
export type Gap = 4 | 8 | 12 | 16 | 20 | 24 | 32;

/** A card's narrowest width (layout-system.md:54): needs-you 300; prescription and record section 340; meal tier 380; chart 480. */
export type CardMin = 300 | 340 | 380 | 480;

/** A region drawn as a grid of cards (wide-layout spec §4): Progress A's charts. */
export interface RegionGrid {
  min: CardMin;
  max?: 2 | 3 | 4;
  gap: Gap;
}

/**
 * A screen's wide layout (wide-layout spec §4): its regions, in reading and
 * tab order. Its tracks, areas and thresholds live in
 * components/layout/layout.css under `.cols.<name>`.
 */
export interface Layout {
  name: string;
  regions: readonly string[];
  grids?: Readonly<Record<string, RegionGrid>>;
}

/** Two columns, left and right: every screen not given its own layout. `Split` draws it exactly as the desktop build did. */
export const TWO: Layout = { name: "two", regions: ["left", "right"] };

export interface PartSpec {
  key: string;
  /** "full", or a region of the screen's layout (TWO's "left" and "right" unless the screen names another layout). */
  side: string;
  only?: "wide" | "phone";
  wideAfter?: readonly string[];
}

export type Arranged = { wide: false; stack: string[] } | { wide: true; full: string[]; regions: Record<string, string[]> };

export function arrange(specs: readonly PartSpec[], wide: boolean, layout: Layout = TWO): Arranged {
  if (!wide) return { wide: false, stack: specs.filter((s) => s.only !== "wide").map((s) => s.key) };
  const shown = specs.filter((s) => s.only !== "phone");
  const keys = new Set(shown.map((s) => s.key));
  const anchor = (s: PartSpec) => s.wideAfter?.find((k) => k !== s.key && keys.has(k));
  const ordered = shown.filter((s) => anchor(s) === undefined);
  // A mover is placed once its anchor is: loop until no more can be, so a forward reference resolves.
  let waiting = shown.filter((s) => anchor(s) !== undefined);
  while (waiting.length > 0) {
    const ready = waiting.filter((s) => ordered.some((o) => o.key === anchor(s)));
    if (ready.length === 0) {
      // A cycle (a part anchored, directly or not, to itself): keep each in its declared place.
      ordered.push(...waiting);
      break;
    }
    for (const s of ready) ordered.splice(ordered.findIndex((o) => o.key === anchor(s)) + 1, 0, s);
    waiting = waiting.filter((s) => !ready.includes(s));
  }
  const stray = ordered.find((s) => s.side !== "full" && !layout.regions.includes(s.side));
  if (stray) throw new Error(`Part "${stray.key}" is on "${stray.side}", which is not a region of the ${layout.name} layout.`);
  const on = (side: string) => ordered.filter((s) => s.side === side).map((s) => s.key);
  return { wide: true, full: on("full"), regions: Object.fromEntries(layout.regions.map((r) => [r, on(r)])) };
}

/**
 * Today B (wide-layout spec §5): the date bar and the strip full width; the rail (your left line and macros),
 * the meals, the tail (close the day, the footer) and the house (pots, the household). Three columns from a
 * 1,500 px screen; below it the rail, meals and tail stack on the left.
 */
export const TODAY: Layout = { name: "today", regions: ["rail", "meals", "tail", "house"] };

export const TODAY_PARTS: readonly PartSpec[] = [
  { key: "offline", side: "full" },
  { key: "top", side: "full" },
  { key: "strip", side: "full" },
  { key: "left", side: "rail" },
  { key: "macros", side: "rail" },
  { key: "pots", side: "house" },
  { key: "tiers", side: "meals" },
  { key: "close", side: "tail" },
  { key: "footer", side: "tail" },
  { key: "glance", side: "house", only: "wide" },
];

/** Train A (wide-layout spec §5): the next session, the session list, and the session open in a third region from a 1,150 px screen. */
export const TRAIN: Layout = { name: "train", regions: ["next", "list", "open"] };

export const TRAIN_PARTS: readonly PartSpec[] = [
  { key: "top", side: "full" },
  { key: "message", side: "next" },
  { key: "policy", side: "next" },
  { key: "gaps", side: "next" },
  { key: "rows", side: "next" },
  { key: "question", side: "next" },
  { key: "history", side: "list" },
  { key: "open", side: "open", only: "wide" },
];

/**
 * Progress overview: the unified summary (spec §Unified Progress read model,
 * 20 Oct 2026). Direction hero, then the signal grid, next drill-down,
 * comparison strip and domain links across the width; the collapsible
 * evidence table right.
 */
export const SUMMARY_PARTS: readonly PartSpec[] = [
  { key: "top", side: "full", only: "phone" },
  { key: "title", side: "full", only: "wide" },
  { key: "hero", side: "full" },
  { key: "signals", side: "full" },
  { key: "next", side: "full" },
  { key: "comparison", side: "full" },
  { key: "links", side: "full" },
  { key: "evidence", side: "full" },
];

/** Progress: the charts left, wider; the range switch and the readings table right (desktop spec §3; web decision 66). */
export const PROGRESS_PARTS: readonly PartSpec[] = [
  { key: "top", side: "full", only: "phone" },
  { key: "title", side: "full", only: "wide" },
  { key: "headline", side: "left" },
  { key: "log", side: "left", wideAfter: ["weight", "chart", "headline"] },
  { key: "drafts", side: "left", wideAfter: ["log"] },
  { key: "chart", side: "left" },
  { key: "weight", side: "left" },
  { key: "context", side: "right" },
  { key: "ranges", side: "right", only: "wide" },
  { key: "readings", side: "right", only: "wide" },
  // Your recent readings with Edit and Remove (click test P1-3), on both layouts.
  { key: "recent", side: "right" },
  { key: "week", side: "right" },
  { key: "health", side: "right" },
];

/** Health: markers and flags left; Drafts to check and the blood-draw table right (desktop spec §3). */
export const HEALTH_PARTS: readonly PartSpec[] = [
  { key: "top", side: "full" },
  { key: "overview", side: "full" },
  { key: "drafts", side: "right" },
  { key: "out", side: "left" },
  { key: "gaps", side: "left" },
  { key: "flags", side: "left" },
  { key: "panels", side: "left" },
  { key: "draws", side: "right" },
];

/** Household: shared meals left; catching up right, Waiting on you first (desktop spec §3, §4). */
export const HOUSEHOLD_PARTS: readonly PartSpec[] = [
  { key: "top", side: "full" },
  { key: "people", side: "full" },
  { key: "waiting-you", side: "right" },
  { key: "meals", side: "left" },
  { key: "leftovers", side: "right", wideAfter: ["others"] },
  { key: "others", side: "right" },
];

/** Catalogue A (wide-layout spec §5): the list, then the open record. No full-width part. */
export const CATALOGUE: Layout = { name: "catalogue", regions: ["list", "record"] };

export const CATALOGUE_PARTS: readonly PartSpec[] = [
  { key: "list", side: "list" },
  { key: "record", side: "record" },
];
