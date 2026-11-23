/**
 * The app's own names for what the suite touches (roles and accessible names,
 * or the app's data-row and data-search hooks; no test-only attributes). One
 * definition each: scripts/states.ts and every test open the sheet here. Only
 * Playwright's types are imported, so the sweep's states and the unit tests
 * can load this file.
 */
import type { Locator, Page } from "@playwright/test";
import { count } from "./d1.ts";
import type { Api } from "./fixtures.ts";
import { settle } from "./settle.ts";

export const FAB = "Add food, a workout, a set, a reading or free text";
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const sheet = (page: Page): Locator => page.getByRole("dialog", { name: "Add" });
export const region = (page: Page, name: string): Locator => page.getByRole("region", { name });

/** The Add sheet on `tab`, after going to `path` (null: where the page already is). */
export async function openSheet(page: Page, tab: "Food" | "Workout" | "Set" | "Reading" | "Tell Claude", path: string | null = "/"): Promise<Locator> {
  if (path !== null) {
    await page.goto(path);
    await settle(page);
  }
  await page.getByRole("button", { name: FAB }).click();
  const d = sheet(page);
  await d.getByRole("tab", { name: tab }).click();
  await d.getByRole("tab", { name: tab, selected: true }).waitFor();
  return d;
}

/** A choice in one of the sheet's pick lists (an unnamed list of buttons): a string matches anywhere in its name. */
export const pick = (scope: Locator, name: string | RegExp): Locator =>
  scope.getByRole("list").getByRole("button", { name: typeof name === "string" ? new RegExp(escapeRe(name)) : name }).first();

/** The Tell Claude box, by its label. */
export const tellText = (scope: Locator): Locator => scope.getByRole("textbox", { name: /^Say what you had or did/ });

let seq = 0;
/** A write through the API as a member (setting up a case), with its own idempotency key. */
export async function writeAs(api: Api, tool: string, input: Record<string, unknown>): Promise<any> {
  const r = await api.tool(tool, { ...input, idempotency_key: `e2e-setup-${process.pid}-${++seq}-${Date.now()}` });
  if (r.status !== 200 || r.body?.status !== "ok") throw new Error(`${tool}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export const toolPattern = (tools: readonly string[]): RegExp => new RegExp(`^(${tools.join("|")})$`);

/** Writes landed by these tools, from the slot's D1 (ruling 5). */
export function writesTo(persist: string, tools: readonly string[]): number {
  return count(persist, `SELECT count(*) AS n FROM write_log WHERE tool IN (${tools.map((t) => `'${t}'`).join(", ")})`);
}

/** The Reading tab's value box: its label is "<metric>, in <unit>" or "<metric> (choose the unit)" (reading.ts fieldLabel). */
export const readingValue = (scope: Locator): Locator => scope.getByRole("textbox", { name: /(, in .+|\(choose the unit\))$/ });
/** A catalogue record: the route's one article, labelled by its title. */
export const catalogueRecord = (page: Page): Locator => page.getByRole("article");
/** The top menu's opener. */
export const moreButton = (page: Page): Locator => page.getByRole("button", { name: "More", exact: true });

/** Today's meals (Tiers.tsx), a meal's tier by its heading, and the tier's header line (its subtotal). */
export const meals = (p: Page): Locator => p.getByRole("list", { name: "Meals" });
export const tier = (p: Page, label: string): Locator => meals(p).getByRole("listitem").filter({ has: p.getByRole("heading", { name: label, exact: true }) });
export const tierMeta = (p: Page, label: string): Locator => tier(p, label).getByRole("note", { name: `${label} subtotal`, exact: true });
/** The macro strip: what is left of each target (Parts.tsx). */
export const leftToday = (p: Page): Locator => p.getByRole("list", { name: "Left of each target" });
/** One column of the strip, by its label ("Energy", "Protein", "Carbs", "Fat"; today.ts MACROS). */
export const leftOf = (p: Page, label: string): Locator => leftToday(p).getByRole("listitem").filter({ hasText: new RegExp(`^${escapeRe(label)}`) });
/** An ISO date `days` later (earlier when negative). */
export const addDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** A date as the app writes a day (format.ts `day`): "2026-10-06" -> "Tue 6 Oct"; September is "Sep" whatever this ICU says. */
export const dayLabel = (iso: string): string =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`)).replace(/\bSept\b/, "Sep");
/** Progress's week view (ProgressScreen "Week"). */
export const weekView = (p: Page): Locator => p.getByLabel("Week");
/** A member's row on Household. */
export const householdRow = (p: Page, name: string): Locator => p.getByRole("main").getByRole("listitem").filter({ hasText: name }).first();
/** An item's row on Today, by its name. */
export const itemRow = (p: Page, name: string): Locator => meals(p).getByRole("listitem").filter({ hasText: new RegExp(`^${escapeRe(name)}`) }).first();

