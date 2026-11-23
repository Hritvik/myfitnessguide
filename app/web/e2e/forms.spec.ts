/**
 * Form cases (e2e spec §7): each row of forms.table.ts, in the browser, as
 * Asha at 390 (and the catalogue's forms at 1,440), with the outcome it
 * expects; a companion test for each disputed row (ticket 80) that asserts
 * what the app does today; and the exhaustiveness check over every swept state
 * and every catalogue small form. A row that writes leaves its slot on the
 * seed (fromTheSeed), so no row sees another's write.
 *
 * Delta-only rule: these cases run fullyParallel on a worker-scoped slot that
 * is not restarted per test, and which cases share a slot changes whenever the
 * worker or test count does. A case asserts before/after deltas or "the row it
 * wrote", never an absolute state (an empty meal, a first row); a case that
 * needs one restarts its slot first (final review M5).
 */
import type { Locator, Page } from "@playwright/test";
import { STATE_NAMES, stateNamed } from "../scripts/states.ts";
import { FIELD_NAMES, FIELD_PATTERNS, FORM_ROWS, NOT_IN_A_FORM, NOT_IN_A_FORM_PATTERNS, type FormName, type FormRow, type Observed } from "./forms.table.ts";
import { d1 } from "./support/d1.ts";
import { expect, test, type Api } from "./support/fixtures.ts";
import { fromTheSeed } from "./support/journey.ts";
import type { ToolLog } from "./support/network.ts";
import { settle } from "./support/settle.ts";
import { answerGymIfAsked, catalogueRecord, measureChip, moreButton, openSheet, pick, readingValue, region, sheet, tellText, toolPattern, writeAs, writesTo } from "./support/ui.ts";

interface Ctx {
  page: Page;
  api: (m?: "asha" | "kabir") => Api;
  persist: string;
  names: { asha: string; kabir: string };
  today: string;
}

interface Driver {
  /** Opens the form and fills every field with a valid value, so only the field under test is awkward. */
  open(c: Ctx): Promise<void>;
  /** The form itself: its sheet tab, its catalogue form, its region or dialog. Questions and save lines are looked for here. */
  scope(page: Page): Locator;
  /** The form's own refusal, by role and name: its "What to fix" status (FormError.tsx) or its alert. Never a preview. */
  message(page: Page): Locator;
  field(page: Page, name: string): Locator;
  submit(page: Page): Locator;
  tools: readonly string[];
  /** The table whose newest row holds what was saved (taken), or a reader for a field the table can't show. */
  table: string;
  /** Each row's field, to the column of `table` that stores it: a taken row reads that column only (F10). */
  columns: Record<string, string>;
  readBack?: (c: Ctx, field: string) => Promise<unknown>;
  /** A field whose stored value is in another unit than shown: stored = shown × scale. */
  scale?: Record<string, number>;
  /** After Save, before the write is counted: answers what the form asks of every save (the Set tab's "Which gym"). */
  afterSubmit?: (page: Page) => Promise<void>;
}

const latest = (persist: string, table: string) => d1(persist, `SELECT * FROM ${table} ORDER BY id DESC LIMIT 1`)[0] ?? {};
const said = async (l: Locator): Promise<string> => (await l.allInnerTexts()).join(" ").replace(/\s+/g, " ").trim();
/** The sheet tabs' and the leftovers' refusal line (FormError.tsx). */
const whatToFix = (scope: Locator): Locator => scope.getByRole("status", { name: "What to fix", exact: true });
/** A question the form shows: needs_clarification in its save line (writes.ts), always a question. */
const question = (scope: Locator): Locator => scope.getByRole("status").filter({ hasText: /\?/ }).and(scope.locator(':not([aria-label="What to fix"])'));

async function refOf(api: Api, query: string, kind: "food_source" | "recipe"): Promise<string> {
  return String((await api.tool("catalogue_search", { query, kinds: [kind] })).body.results[0].ref);
}

async function foodRecord(c: Ctx, query: string): Promise<void> {
  await c.page.goto(`/catalogue/food/${encodeURIComponent(await refOf(c.api(), query, "food_source"))}`);
  await settle(c.page);
  await catalogueRecord(c.page).waitFor();
}

async function recipeRecord(c: Ctx, query: string): Promise<void> {
  await c.page.goto(`/catalogue/recipe/${encodeURIComponent(await refOf(c.api(), query, "recipe"))}`);
  await settle(c.page);
  await catalogueRecord(c.page).waitFor();
}

