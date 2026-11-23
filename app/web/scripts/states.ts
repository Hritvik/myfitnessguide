/**
 * Every route and state the layout sweep and the phone check visit (e2e spec
 * §2, §8), moved out of sweep-layout.ts. `states(api)` needs only the viewer's
 * tools; STATE_NAMES lists the same names statically, so Playwright can list
 * the tests before any Worker runs (tests/states.test.ts keeps them equal).
 * Every act waits on the page (a locator's own wait), never on a clock, and
 * finds things by role and name or the app's data-row/data-search (F12).
 */
import type { Locator, Page } from "@playwright/test";
import { openSheet, pick, region, tellText } from "../e2e/support/ui.ts";
import { pickRecords, type RecordLink } from "./sweep-lib.ts";

export interface State {
  name: string;
  path: string;
  /** Run after the page settles; may open things. */
  act?: (page: Page, wide: boolean) => Promise<void>;
  /** A selector for the state's primary object, which from 1,920 px must start in the top 400 px (the fold). */
  primary?: string;
}

export interface StateApi {
  tool(name: string, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  viewer: { name: string; email: string };
}

const TABS = ["/", "/train", "/progress", "/household"] as const;
const tabName = (t: string) => t.slice(1) || "today";
/** The stress household's other members, by first name (the viewer is Asha). */
const OTHERS = ["Kabir", "Noor"] as const;
/** Each catalogue pane, its path and its list's accessible name (the cat-list section's aria-label). */
const PANES = [
  ["catalogue", "/catalogue", "Foods and recipes"],
  ["workouts", "/catalogue/workouts", "Workouts"],
  ["exercises", "/catalogue/exercises", "Exercises"],
  ["gyms", "/catalogue/gyms", "Gyms"],
] as const;
const SHEETS = ["food-empty", "food", "food-chosen", "workout", "set", "reading", "tell"] as const;

export const STATE_NAMES: readonly string[] = [
  "today", "today-open", "today-yesterday", "train", "train-open", "train-session", "today-edit", "train-session-edit",
  "train-log-a-set", "progress", "progress-all", "progress-4w", "week", "health", "household", "catalogue",
  "catalogue-workouts", "catalogue-exercises", "catalogue-gyms", "catalogue-words", "catalogue-new-food",
  "catalogue-new-recipe", "menu", "feedback", "keys",
  ...OTHERS.flatMap((m) => TABS.map((t) => `${tabName(t)}-as-${m}`)),
  ...TABS.flatMap((t) => SHEETS.map((s) => `sheet-${s}-${tabName(t)}`)),
  ...PANES.flatMap(([pane]) => [0, 1, 2].flatMap((i) => (pane === "catalogue" ? [`record-${pane}-${i}`, `edit-${pane}-${i}`] : [`record-${pane}-${i}`]))),
];

/** Every <details> on the page open: the one definition (privacy's visits use it too, F11). */
export async function openAllDetails(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
}

const LONG_TEXT =
  "THE BIG BOWL OF POHA AGAIN WITH EXTRA PEANUTS AND A SPOON OF GHEE, then the leftover rajma at eleven, and https://example.com/sample/a-very-long-link-that-never-breaks-anywhere-at-all-because-it-has-no-spaces 39->52kg,+33%";

/**
 * The Food tab's search, typed, and its answer in place of Recent (the search waits 250 ms after the last key):
 * its results, or the line saying nothing matches (the phone check's default sample has no "Rolled").
 */
async function search(sheet: Locator, query: string): Promise<Locator> {
  await sheet.locator("input[data-search]").fill(query);
  const nothing = sheet.getByRole("status").filter({ hasText: `Nothing matches "${query}"` });
  await sheet.getByRole("heading", { name: "Search results" }).or(nothing).first().waitFor();
  return sheet;
}

/** A catalogue record: the pane's links read at 1,280 px, then the i-th of pickRecords' first, longest and last, at the test's own size. */
function recordState(pane: string, path: string, list: string, i: number, edit: boolean): State {
  return {
    name: `${edit ? "edit" : "record"}-${pane}-${i}`,
    path,
    primary: "article.record",
    act: async (page) => {
      const size = page.viewportSize();
      await page.setViewportSize({ width: 1280, height: 900 });
      const rows = region(page, list).getByRole("link");
      await rows.first().waitFor();
      const links: RecordLink[] = await rows.evaluateAll((as) => as.map((a) => ({ href: a.getAttribute("href") ?? "", text: a.textContent ?? "" })));
      if (size) await page.setViewportSize(size);
      const picked = pickRecords(links);
      const href = picked[Math.min(i, picked.length - 1)];
      if (!href) throw new Error(`${path} lists no records`);
      // Against the page's own origin: the phone check's pages have no baseURL.
      await page.goto(new URL(href, page.url()).href);
      // The record is the catalogue route's one article (aria-labelledby its title).
      const record = page.getByRole("article");
      await record.waitFor();
      if (edit) {
        await record.getByRole("button", { name: "Edit", exact: true }).first().click();
        // The edit form is open when its Cancel is.
        await record.getByRole("button", { name: "Cancel", exact: true }).first().waitFor();
      } else await openAllDetails(page);
    },
  };
}

export async function states(api: StateApi): Promise<State[]> {
  const who = await api.tool("whoami");
  const today = String(who.today);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const members = ((who.members as string[] | undefined) ?? []).filter((m) => m !== api.viewer.name);
  const list: State[] = [
    { name: "today", path: "/", primary: "#meals" },
    { name: "today-open", path: "/", act: openAllDetails },
    { name: "today-yesterday", path: `/?date=${yesterday}` },
    { name: "train", path: "/train", primary: '[data-region="next"] > ol.rows' },
    { name: "train-open", path: "/train", act: openAllDetails },
    {
      name: "train-session",
      path: "/train",
      act: async (page, wide) => {
        if (wide) {
          // The wide session list's rows are data-row buttons; the picked session opens as an article.
          await region(page, "Sessions").locator("[data-row]").first().click();
          await page.getByRole("article").first().waitFor();
        }
        await openAllDetails(page);
      },
    },
    {
      name: "today-edit",
      path: "/",
      act: async (page) => {
        await page.getByRole("list", { name: "Meals" }).getByRole("button", { name: /^Edit / }).first().click();
        await page.getByRole("form", { name: "Edit this item" }).waitFor();
      },
    },
    {
      name: "train-session-edit",
      path: "/train",
      act: async (page, wide) => {
        // A strength session: one with sets to edit.
        const sessions = region(page, "Sessions");
        if (wide) await sessions.locator("[data-row]", { hasText: "working sets" }).first().click();
        else await sessions.locator("details", { hasText: "working sets" }).first().evaluate((d: HTMLDetailsElement) => (d.open = true));
        await page.getByRole("button", { name: /^Edit / }).filter({ visible: true }).first().click();
        await page.getByRole("form", { name: /^Edit this (set|cardio)$/ }).waitFor();
      },
    },
    {
      name: "train-log-a-set",
      path: "/train",
      act: async (page) => {
        await page.getByRole("button", { name: "Log a set" }).first().click();
        await page.getByRole("dialog", { name: "Add" }).waitFor();
      },
    },
    { name: "progress", path: "/progress" },
    { name: "progress-all", path: "/progress?range=all", act: openAllDetails },
    { name: "progress-4w", path: "/progress?range=4w" },
    { name: "week", path: `/progress?week=${yesterday}`, act: openAllDetails },
    { name: "health", path: "/progress/health", act: openAllDetails },
    { name: "household", path: "/household", act: openAllDetails },
    { name: "catalogue", path: "/catalogue" },
    { name: "catalogue-workouts", path: "/catalogue/workouts" },
    { name: "catalogue-exercises", path: "/catalogue/exercises" },
    { name: "catalogue-gyms", path: "/catalogue/gyms" },
    { name: "catalogue-words", path: "/catalogue/words" },
    { name: "catalogue-new-food", path: "/catalogue/new/food" },
    { name: "catalogue-new-recipe", path: "/catalogue/new/recipe" },
    {
      name: "menu",
      path: "/",
      act: async (page) => {
        await page.getByRole("button", { name: "More", exact: true }).click();
        await page.getByRole("menu").waitFor();
      },
    },
    {
      name: "feedback",
      path: "/",
      act: async (page) => {
        await page.getByRole("button", { name: "More", exact: true }).click();
        await page.getByRole("menuitem", { name: "Send feedback" }).click();
        await page.getByRole("dialog").getByLabel("What happened, or what you'd like").fill(LONG_TEXT);
      },
    },
    {
      name: "keys",
      path: "/",
      act: async (page) => {
        await page.keyboard.press("Shift+Slash");
        await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
      },
    },
  ];
  for (const m of members) for (const t of TABS) list.push({ name: `${tabName(t)}-as-${m.split(" ")[0]}`, path: `${t}?member=${encodeURIComponent(m)}` });
  for (const t of TABS) {
    const at = tabName(t);
    // The page is already at the state's path and settled: the sheet opens where it is (null).
    // The Food tab as it opens: Recent, whose long names must stay inside the sheet.
    list.push({ name: `sheet-food-empty-${at}`, path: t, act: async (p) => void (await openSheet(p, "Food", null)) });
    list.push({ name: `sheet-food-${at}`, path: t, act: async (p) => void (await search(await openSheet(p, "Food", null), "Rolled")) });
    list.push({
      name: `sheet-food-chosen-${at}`,
      path: t,
      act: async (p) => {
        const d = await search(await openSheet(p, "Food", null), "Whey");
        await pick(d, /whey/i).click();
      },
    });
    list.push({ name: `sheet-workout-${at}`, path: t, act: async (p) => void (await openSheet(p, "Workout", null)) });
    list.push({ name: `sheet-set-${at}`, path: t, act: async (p) => void (await openSheet(p, "Set", null)) });
    list.push({ name: `sheet-reading-${at}`, path: t, act: async (p) => void (await openSheet(p, "Reading", null)) });
    list.push({ name: `sheet-tell-${at}`, path: t, act: async (p) => void (await tellText(await openSheet(p, "Tell Claude", null)).fill(LONG_TEXT)) });
  }
  for (const [pane, path, listName] of PANES) {
    for (const i of [0, 1, 2]) {
      list.push(recordState(pane, path, listName, i, false));
      if (pane === "catalogue") list.push(recordState(pane, path, listName, i, true));
    }
  }
  return list;
}

export async function stateNamed(api: StateApi, name: string): Promise<State> {
  const found = (await states(api)).find((s) => s.name === name);
  if (!found) throw new Error(`no state named ${name}`);
  return found;
}
