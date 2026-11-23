/**
 * One row per form × case (e2e spec §7): the same awkward inputs part 2 gives
 * its plan builders (AWKWARD, NOT_DECIMAL), in the browser. Each row expects
 * one outcome: refused (no write goes out, and the form's own refusal, its
 * "What to fix" line or its alert, says what to type), asks
 * (needs_clarification in the form, nothing written), or taken (the field's own
 * stored column, read back, equals what was typed in the unit shown, so never
 * 100× it; a blank micronutrient is stored as null, never 0). Every number
 * field also has a "decimal" row: a non-zero value (non-integer where the field
 * takes decimals) that must be stored as typed, through the field's scale.
 * FIELD_NAMES maps each text-entry field the sweep's states and the scans of
 * the catalogue's small forms show, by "<where> › <name>", to the form it is
 * part of, and NOT_IN_A_FORM names, with why, the fields that are part of none:
 * a field in neither fails the exhaustiveness test, so a new form can't skip
 * the table (F10).
 */
import { AWKWARD, NOT_DECIMAL } from "../test/property/arbitraries.ts";

export type FormName =
  | "Food amount" | "New food" | "Pot share" | "Leftover share" | "Set" | "Cardio" | "Workout" | "Reading"
  | "Tell Claude" | "Feedback" | "Catalogue edit" | "Add measure" | "Add yield" | "Teach a word" | "Recipe line" | "Record plates"
  | "Today's pot share" | "Catalogue new food" | "Catalogue new recipe";
export type CaseName = "empty" | "zero" | "huge" | "huge-exponent" | "long" | "pasted" | "emoji" | "wrong-unit" | "decimal";
export type Outcome = "refused" | "asks" | "taken";

/** What the app does today with a disputed row (ticket 80): a companion test asserts it, so a change shows before the ruling. */
export type Observed =
  /** Saved: the field's column (or the driver's read-back) holds `stored`. */
  | { outcome: "taken"; stored: unknown }
  /** The form asks (needs_clarification), its words matching `says`; nothing written. */
  | { outcome: "asks"; says: RegExp }
  /** The request goes out and the API refuses it (4xx); the form's save line says `says`; nothing written. */
  | { outcome: "refused by the API"; says: RegExp }
  /** Save is disabled and the form says nothing; no request, nothing written. */
  | { outcome: "refused without a message" };

export interface FormRow {
  form: FormName;
  field: string;
  kind: "number" | "text";
  case: CaseName;
  value: string;
  /** Put in by a real paste (the clipboard), not typed. */
  paste?: true;
  /** A unit chip pressed before the value goes in. */
  chip?: string;
  /** Other fields of the same form, set for this row after the value (by the driver's field names): a zero food has every macro 0. */
  with?: Readonly<Record<string, string>>;
  expect: Outcome;
  /** A taken row whose stored value is not the typed one, by the app's documented rule (empty leftover is all that is left). */
  stored?: unknown;
  /** Also run at 1,440 (the catalogue's forms). */
  wide?: true;
  /** The app does something else; sent to Hritvik as ticket 80. The row stays listed and runs as fixme. */
  disputed?: string;
  /** What the app does today, for the disputed row's companion test. */
  observed?: Observed;
}

/** Part 2's strings, by value, so the browser and the plan builders face one list. */
function from<T extends readonly string[]>(list: T, value: string): string {
  if (!list.includes(value)) throw new Error(`${JSON.stringify(value.slice(0, 20))} is not in part 2's list`);
  return value;
}
const S = {
  empty: from(AWKWARD, ""),
  zero: from(AWKWARD, "0"),
  huge: from(AWKWARD, "9".repeat(400)),
  hugeExponent: from(NOT_DECIMAL, "1e400"),
  long: from(AWKWARD, "x".repeat(5000)),
  emoji: from(AWKWARD, "12💪"),
  /** A newline, a non-breaking space and a comma decimal, pasted. */
  pasted: " 1,5\n",
};

type Overrides = Partial<Record<CaseName, Outcome | Partial<FormRow>>>;

const rowsOf = (form: FormName, field: string, kind: FormRow["kind"], wide: boolean, over: Overrides, cases: readonly [CaseName, string, Outcome, Partial<FormRow>?][]): FormRow[] =>
  cases.map(([c, value, fallback, extra]) => {
    const o = over[c];
    const patch = typeof o === "string" ? { expect: o } : (o ?? {});
    return { form, field, kind, case: c, value, expect: fallback, ...(wide ? { wide: true as const } : {}), ...extra, ...patch };
  });