async function gymRecord(page: Page): Promise<void> {
  await page.goto("/catalogue/gyms");
  await settle(page);
  await region(page, "Gyms").getByRole("link").first().click();
  await settle(page);
  await catalogueRecord(page).waitFor();
}

const form = (page: Page, name: string | RegExp): Locator => page.getByRole("form", { name });

/** One of a catalogue record's small forms (SmallForm.tsx): its opener pressed, the form named by it, its reason filled. */
async function smallForm(page: Page, opener: string): Promise<Locator> {
  await catalogueRecord(page).getByRole("button", { name: opener, exact: true }).first().click();
  const f = form(page, opener);
  await f.getByLabel("Why?", { exact: true }).fill("A probe.");
  return f;
}

/** A catalogue form's driver parts: the form by name, its alert (SmallForm, EditForm, NewFood, NewRecipe) and its Save. */
const catalogueForm = (name: string | RegExp, submit = "Save") => ({
  scope: (p: Page) => form(p, name),
  message: (p: Page) => form(p, name).getByRole("alert"),
  submit: (p: Page) => form(p, name).getByRole("button", { name: submit, exact: true }),
});

/** A sheet tab's driver parts: the Add sheet, its "What to fix" line. */
const sheetForm = {
  scope: (p: Page) => sheet(p),
  message: (p: Page) => whatToFix(sheet(p)),
};

/** The catalogue's food fields (catalogue.ts FOOD_FIELDS, label and unit), and the food_source column each stores. */
const FOOD_FIELDS: Record<string, { label: string; column: string }> = {
  kcal: { label: "Energy (kcal)", column: "kcal" },
  protein: { label: "Protein (g)", column: "protein_g" },
  carbs: { label: "Carbs (g)", column: "carbs_g" },
  fat: { label: "Fat (g)", column: "fat_g" },
  micronutrient: { label: "Fibre (g)", column: "fibre_g" },
};
const EDITED = "Bajra";