/**
 * A measure chip on the Food tab's amount step, by its label ("g", "ml", "pieces" or "<measure> (<size>)"; food.ts
 * amountChips). Save stays disabled until one is pressed ("Choose a measure, or grams.") unless the food remembers one.
 */
export const measureChip = (scope: Locator, label: string): Locator => scope.getByRole("group", { name: "Measure" }).getByRole("button", { name: label, exact: true });

/** Food through the sheet: search, pick, measure (grams unless named), amount, Save; waits for log_intake's answer and closes the sheet. */
export async function logFood(page: Page, o: { food: string; amount: string; measure?: string; meal?: string; forName?: string; date?: string }): Promise<void> {
  const d = await openSheet(page, "Food");
  if (o.forName) await d.getByRole("group", { name: "For" }).getByRole("button", { name: new RegExp(`^${escapeRe(o.forName)}`) }).click();
  if (o.date) await d.getByLabel("Day").fill(o.date);
  if (o.meal) await d.getByLabel("Meal").selectOption({ label: o.meal });
  await d.getByLabel("Find a food or dish").fill(o.food);
  await pick(d, new RegExp(`^${escapeRe(o.food)}`)).click();
  // Before the amount: a chip converts what is typed (food.ts switchMeasure).
  await measureChip(d, o.measure ?? "g").click();
  await d.getByLabel("How much").fill(o.amount);
  const saved = page.waitForResponse((r) => r.url().endsWith("/tools/log_intake") && r.status() === 200);
  await d.getByRole("button", { name: "Save", exact: true }).click();
  await saved;
  await d.getByLabel("How much").waitFor({ state: "detached" });
  await d.getByRole("button", { name: "Close" }).click();
  await d.waitFor({ state: "detached" });
}

/** A pot's card (PotCard.tsx): a section labelled by its heading, "<pot>, one pot" (on Today and on Household's Shared meals). */
export const potCard = (p: Page, name: string): Locator => p.getByRole("region", { name: `${name}, one pot`, exact: true }).first();
/** The rows of "Waiting on you" (WaitingOnYou.tsx, on Household). */
export const waitingRows = (p: Page): Locator => region(p, "Waiting on you").getByRole("listitem");

/** A row of my "Waiting on others" (Household): "<summary> for <member>: …" (household.ts), by its food and the member it is about. */
export const othersRow = (p: Page, food: string, about: string): Locator =>
  region(p, "Waiting on others").getByRole("listitem").filter({ hasText: new RegExp(`^${escapeRe(food)}\\b[^:]* for ${escapeRe(about)}:`) });

/** Food logged through the API (a journey's setup, not its step). */
export async function logAs(api: Api, forName: string, date: string, food: string, grams: number, meal = "snack"): Promise<any> {
  return writeAs(api, "log_intake", { member: forName, date, meal_slot: meal, items: [{ source: "food", food, value: grams, unit: "g", provenance: "weighed", confidence: "high" }] });
}

/**
 * "Which gym are you at?" (ticket 63): answered with the household's first gym when the Save asks it. Called
 * after Save set: waits until the Set tab either asks or has saved (a saved set empties Reps), so a question that
 * renders a moment after log_set's answer is never missed.
 */
export async function answerGymIfAsked(scope: Locator): Promise<void> {
  const which = scope.getByRole("group", { name: "Which gym" });
  const reps = scope.getByLabel("Reps");
  // Loaded here, not at the top: states.ts imports this file, and its unit test runs without the test runner.
  const { expect } = await import("@playwright/test");
  await expect.poll(async () => (await which.isVisible()) || (await reps.inputValue()) === "", { message: "the set saves or asks which gym" }).toBe(true);
  if (await which.isVisible()) await which.getByRole("button").first().click();
}

/**
 * A set through the Set tab: find the exercise, its load (a weight; Bodyweight when none is given), reps, RIR,
 * Save set. Answers "Which gym" with the first gym when asked; waits for the saved set to clear the form.
 */
export async function logSet(page: Page, o: { exercise: RegExp; search: string; load?: string; reps: string; rir: string }): Promise<void> {
  const d = await openSheet(page, "Set");
  await d.getByLabel("Find an exercise").fill(o.search);
  await d.getByRole("list").getByRole("button", { name: o.exercise }).first().click();
  const loadAs = d.getByRole("group", { name: "Load as" });
  await loadAs.getByRole("button", { name: o.load === undefined ? "Bodyweight" : "Weight", exact: true }).click();
  if (o.load !== undefined) await d.getByLabel("Load", { exact: true }).fill(o.load);
  await d.getByLabel("Reps").fill(o.reps);
  await d.getByPlaceholder("2 or 1-2").fill(o.rir);
  await d.getByRole("button", { name: "Save set" }).click();
  await answerGymIfAsked(d);
  // A saved set clears reps (SetTab: the form keeps the exercise and load for the next set).
  const { expect } = await import("@playwright/test");
  await expect(d.getByLabel("Reps")).toHaveValue("");
  await d.getByRole("button", { name: "Close" }).click();
  await d.waitFor({ state: "detached" });
}