/**
 * A number field's eight rows: the seven awkward ones, refused unless overridden (0 is a real value for some
 * fields), and `decimal`, a valid non-zero value (non-integer where the field takes decimals) that is taken.
 */
function numberRows(form: FormName, field: string, decimal: string, over: Overrides = {}, wide = false): FormRow[] {
  return rowsOf(form, field, "number", wide, over, [
    ["empty", S.empty, "refused"], ["zero", S.zero, "refused"], ["huge", S.huge, "refused"], ["huge-exponent", S.hugeExponent, "refused"],
    ["long", S.long, "refused"], ["pasted", S.pasted, "refused", { paste: true }], ["emoji", S.emoji, "refused"], ["decimal", decimal, "taken"],
  ]);
}

/** A text field's four rows: empty is refused; the rest are taken unless overridden. */
function textRows(form: FormName, field: string, over: Overrides = {}, wide = false): FormRow[] {
  return rowsOf(form, field, "text", wide, over, [["empty", S.empty, "refused"], ["long", S.long, "taken"], ["pasted", S.pasted, "taken", { paste: true }], ["emoji", S.emoji, "taken"]]);
}

/** Every macro 0 but the one under test: a true zero food, so a 0 doesn't contradict the others (energy_mismatch). */
const zeroFood = (field: string): Partial<FormRow> => ({ expect: "taken", with: Object.fromEntries(["kcal", "protein", "carbs", "fat"].filter((k) => k !== field).map((k) => [k, "0"])) });

const ROWS: readonly FormRow[] = [
  ...numberRows("Food amount", "How much", "2.5"),
  { form: "Food amount", field: "How much", kind: "number", case: "wrong-unit", value: "70 lb", expect: "refused" },
  ...textRows("New food", "Name", { long: "refused" }),
  ...numberRows("New food", "kcal", "114.5", { zero: zeroFood("kcal") }),
  ...numberRows("Pot share", "share", "2.5"),
  ...numberRows("Today's pot share", "share", "2.5"),
  // Empty is all that is left of the pot, by design (writes.ts leftoverShare, click test P2-27): the seed's first leftover has 5% left.
  ...numberRows("Leftover share", "share", "2.5", { empty: { expect: "taken", stored: 0.05 } }),
  ...numberRows("Set", "Load", "2.5"),
  { form: "Set", field: "Load", kind: "number", case: "wrong-unit", value: "70 lb", expect: "refused" },
  // Reps and reps in reserve are whole numbers: their decimal row is a non-zero whole one.
  ...numberRows("Set", "Reps", "7"),
  ...numberRows("Set", "RIR", "3", { zero: "taken" }),
  // What is optional (cardioPlan): empty saves the cardio with no activity.
  ...textRows("Cardio", "What", { long: "refused", empty: { expect: "taken", stored: null } }),
  ...numberRows("Cardio", "Minutes", "2.5"),
  ...numberRows("Workout", "Load", "2.5"),
  ...numberRows("Workout", "Reps", "7"),
  ...numberRows("Reading", "value", "84.5"),
  { form: "Reading", field: "value", kind: "number", case: "wrong-unit", value: "33", chip: "cm", expect: "asks" },
  ...textRows("Tell Claude", "text"),
  ...textRows("Feedback", "text", { long: "refused" }),
  ...numberRows("Catalogue edit", "kcal", "357.5", { zero: zeroFood("kcal") }, true),
  ...numberRows("Catalogue edit", "protein", "11.5", { zero: zeroFood("protein") }, true),
  ...numberRows("Catalogue edit", "micronutrient", "2.5", { zero: "taken", empty: "taken" }, true),
  ...textRows("Add measure", "name", { long: "refused" }, true),
  ...numberRows("Add measure", "amount", "2.5", {}, true),
  ...numberRows("Add yield", "factor", "2.5", {}, true),
  ...textRows("Teach a word", "word", { long: "refused" }, true),
  ...numberRows("Recipe line", "amount", "2.5", {}, true),
  // The field is a list (catalogue.ts parseNumberList): a pasted "1,5" is plates 1 and 5. Stored: the gym's plates as seen.
  ...numberRows("Record plates", "plate", "1.25", { pasted: { expect: "taken", stored: [1, 5] }, decimal: { stored: [1.25] } }, true),
  ...textRows("Catalogue new food", "Name", { long: "refused" }, true),
  ...numberRows("Catalogue new food", "Per how much", "2.5", {}, true),
  ...numberRows("Catalogue new food", "kcal", "114.5", { zero: zeroFood("kcal") }, true),
  ...numberRows("Catalogue new food", "micronutrient", "2.5", { zero: "taken", empty: "taken" }, true),
  ...textRows("Catalogue new recipe", "Name", { long: "refused" }, true),
  ...numberRows("Catalogue new recipe", "Servings", "2.5", {}, true),
  ...numberRows("Catalogue new recipe", "amount", "2.5", {}, true),
];