export const DRIVERS: Record<FormName, Driver> = {
  "Food amount": {
    async open({ page }) {
      const d = await openSheet(page, "Food");
      await d.getByLabel("Find a food or dish").fill("Ragi");
      await pick(d, /^Ragi/).click();
      // Grams before the amount: Save waits for a measure (ui.ts measureChip).
      await measureChip(d, "g").click();
      await d.getByLabel("How much").fill("40");
    },
    ...sheetForm,
    field: (p) => sheet(p).getByLabel("How much"),
    submit: (p) => sheet(p).getByRole("button", { name: "Save", exact: true }),
    tools: ["log_intake"],
    table: "intake_item",
    columns: { "How much": "amount_value" },
  },
  "New food": {
    async open({ page }) {
      const d = await openSheet(page, "Food");
      await d.getByLabel("Find a food or dish").fill("Qorvy probe");
      await d.getByRole("button", { name: "+ New food" }).click();
      await d.getByLabel("Name", { exact: true }).fill("Qorvy probe");
      // The four macros are labelled by their key (FoodTab.tsx NewFood); 4×4 + 20×4 + 2×9 = 114, near 120.
      for (const [label, v] of [["kcal", "120"], ["protein", "4"], ["carbs", "20"], ["fat", "2"]] as const) await d.getByLabel(label, { exact: true }).fill(v);
    },
    ...sheetForm,
    field: (p, name) => sheet(p).getByLabel(name, { exact: true }),
    submit: (p) => sheet(p).getByRole("button", { name: "Add food" }),
    tools: ["upsert_food_source"],
    table: "food_source",
    columns: { Name: "name", kcal: "kcal" },
  },
  "Pot share": {
    async open({ page, names }) {
      const d = await openSheet(page, "Food");
      await d.getByRole("button", { name: "A dish cooked for the household" }).click();
      await d.getByLabel("Dish").fill("Probe pot");
      await d.getByLabel("Add an ingredient").fill("Moong");
      await d.getByRole("button", { name: /^Moong/ }).first().click();
      await d.getByRole("group", { name: /^Add Moong/ }).getByRole("textbox").fill("100");
      await d.getByRole("button", { name: "Add ingredient" }).click();
      await d.getByRole("list", { name: "Who ate" }).getByRole("button", { name: names.asha, exact: true }).click();
      await d.getByLabel(`${names.asha}'s share`).fill("50");
    },
    ...sheetForm,
    field: (p) => sheet(p).getByLabel(/'s share$/),
    submit: (p) => sheet(p).getByRole("button", { name: "Save", exact: true }),
    tools: ["household_meal"],
    table: "portion",
    columns: { share: "fraction" },
    scale: { share: 0.01 },
  },
  "Today's pot share": {
    async open(c) {
      await kabirsPot(c);
      const d = await openSheet(c.page, "Food");
      await d.getByRole("button", { name: /^Probe dal/ }).click();
      await d.getByLabel("Share (%)").fill("10");
    },
    ...sheetForm,
    field: (p) => sheet(p).getByLabel("Share (%)"),
    submit: (p) => sheet(p).getByRole("button", { name: "Save", exact: true }),
    tools: ["mark_remainder"],
    table: "portion",
    columns: { share: "fraction" },
    scale: { share: 0.01 },
  },
  "Leftover share": {
    async open({ page }) {
      await page.goto("/household");
      await settle(page);
      await region(page, "Leftovers").getByRole("button", { name: /^Eaten by / }).first().click();
      // 1%: within any leftover's share (the most is what is left of the pot).
      await page.getByLabel("How much of the pot (%)").fill("1");
    },
    scope: (p) => region(p, "Leftovers"),
    message: (p) => whatToFix(region(p, "Leftovers")),
    field: (p) => p.getByLabel("How much of the pot (%)"),
    // A meal's button saves (HouseholdScreen.tsx Leftover): the first, Breakfast.
    submit: (p) => region(p, "Leftovers").getByRole("group", { name: /^Which meal did / }).getByRole("button").first(),
    tools: ["mark_remainder"],
    table: "leftover_serving",
    columns: { share: "fraction" },
    scale: { share: 0.01 },
  },
  Set: {
    async open({ page }) {
      const d = await openSheet(page, "Set");
      await d.getByLabel("Find an exercise").fill("cable row");
      await d.getByRole("list").getByRole("button", { name: /cable row/i }).first().click();
      await d.getByRole("group", { name: "Load as" }).getByRole("button", { name: "Weight", exact: true }).click();
      await d.getByLabel("Load", { exact: true }).fill("35");
      await d.getByLabel("Reps").fill("9");
      await d.getByPlaceholder("2 or 1-2").fill("2");
    },
    ...sheetForm,
    field: (p, name) => (name === "RIR" ? sheet(p).getByPlaceholder("2 or 1-2") : sheet(p).getByLabel(name, { exact: true })),
    submit: (p) => sheet(p).getByRole("button", { name: "Save set" }),
    tools: ["log_set"],
    table: "session_set",
    columns: { Load: "load_value", Reps: "reps", RIR: "rir_low" },
    afterSubmit: (p) => answerGymIfAsked(sheet(p)),
  },
  Cardio: {
    async open({ page }) {
      const d = await openSheet(page, "Set");
      await d.getByRole("button", { name: "Cardio instead" }).click();
      await d.getByPlaceholder("incline walk").fill("Brisk walk");
      await d.getByLabel("Minutes").fill("20");
    },
    ...sheetForm,
    field: (p, name) => (name === "What" ? sheet(p).getByPlaceholder("incline walk") : sheet(p).getByLabel(name)),
    submit: (p) => sheet(p).getByRole("button", { name: "Save cardio" }),
    tools: ["log_cardio"],
    table: "cardio_block",
    columns: { What: "activity", Minutes: "duration_s" },
    scale: { Minutes: 60 },
  },
  Workout: {
    async open({ page }) {
      const d = await openSheet(page, "Workout");
      await d.getByRole("button", { name: "Start from nothing" }).click();
      // An exercise by its whole name, so the save never asks which one.
      await d.getByLabel("Add an exercise").fill("Seated cable row with the wide neutral-grip attachment (machine by the window)");
      await d.getByRole("button", { name: "Add", exact: true }).click();
      const enter = d.getByRole("group", { name: "Set 1's load" }).getByRole("button", { name: "Enter a load" });
      if (await enter.isVisible()) await enter.click();
      await d.getByLabel("Load", { exact: true }).fill("35");
      await d.getByLabel("Reps", { exact: true }).fill("10");
      await d.getByLabel("RIR", { exact: true }).fill("2");
    },
    ...sheetForm,
    field: (p, name) => sheet(p).getByLabel(name, { exact: true }),
    submit: (p) => sheet(p).getByRole("button", { name: "Save workout" }),
    tools: ["log_workout"],
    table: "session_set",
    columns: { Load: "load_value", Reps: "reps" },
  },
  Reading: {
    async open({ page }) {
      const d = await openSheet(page, "Reading");
      await d.getByLabel("What you measured").selectOption("waist_navel");
      await readingValue(d).fill("84");
    },
    scope: (p) => sheet(p),
    // Reading checks on Save, and says so as an alert (ReadingTab.tsx).
    message: (p) => sheet(p).getByRole("alert"),
    field: (p) => readingValue(sheet(p)),
    submit: (p) => sheet(p).getByRole("button", { name: "Log the reading" }),
    tools: ["log_reading"],
    table: "reading",
    columns: { value: "value" },
  },
  "Tell Claude": {
    async open({ page }) {
      const d = await openSheet(page, "Tell Claude");
      await tellText(d).fill("tea");
    },
    ...sheetForm,
    field: (p) => tellText(sheet(p)),
    submit: (p) => sheet(p).getByRole("button", { name: "Send to Claude" }),
    tools: ["submit_to_inbox"],
    table: "inbox_entry",
    columns: { text: "text" },
  },
  Feedback: {
    async open({ page }) {
      await page.goto("/");
      await settle(page);
      await moreButton(page).click();
      await page.getByRole("menuitem", { name: "Send feedback" }).click();
      await page.getByRole("dialog").getByLabel("What happened, or what you'd like").fill("A note.");
    },
    scope: (p) => p.getByRole("dialog"),
    // The feedback sheet has no refusal line of its own (TopMenu.tsx FeedbackSheet): its refused rows are disputed (ticket 80).
    message: (p) => whatToFix(p.getByRole("dialog")),
    field: (p) => p.getByRole("dialog").getByLabel("What happened, or what you'd like"),
    submit: (p) => p.getByRole("dialog").getByRole("button", { name: "Send", exact: true }),
    tools: ["submit_feedback"],
    table: "feedback",
    columns: { text: "text" },
  },
  "Catalogue edit": {
    async open(c) {
      // A micronutrient that is known, so blanking it is a change the edit sends (Bajra's are all unknown in the seed).
      const id = Number(d1(c.persist, "SELECT id FROM food_source WHERE ref = ?", await refOf(c.api(), EDITED, "food_source"))[0]?.id);
      await writeAs(c.api(), "amend", { record: { table: "food_source", id }, changes: { fibre_g: 8 }, reason: "e2e setup: a known micronutrient" });
      await foodRecord(c, EDITED);
      await catalogueRecord(c.page).getByRole("button", { name: "Edit", exact: true }).click();
      await form(c.page, /^Edit /).getByLabel("Why the change?").fill("A probe.");
    },
    ...catalogueForm(/^Edit /),
    field: (p, name) => form(p, /^Edit /).getByLabel(FOOD_FIELDS[name]!.label, { exact: true }),
    tools: ["amend"],
    table: "food_source",
    columns: Object.fromEntries(Object.entries(FOOD_FIELDS).map(([k, f]) => [k, f.column])),
    async readBack(c, field) {
      // The edited food's own row, by ref, not the newest food_source (F10).
      const ref = await refOf(c.api(), EDITED, "food_source");
      return d1(c.persist, `SELECT ${FOOD_FIELDS[field]!.column} AS v FROM food_source WHERE ref = ?`, ref)[0]?.v ?? null;
    },
  },
  "Add measure": {
    async open(c) {
      await foodRecord(c, "Jowar");
      const f = await smallForm(c.page, "Add a measure");
      await f.getByLabel("Measure, like katori").fill("scoop");
      await f.getByLabel(/^Amount/).fill("30");
    },
    ...catalogueForm("Add a measure"),
    field: (p, name) => (name === "name" ? form(p, "Add a measure").getByLabel("Measure, like katori") : form(p, "Add a measure").getByLabel(/^Amount/)),
    tools: ["add_measure"],
    table: "measure",
    columns: { name: "name", amount: "amount" },
  },
  "Add yield": {
    async open(c) {
      // Rice is seeded dry and cooked: a yield needs the food in another state.
      await foodRecord(c, "Rice");
      const f = await smallForm(c.page, "Add a yield");
      await f.getByLabel("1 g becomes (g)").fill("3");
    },
    ...catalogueForm("Add a yield"),
    field: (p) => form(p, "Add a yield").getByLabel("1 g becomes (g)"),
    tools: ["add_yield"],
    table: "yield",
    columns: { factor: "factor" },
  },
  "Teach a word": {
    async open(c) {
      await foodRecord(c, "Urad");
      const f = await smallForm(c.page, "Teach a word");
      await f.getByLabel("Word", { exact: true }).fill("kaali");
    },
    ...catalogueForm("Teach a word"),
    field: (p) => form(p, "Teach a word").getByLabel("Word", { exact: true }),
    tools: ["learn_alias"],
    table: "alias",
    columns: { word: "alias" },
  },
  "Recipe line": {
    async open(c) {
      await recipeRecord(c, "Upma");
      const f = await smallForm(c.page, "Add a line");
      await f.getByLabel("Food", { exact: true }).fill("Peanuts");
      await f.getByLabel("Amount", { exact: true }).fill("20");
    },
    ...catalogueForm("Add a line"),
    field: (p) => form(p, "Add a line").getByLabel("Amount", { exact: true }),
    tools: ["add_recipe_line"],
    table: "recipe_line",
    columns: { amount: "amount_value" },
  },
  "Record plates": {
    async open({ page }) {
      await gymRecord(page);
      const f = await smallForm(page, "Record plates");
      await f.getByLabel("Seen on the rack").fill("2.5");
    },
    ...catalogueForm("Record plates"),
    field: (p) => form(p, "Record plates").getByLabel("Seen on the rack"),
    tools: ["record_plates"],
    table: "plate",
    columns: { plate: "value" },
    // The field is a list: what it saved is the plates of the set the save wrote to, smallest first.
    async readBack(c) {
      return d1(c.persist, "SELECT value FROM plate WHERE plate_set_id = (SELECT plate_set_id FROM plate ORDER BY id DESC LIMIT 1) AND status = 'confirmed' ORDER BY value").map((r) => r.value);
    },
  },
  "Catalogue new food": {
    async open({ page }) {
      await page.goto("/catalogue/new/food");
      await settle(page);
      const f = form(page, "New food");
      await f.getByLabel("Name", { exact: true }).fill("Qorvy page probe");
      for (const [k, v] of [["kcal", "120"], ["protein", "4"], ["carbs", "20"], ["fat", "2"]] as const) await f.getByLabel(FOOD_FIELDS[k]!.label, { exact: true }).fill(v);
      await f.getByLabel("Why add it?").fill("A probe.");
    },
    ...catalogueForm("New food", "Add the food"),
    field: (p, name) => form(p, "New food").getByLabel(FOOD_FIELDS[name]?.label ?? name, { exact: true }),
    tools: ["upsert_food_source"],
    table: "food_source",
    columns: { Name: "name", "Per how much": "reference_amount", ...Object.fromEntries(Object.entries(FOOD_FIELDS).map(([k, f]) => [k, f.column])) },
  },
  "Catalogue new recipe": {
    async open({ page }) {
      await page.goto("/catalogue/new/recipe");
      await settle(page);
      const f = form(page, "New recipe");
      await f.getByLabel("Name", { exact: true }).fill("Probe dish");
      await f.getByLabel("Line 1: food").fill("Peanuts");
      await f.getByLabel("Amount", { exact: true }).fill("20");
      await f.getByLabel("Why add it?").fill("A probe.");
    },
    ...catalogueForm("New recipe", "Add the recipe"),
    field: (p, name) => form(p, "New recipe").getByLabel(name === "amount" ? "Amount" : name, { exact: true }),
    tools: ["upsert_recipe"],
    table: "recipe",
    columns: { Name: "name", Servings: "servings" },
    // The line's amount is in recipe_line: the new recipe's first line.
    async readBack(c, field) {
      if (field !== "amount") return latest(c.persist, "recipe")[field === "Name" ? "name" : "servings"];
      return d1(c.persist, "SELECT amount_value AS v FROM recipe_line WHERE recipe_id = (SELECT max(id) FROM recipe) ORDER BY position LIMIT 1")[0]?.v ?? null;
    },
  },
};

/** Kabir's Probe dal, cooked today with only his share: its remainder is Today's pot in Asha's Food tab (food.ts buildPicker). */
async function kabirsPot(c: Ctx): Promise<void> {
  await writeAs(c.api("kabir"), "household_meal", {
    date: c.today, meal_slot: "lunch",
    cooks: [{ name: "Probe dal", lines: [{ food: "Moong", value: 150, unit: "g", provenance: "weighed" }], portions: [{ member: c.names.kabir, fraction: 0.4, provenance: "estimated" }] }],
  });
}

async function put(page: Page, field: Locator, row: FormRow): Promise<void> {
  if (row.chip) await page.getByRole("group", { name: "Unit" }).getByRole("button", { name: row.chip, exact: true }).click();
  await field.fill("");
  if (row.paste) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate((t) => navigator.clipboard.writeText(t), row.value);
    await field.focus();
    await page.keyboard.press("ControlOrMeta+V");
  } else {
    await field.fill(row.value);
  }
}