/**
 * Rows where the app does something else than the row expects, sent to Hritvik as ticket 80, keyed
 * "<form> · <field> · <case>": each runs as fixme until he rules, and a companion test asserts `observed`, what
 * the app does today, so a change shows before the ruling. Every entry was seen on 10 Oct 2026.
 */
const DISPUTED: Record<string, { why: string; observed: Observed }> = {
  // No length cap: a 5,000-character name or text is saved whole.
  "New food · Name · long": { why: "a 5,000-character name typed in the Food tab's New food is saved whole (food_source.name)", observed: { outcome: "taken", stored: S.long } },
  "Cardio · What · long": { why: "a 5,000-character What is saved whole (cardio_block.activity)", observed: { outcome: "taken", stored: S.long } },
  "Add measure · name · long": { why: "a 5,000-character measure name is saved whole (measure.name)", observed: { outcome: "taken", stored: S.long } },
  "Catalogue new food · Name · long": { why: "a 5,000-character name on the New food page is saved whole (food_source.name)", observed: { outcome: "taken", stored: S.long } },
  "Catalogue new recipe · Name · long": { why: "a 5,000-character name on the New recipe page is saved whole (recipe.name)", observed: { outcome: "taken", stored: S.long } },
  // 0 is saved: a 0 kg load and 0 reps.
  "Set · Load · zero": { why: "Load 0 (kg, Weight chip) with reps 9 saves: session_set.load_value 0, \"Set logged.\"", observed: { outcome: "taken", stored: 0 } },
  "Set · Reps · zero": { why: "Reps 0 with load 35 kg saves: session_set.reps 0, \"Set logged.\"", observed: { outcome: "taken", stored: 0 } },
  "Workout · Load · zero": { why: "Load 0 kg with reps 10 in a workout from nothing saves: session_set.load_value 0", observed: { outcome: "taken", stored: 0 } },
  "Workout · Reps · zero": { why: "Reps 0 with load 35 kg in a workout from nothing saves: session_set.reps 0", observed: { outcome: "taken", stored: 0 } },
  // Refused with no message: Save is only disabled (spec §7 wants a message).
  "Tell Claude · text · empty": { why: "nothing typed: Send to Claude is disabled and the tab says nothing", observed: { outcome: "refused without a message" } },
  "Feedback · text · empty": { why: "nothing typed: Send is disabled and the sheet says nothing", observed: { outcome: "refused without a message" } },
  "Today's pot share · share · empty": { why: "Share (%) left empty: Save is disabled and the form says nothing (FoodTab.tsx PotShare shows its line only once something is typed)", observed: { outcome: "refused without a message" } },
  // Refused by the API, not the form: the request goes out (spec §7: no /tools request), nothing is written.
  "Feedback · text · long": { why: "5,000 characters: submit_feedback goes out and answers 400 (at most 2,000)", observed: { outcome: "refused by the API", says: /Not saved: text: Too big: expected string to have <=2000 characters/ } },
  "Teach a word · word · long": { why: "a 5,000-character word: learn_alias goes out and answers 400 (at most 60)", observed: { outcome: "refused by the API", says: /Not saved: alias: Too big: expected string to have <=60 characters/ } },
  "Record plates · plate · zero": { why: "Seen on the rack 0: record_plates goes out and answers 400 (a plate is more than 0)", observed: { outcome: "refused by the API", says: /Not saved: available\.0: Too small: expected number to be >0/ } },
};

const keyOf = (r: FormRow) => `${r.form} · ${r.field} · ${r.case}`;
// A ruling's key that names no row would leave the row it meant running unmarked.
for (const k of Object.keys(DISPUTED)) if (!ROWS.some((r) => keyOf(r) === k)) throw new Error(`DISPUTED names no row: ${k}`);

export const FORM_ROWS: readonly FormRow[] = ROWS.map((r) => {
  const d = DISPUTED[keyOf(r)];
  return d ? { ...r, disputed: `ticket 80: ${d.why}`, observed: d.observed } : r;
});

/**
 * A text-entry field, by "<where> › <name>" (forms.spec.ts fieldsInView: where is its catalogue form, the Add
 * sheet's open tab, its dialog or its named section; the name is its accessible name), to the form it is part of:
 * never a form it merely sits near (F10). Every field the swept states, the small-form scans and the drivers' own
 * forms show is here, in NOT_IN_A_FORM, or matched by FIELD_PATTERNS.
 */