const label = (r: FormRow) => `${r.form} · ${r.field} · ${r.case}${r.chip ? ` (${r.chip})` : ""} → ${r.expect}`;

interface Run {
  c: Ctx;
  driver: Driver;
  before: number;
  sentBefore: number;
  sent: () => Promise<number>;
  /** The form's own refusal line, as it reads with every field valid. */
  valid: string;
}

/** Opens the row's form, takes the counts and the valid form's refusal line, and puts the row's value (and its `with`) in. */
async function prepare(row: FormRow, c: Ctx, tools: ToolLog, persist: string): Promise<Run> {
  const driver = DRIVERS[row.form];
  await driver.open(c);
  await settle(c.page);
  const before = writesTo(persist, driver.tools);
  const valid = await said(driver.message(c.page));
  await put(c.page, driver.field(c.page, row.field), row);
  for (const [name, v] of Object.entries(row.with ?? {})) await driver.field(c.page, name).fill(v);
  const sent = async () => (await tools.writes(toolPattern(driver.tools))).length;
  return { c, driver, before, sentBefore: await sent(), sent, valid };
}

async function storedOf(run: Run, row: FormRow): Promise<unknown> {
  const { driver, c } = run;
  const column = driver.columns[row.field];
  if (!driver.readBack && !column) throw new Error(`${row.form} has no column for ${row.field}: add it to the driver's columns`);
  return driver.readBack ? driver.readBack(c, row.field) : latest(c.persist, driver.table)[column!];
}

const toCtx = (page: Page, api: (m?: "asha" | "kabir") => Api, persist: string, names: { asha: string; kabir: string }, today: string): Ctx => ({ page, api, persist, names, today });

for (const width of [390, 1440] as const) {
  test.describe(`forms at ${width}`, () => {
    test.use({ viewer: "asha", viewport: { width, height: width === 390 ? 844 : 900 } });
    // A taken row writes: the next row on this worker starts from the seed (journey.ts).
    fromTheSeed();
    for (const row of FORM_ROWS.filter((r) => width === 390 || r.wide)) {
      test(label(row), async ({ page, api, slot, names, tools, today }) => {
        test.fixme(row.disputed !== undefined, row.disputed ?? "");
        const run = await prepare(row, toCtx(page, api, slot.persist, names, today), tools, slot.persist);
        const { driver, before } = run;
        const submit = driver.submit(page);
        const message = driver.message(page);
        if (row.expect === "refused") {
          // The form's own refusal line is quiet while every field is valid, so what it says now is about this value.
          expect(run.valid, "the valid form shows no refusal").toBe("");
          if (await submit.isEnabled()) await submit.click();
          await expect.poll(() => said(message), { message: "the form's own line says what to type" }).not.toBe("");
          // A write the click sent is finished before it is counted (the log keeps finished requests).
          await settle(page);
          expect(await run.sent(), "no write request goes out").toBe(run.sentBefore);
          expect(writesTo(slot.persist, driver.tools), "nothing written").toBe(before);
          return;
        }
        const asked = question(driver.scope(page));
        await expect(asked, "no question before the save").toHaveCount(0);
        await submit.click();
        await driver.afterSubmit?.(page);
        if (row.expect === "asks") {
          await expect(asked.first()).toBeVisible();
          expect(writesTo(slot.persist, driver.tools), "nothing written").toBe(before);
          return;
        }
        await expect.poll(() => writesTo(slot.persist, driver.tools), { message: "the save lands" }).toBe(before + 1);
        // The field's own stored value, never "some number somewhere in the row" (F10).
        const stored = await storedOf(run, row);
        if ("stored" in row) {
          // The app's documented rule for this value (the row says which).
          if (typeof row.stored === "number") expect(Number(stored)).toBeCloseTo(row.stored, 9);
          else expect(stored).toEqual(row.stored);
          return;
        }
        if (row.kind === "text") {
          // As typed, less the spaces round it (a paste's newline and non-breaking space): the whole text, never cut.
          expect(String(stored), `${row.field} stored as typed`).toBe(row.value.trim());
          return;
        }
        if (row.case === "empty") {
          expect(stored, "a blank micronutrient is stored as null, never 0 (desktop spec §5)").toBeNull();
          return;
        }
        // Exactly what was typed, in the unit shown, so never 100× it.
        const typed = Number(row.value) * (driver.scale?.[row.field] ?? 1);
        expect(Number(stored), `${row.field}: ${typed} is stored`).toBeCloseTo(typed, 9);
      });
    }
    // Ticket 80: what each disputed row does today, so a change shows before the ruling (the row above stays fixme).
    for (const row of FORM_ROWS.filter((r) => r.observed && (width === 390 || r.wide))) {
      const o = row.observed as Observed;
      test(`${row.form} · ${row.field} · ${row.case}: current behaviour, ${o.outcome} (ticket 80)`, async ({ page, api, slot, names, tools, today }) => {
        const run = await prepare(row, toCtx(page, api, slot.persist, names, today), tools, slot.persist);
        const { driver, before } = run;
        const submit = driver.submit(page);
        if (o.outcome === "refused without a message") {
          await expect(submit, "Save is disabled").toBeDisabled();
          await settle(page);
          expect(await said(driver.message(page)), "the form says nothing").toBe("");
          expect(await run.sent(), "no write request goes out").toBe(run.sentBefore);
          expect(writesTo(slot.persist, driver.tools), "nothing written").toBe(before);
          return;
        }
        await submit.click();
        await driver.afterSubmit?.(page);
        if (o.outcome === "asks") {
          await expect(question(driver.scope(page)).first()).toContainText(o.says);
          expect(writesTo(slot.persist, driver.tools), "nothing written").toBe(before);
          return;
        }
        if (o.outcome === "refused by the API") {
          await expect(driver.scope(page)).toContainText(o.says);
          await settle(page);
          const calls = (await tools.writes(toolPattern(driver.tools))).slice(run.sentBefore);
          expect(calls.map((x) => x.status), "one request, refused by the API").toEqual([400]);
          expect(writesTo(slot.persist, driver.tools), "nothing written").toBe(before);
          return;
        }
        await expect.poll(() => writesTo(slot.persist, driver.tools), { message: "the save lands" }).toBe(before + 1);
        expect(await storedOf(run, row)).toEqual(o.stored);
      });
    }
  });
}