export const FIELD_NAMES: Record<string, FormName> = {
  // The Add sheet's Food tab: the amount step (its uncertainty fields sit in a closed <details>), New food.
  "Food › How much": "Food amount",
  "Food › What": "Food amount",
  "Food › ± kcal": "Food amount",
  "Food › Name": "New food",
  "Food › kcal": "New food",
  "Food › protein": "New food",
  "Food › carbs": "New food",
  "Food › fat": "New food",
  "Food › A measure (optional)": "New food",
  "Food › It holds (g)": "New food",
  "Food › It holds (ml)": "New food",
  "Food › If the label really says this, say so": "New food",
  // A dish cooked for the household (MealPanel.tsx): its eaters' shares and lines match FIELD_PATTERNS.
  "Food › Dish": "Pot share",
  "Food › Whole pot, weighed (g)": "Pot share",
  "Food › New recipe's name": "Pot share",
  // A share of today's pot (FoodTab.tsx PotShare), in % or grams.
  "Food › Share (%)": "Today's pot share",
  "Food › Grams": "Today's pot share",
  "Leftovers › How much of the pot (%)": "Leftover share",
  // The Set tab: a set (its plate builder's bar included), or Cardio instead.
  "Set › Load": "Set",
  "Set › Reps": "Set",
  "Set › Seconds": "Set",
  "Set › RIR": "Set",
  "Set › RIR (optional)": "Set",
  "Set › Bar weight": "Set",
  "Set › What": "Cardio",
  "Set › Minutes": "Cardio",
  "Set › Distance (km, optional)": "Cardio",
  "Set › Average heart rate (optional)": "Cardio",
  "Workout › Add an exercise": "Workout",
  "Workout › Load": "Workout",
  "Workout › Reps": "Workout",
  "Workout › Seconds": "Workout",
  "Workout › Distance": "Workout",
  "Workout › RIR": "Workout",
  "Workout › Swap for": "Workout",
  "Workout › New workout's name": "Workout",
  "Workout › Bar weight": "Workout",
  "Tell Claude › Say what you had or did, the way you'd say it. Claude will log it.": "Tell Claude",
  "Send feedback › What happened, or what you'd like": "Feedback",
  // A food's or recipe's Edit (EditForm.tsx, catalogue.ts FOOD_FIELDS and RECIPE_FIELDS).
  "Edit a record › Name": "Catalogue edit",
  "Edit a record › Energy (kcal)": "Catalogue edit",
  "Edit a record › Protein (g)": "Catalogue edit",
  "Edit a record › Carbs (g)": "Catalogue edit",
  "Edit a record › Fat (g)": "Catalogue edit",
  "Edit a record › Fibre (g)": "Catalogue edit",
  "Edit a record › Saturated fat (g)": "Catalogue edit",
  "Edit a record › Sugars (g)": "Catalogue edit",
  "Edit a record › Sodium (mg)": "Catalogue edit",
  "Edit a record › Potassium (mg)": "Catalogue edit",
  "Edit a record › Calcium (mg)": "Catalogue edit",
  "Edit a record › Iron (mg)": "Catalogue edit",
  "Edit a record › Magnesium (mg)": "Catalogue edit",
  "Edit a record › B12 (µg)": "Catalogue edit",
  "Edit a record › Vitamin C (mg)": "Catalogue edit",
  "Edit a record › Lowest price (₹)": "Catalogue edit",
  "Edit a record › Highest price (₹)": "Catalogue edit",
  "Edit a record › Category": "Catalogue edit",
  "Edit a record › Tags": "Catalogue edit",
  "Edit a record › Servings": "Catalogue edit",
  "Edit a record › Meal type": "Catalogue edit",
  "Edit a record › Method": "Catalogue edit",
  "Edit a record › Why the change?": "Catalogue edit",
  "Edit a record › Keep these values anyway? Say why": "Catalogue edit",
  // The catalogue's New food and New recipe pages (NewFood.tsx, NewRecipe.tsx), the reason included.
  "New food › Name": "Catalogue new food",
  "New food › Per how much": "Catalogue new food",
  "New food › Energy (kcal)": "Catalogue new food",
  "New food › Protein (g)": "Catalogue new food",
  "New food › Carbs (g)": "Catalogue new food",
  "New food › Fat (g)": "Catalogue new food",
  "New food › Fibre (g)": "Catalogue new food",
  "New food › Saturated fat (g)": "Catalogue new food",
  "New food › Sugars (g)": "Catalogue new food",
  "New food › Sodium (mg)": "Catalogue new food",
  "New food › Potassium (mg)": "Catalogue new food",
  "New food › Calcium (mg)": "Catalogue new food",
  "New food › Iron (mg)": "Catalogue new food",
  "New food › Magnesium (mg)": "Catalogue new food",
  "New food › B12 (µg)": "Catalogue new food",
  "New food › Vitamin C (mg)": "Catalogue new food",
  "New food › Lowest price (₹)": "Catalogue new food",
  "New food › Highest price (₹)": "Catalogue new food",
  "New food › Category": "Catalogue new food",
  "New food › Tags": "Catalogue new food",
  "New food › Keep these values anyway? Say why": "Catalogue new food",
  "New food › Why add it?": "Catalogue new food",
  "New recipe › Name": "Catalogue new recipe",
  "New recipe › Servings": "Catalogue new recipe",
  "New recipe › Meal type": "Catalogue new recipe",
  "New recipe › Method": "Catalogue new recipe",
  "New recipe › Line 1: food": "Catalogue new recipe",
  "New recipe › Amount": "Catalogue new recipe",
  "New recipe › Why add it?": "Catalogue new recipe",
  // The record's small forms (SmallForm.tsx), each with its reason.
  "Add a measure › Measure, like katori": "Add measure",
  "Add a measure › Amount (g)": "Add measure",
  "Add a measure › Amount (ml)": "Add measure",
  "Add a measure › Amount (piece)": "Add measure",
  "Add a measure › Why?": "Add measure",
  "Add a yield › 1 g becomes (g)": "Add yield",
  "Add a yield › Thrown away (%)": "Add yield",
  "Add a yield › Why?": "Add yield",
  "Teach a word › Word": "Teach a word",
  "Teach a word › Why?": "Teach a word",
  // A recipe's Add a line. (A workout's Add a line has the same form name and its own fields: NOT_IN_A_FORM.)
  "Add a line › Food": "Recipe line",
  "Add a line › Amount": "Recipe line",
  "Add a line › Why?": "Recipe line",
  "Record plates › Seen on the rack": "Record plates",
  "Record plates › Not there": "Record plates",
  "Record plates › Why?": "Record plates",
};