/**
 * Every text-entry field in view, by "<where> › <name>": where is the form it sits in (a catalogue form's name,
 * "Edit a record" for any record's edit), else the Add sheet's open tab, else the dialog, else the named section,
 * else "page"; the name is the accessible name's order: aria-label, the label's own words, then the placeholder.
 */
async function fieldsInView(page: Page): Promise<string[]> {
  return page.locator("input:not([type=checkbox]):not([type=radio]):not([type=date]):not([type=search]):not([type=hidden]), textarea").filter({ visible: true }).evaluateAll((els) =>
    els.map((el) => {
      const e = el as HTMLInputElement;
      const own = e.labels?.[0]?.querySelector("span")?.textContent ?? e.labels?.[0]?.textContent ?? "";
      const name = (e.getAttribute("aria-label") || own || e.placeholder || "").trim();
      const f = e.closest("form[aria-label]");
      const dialog = e.closest("[role=dialog]");
      const section = e.closest("section[aria-label]");
      let where = "page";
      if (f) {
        const n = f.getAttribute("aria-label") ?? "";
        where = /^Edit /.test(n) && !/^Edit this /.test(n) ? "Edit a record" : n;
      } else if (dialog) {
        const tab = dialog.querySelector("[role=tab][aria-selected=true]");
        where = (tab?.textContent ?? dialog.getAttribute("aria-label") ?? dialog.querySelector("h2")?.textContent ?? "dialog").trim();
      } else if (section) where = section.getAttribute("aria-label") ?? "page";
      return `${where} › ${name}`;
    }),
  );
}

const listed = (n: string): boolean => n in FIELD_NAMES || n in NOT_IN_A_FORM || FIELD_PATTERNS.some(([re]) => re.test(n)) || NOT_IN_A_FORM_PATTERNS.some(([re]) => re.test(n));
const unlisted = (names: readonly string[]): string[] => [...new Set(names.filter((n) => !listed(n)))];
const UNLISTED = "fields with no form in forms.table.ts: add each to FIELD_NAMES under the form it is part of (and the form's rows if it is new), or to NOT_IN_A_FORM with why";

/**
 * What no swept state opens, opened here and scanned: every catalogue small form (each opener on the food and
 * recipe records, both gyms and a workout) and the Food tab's share of today's pot; and each driver's form as its
 * rows fill it (the Add sheet's sub-forms, Leftovers, the catalogue's own forms). Each returns what it saw.
 */
const SCANS: Record<string, (c: Ctx) => Promise<string[]>> = {
  "food record's small forms": async (c) => {
    await foodRecord(c, "Rice");
    for (const opener of ["Add a measure", "Add a yield", "Teach a word"]) await catalogueRecord(c.page).getByRole("button", { name: opener, exact: true }).click();
    return fieldsInView(c.page);
  },
  "recipe record's small forms": async (c) => {
    await recipeRecord(c, "Upma");
    for (const opener of ["Add a line", "Teach a word", "Change amount"]) await catalogueRecord(c.page).getByRole("button", { name: opener, exact: true }).first().click();
    return fieldsInView(c.page);
  },
  "gyms' small forms": async (c) => {
    await c.page.goto("/catalogue/gyms");
    await settle(c.page);
    const hrefs = await region(c.page, "Gyms").getByRole("link").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
    const seen: string[] = [];
    for (const href of hrefs) {
      await c.page.goto(href);
      await settle(c.page);
      const record = catalogueRecord(c.page);
      await record.waitFor();
      // Every opener on the record, one of each kind (each implement row repeats them).
      for (const opener of ["Record plates", "Add a load", "Remove a load", "Change the bar's weight"]) {
        const b = record.getByRole("button", { name: opener, exact: true }).first();
        if (await b.count()) await b.click();
      }
      seen.push(...(await fieldsInView(c.page)));
    }
    return seen;
  },
  "workout record's small forms": async (c) => {
    await c.page.goto("/catalogue/workouts");
    await settle(c.page);
    await region(c.page, "Workouts").getByRole("link").first().click();
    await settle(c.page);
    await catalogueRecord(c.page).getByRole("button", { name: "Add a line", exact: true }).first().click();
    return fieldsInView(c.page);
  },
  ...Object.fromEntries(
    Object.entries(DRIVERS).map(([name, driver]) => [
      `${name} form, filled`,
      async (c: Ctx) => {
        await driver.open(c);
        await settle(c.page);
        return fieldsInView(c.page);
      },
    ]),
  ),
};