/** Fields whose name carries a value (a member's name, a food, a metric and its unit), by pattern, to their form. */
export const FIELD_PATTERNS: readonly (readonly [RegExp, FormName])[] = [
  [/^Food › .+'s share$/, "Pot share"],
  [/^Food › .+ amount$/, "Pot share"],
  [/^Food › How much .+$/, "Pot share"],
  [/^Reading › .+(, in .+| \(choose the unit\))$/, "Reading"],
];

const TICKET_80 = "a form spec §7 doesn't list, taking a value a member types; sent with ticket 80 for Hritvik to rule whether it gets rows";

/**
 * Text-entry fields that are part of none of the forms, each with why it has no rows (F10). An entry here is a
 * decision: add one only with its reason, and give a field a form of its own instead when it takes a value a member
 * types (those below are waiting on ticket 80).
 */
export const NOT_IN_A_FORM: Record<string, string> = {
  "Add a line › Exercise": `A workout's Add a line (Workouts.tsx): ${TICKET_80}`,
  "Add a line › Sets": `A workout's Add a line (Workouts.tsx): ${TICKET_80}`,
  "Add a line › Reps from": `A workout's Add a line (Workouts.tsx): ${TICKET_80}`,
  "Add a line › Reps to": `A workout's Add a line (Workouts.tsx): ${TICKET_80}`,
  "Change amount › Amount": `A recipe line's Change amount (RecipeRecord.tsx, an amend): ${TICKET_80}`,
  "Change amount › Why?": "Change amount's reason: a write's reason, not a value (its Amount waits on ticket 80)",
  "Add a load › Loads it has": `A gym implement's Add a load (Gyms.tsx): ${TICKET_80}`,
  "Add a load › Why?": "Add a load's reason: a write's reason, not a value (its loads wait on ticket 80)",
  "Remove a load › Loads it doesn't have": `A gym implement's Remove a load (Gyms.tsx): ${TICKET_80}`,
  "Remove a load › Why?": "Remove a load's reason: a write's reason, not a value (its loads wait on ticket 80)",
  "Change the bar's weight › Weight": `A gym implement's bar weight (Gyms.tsx, an amend): ${TICKET_80}`,
  "Change the bar's weight › Why?": "The bar weight's reason: a write's reason, not a value (its weight waits on ticket 80)",
};

/** Fields that are part of none of the forms, by pattern: a logged item's or set's own edit (Fix.tsx), whose labels carry the unit. */
export const NOT_IN_A_FORM_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/^Edit this (item|set|cardio) › /, `Editing a logged item, set or cardio (Fix.tsx): ${TICKET_80}`],
];