test.describe("every form has rows", () => {
  test.use({ viewer: "asha", viewport: { width: 390, height: 844 } });
  // Some scans write their setup (today's pot, Catalogue edit's known micronutrient).
  fromTheSeed();
  // One test per swept state (fullyParallel, F4): the whole sweep in one test outruns the 60 s budget.
  for (const name of STATE_NAMES) {
    test(`every text-entry field on ${name} belongs to a form in the table`, async ({ page, stateApi }) => {
      const s = await stateNamed(stateApi, name);
      await page.goto(s.path);
      await settle(page);
      if (s.act) await s.act(page, false);
      await settle(page);
      expect(unlisted(await fieldsInView(page)), UNLISTED).toEqual([]);
    });
  }
  for (const [name, scan] of Object.entries(SCANS)) {
    test(`every text-entry field on the ${name} belongs to a form in the table`, async ({ page, api, slot, names, today }) => {
      const seen = await scan(toCtx(page, api, slot.persist, names, today));
      expect(seen.length, "the scan opened fields").toBeGreaterThan(0);
      expect(unlisted(seen), UNLISTED).toEqual([]);
    });
  }
  test("a field is listed once: under its form or as part of none", () => {
    expect(Object.keys(FIELD_NAMES).filter((n) => n in NOT_IN_A_FORM)).toEqual([]);
  });
  test("every form in the table has a driver and every driver has rows", () => {
    const forms = new Set(FORM_ROWS.map((r) => r.form));
    expect([...forms].sort()).toEqual(Object.keys(DRIVERS).sort());
  });
});
