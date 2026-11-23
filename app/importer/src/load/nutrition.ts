/**
 * Person Nutrition -> intake items (log_intake), one write per row, so each
 * item keeps its row as origin. A ref'd row is the catalogue entry times
 * its quantity in servings; a ref-less row keeps its typed macros as manual
 * macros (they are inputs, not formulas). Legacy DAY TOTAL rows and NONE
 * rows become the day's status (set_day_status).
 */
import type { Row } from "../grid";
import { importRead } from "@myfitnessguide/worker/importing";
import { ParseError } from "../parse";
import { originKey } from "../rulings";
import { PERSON_FILES } from "../layout";
import { round9, sourceFact } from "./catalogue";
import { Loader, RowReader } from "./context";

type Slot = "breakfast" | "lunch" | "dinner" | "snack" | "pre_workout" | "post_workout";

const SLOTS: Record<string, Slot> = {
  breakfast: "breakfast", lunch: "lunch", dinner: "dinner", snack: "snack", "pre-workout": "pre_workout", "pre workout": "pre_workout",
  "pre-workout snack": "pre_workout", "post-workout": "post_workout", "post workout": "post_workout", evening: "snack", dessert: "snack",
};

export function slotForHour(fraction: number): Slot {
  const h = fraction * 24;
  return h < 11 ? "breakfast" : h < 16 ? "lunch" : h < 19 ? "snack" : "dinner";
}

export function provenanceOf(source: string): "label" | "estimated" {
  return /label|published|provider-declared/i.test(source) ? "label" : "estimated";
}

interface DayFacts {
  items: number;
  total: { row: Row; kcal: number; protein_g: number; carbs_g: number; fat_g: number } | null;
  skipped: Set<Slot>;
  origin: Row;
}

export async function loadNutrition(ld: Loader): Promise<void> {
  for (const file of Object.keys(PERSON_FILES)) {
    const member = ld.memberOfFile(file);
    const sheet = ld.sheet(file, "Nutrition");
    if (!member || !sheet) continue;
    const days = new Map<string, DayFacts>();
    const day = (d: string, row: Row) => {
      let x = days.get(d);
      if (!x) days.set(d, (x = { items: 0, total: null, skipped: new Set(), origin: row }));
      return x;
    };
    for (const row of sheet.rows()) {
      if (row.blank("A") && row.blank("C") && row.blank("M")) continue;
      await loadRow(ld, member, row, day);
    }
    for (const [d, facts] of [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) await loadDay(ld, member, d, facts);
  }
}

async function loadRow(ld: Loader, member: string, row: Row, day: (d: string, row: Row) => DayFacts): Promise<void> {
  const origin = ld.origin(row);
  const rd = new RowReader(ld, row);
  let date: string | null;
  try {
    date = rd.date("A");
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    date = null;
  }
  if (!date) {
    ld.book.raise({ origin, code: "unreadable_date", kind: "semantic", problem: `Date "${row.text("A")}" is not a date.`, proposed_fix: "Give the date, or leave the row out.", proposal: null, row: row.cells(["A", "B", "C", "D"]) });
    return;
  }
  const meal = row.raw("B");
  const mealText = typeof meal === "string" ? meal.trim() : "";
  const item = row.text("C");

  if (mealText.toUpperCase() === "DAY TOTAL") {
    try {
      const [kcal, protein_g, carbs_g, fat_g] = ["E", "F", "G", "H"].map((c) => rd.num(c) ?? 0) as [number, number, number, number];
      rd.flush();
      day(date, row).total = { row, kcal, protein_g, carbs_g, fat_g };
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      ld.book.raise({ origin, code: "unreadable_value", kind: "semantic", problem: error.message, proposed_fix: "Correct the total, or leave it out.", proposal: null, row: row.cells(["A", "B", "E", "F", "G", "H"]) });
    }
    return;
  }

  let slot: Slot | undefined = SLOTS[mealText.toLowerCase()];
  if (!slot) {
    const proposal = typeof meal === "number" && meal > 0 && meal < 1 ? slotForHour(meal) : mealText.toLowerCase() === "meal" ? "lunch" : null;
    const r = ld.book.raise<Slot>({
      origin, code: "meal_slot", kind: "semantic",
      problem: typeof meal === "number" ? `Meal holds ${meal}, a time of day (${row.rendered("B") || "a day fraction"}), not a meal name.` : `Meal "${mealText}" is not a meal slot.`,
      proposed_fix: proposal ? `Use ${proposal}${typeof meal === "number" ? " (by the hour)" : ""}, or give the slot as override.` : "Give the slot as override, or leave the row out.",
      proposal, row: row.cells(["A", "B", "C", "D"]),
    });
    if (!r.apply) return;
    slot = r.value;
  }

  if (item.toUpperCase() === "NONE") {
    rd.flush();
    day(date, row).skipped.add(slot);
    return;
  }

  const confidence = row.text("I").toLowerCase();
  const source = row.text("J");
  const label = [item, row.text("D") ? `(${row.text("D")})` : ""].filter(Boolean).join(" ");
  const note = [row.text("K"), source ? `Sheets source: ${source}` : "", ["low", "medium", "high"].includes(confidence) ? "" : "Confidence not recorded in Sheets."].filter(Boolean).join("; ");
  const common = {
    provenance: provenanceOf(source),
    confidence: ["low", "medium", "high"].includes(confidence) ? confidence : "medium",
    ...(label ? { label } : {}),
    ...(note ? { note } : {}),
  };
  const ref = row.text("M").toUpperCase();
  let itemInput: Record<string, unknown>;
  try {
    if (ref) {
      const qty = rd.num("N");
      if (qty === null || !(qty > 0)) throw new ParseError(`qty "${row.text("N")}" is not a positive number of servings`);
      if (ref.startsWith("FS")) {
        const fact = sourceFact(ld, ref);
        if (!fact) return unknownRef(ld, row, ref);
        itemInput = { source: "food", food: ref, value: round9(qty * fact.reference_amount), unit: fact.reference_unit, ...common };
      } else {
        if (!ld.facts.has(`recipe:${ref}`)) return unknownRef(ld, row, ref);
        itemInput = { source: "recipe", recipe: ref, servings: qty, ...common };
      }
    } else {
      const [kcal, protein_g, carbs_g, fat_g] = ["E", "F", "G", "H"].map((c) => rd.num(c));
      if ([kcal, protein_g, carbs_g, fat_g].some((v) => v === null)) throw new ParseError("a row with no ref must carry its four typed macros (E-H)");
      itemInput = { source: "manual", kcal, protein_g, carbs_g, fat_g, reason: "Typed macros in Sheets (no catalogue ref).", ...common };
    }
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    ld.book.raise({ origin, code: "unreadable_value", kind: "semantic", problem: error.message, proposed_fix: "Correct the row, or leave it out.", proposal: null, row: row.cells(["A", "B", "C", "D", "E", "F", "G", "H", "M", "N"]) });
    return;
  }
  rd.flush();
  let res = await ld.write("log_intake", { member, date, meal_slot: slot, items: [itemInput] }, origin, { evidence: row });
  if (!res) {
    // A refused row ruled to be replaced by manual macros (a meal idea logged as eaten).
    const refused = ld.book.get(`${originKey(origin)}/rejected_by_api/log_intake`);
    const ov = refused?.override as { manual_macros?: { kcal: number; protein_g: number; carbs_g: number; fat_g: number }; provenance?: string; confidence?: string; reason?: string } | null | undefined;
    if (refused?.decision !== "accepted" || !ov?.manual_macros) return;
    const manual = {
      source: "manual", ...ov.manual_macros, reason: ov.reason ?? "Replaces a row the API refused (ruled).",
      provenance: ov.provenance ?? common.provenance, confidence: ov.confidence ?? common.confidence,
      ...(common.label ? { label: common.label } : {}), ...(common.note ? { note: common.note } : {}),
    };
    res = await ld.write("log_intake", { member, date, meal_slot: slot, items: [manual] }, origin, { evidence: row, key: "log_intake_manual", reason: `import ${origin.file} ${origin.tab} row ${origin.row}, as ruled: manual macros` });
    if (!res) return;
  }
  day(date, row).items++;
  for (const it of res.items as { id: number }[]) ld.record(origin, { table: "intake_item", id: it.id, tool: "log_intake" });
}

function unknownRef(ld: Loader, row: Row, ref: string): void {
  ld.book.raise({
    origin: ld.origin(row), code: "unknown_ref", kind: "semantic",
    problem: `ref ${ref} is not a loaded food source or recipe.`,
    proposed_fix: "Correct the ref, or import the row as manual macros, or leave it out.", proposal: null, row: row.cells(["A", "B", "C", "D", "E", "M", "N"]),
  });
}

const REMAINDER_LABEL = "Unitemised (DAY TOTAL minus items)";

/**
 * The part of a DAY TOTAL its items don't account for, as one manual item
 * (a ruling's keep_items_plus_remainder). The items' totals come from the
 * API's own day_totals, so the item makes the day add up to the DAY TOTAL.
 * A macro the items already exceed can't be a negative manual value: that
 * is a ruling, and the item is left out until it is decided.
 */
async function unitemised(ld: Loader, member: string, date: string, t: NonNullable<DayFacts["total"]>, provenance: string): Promise<void> {
  const origin = ld.origin(t.row);
  const totals = await importRead(ld.db, "day_totals", { member, date }, ld.at);
  const so = (totals.so_far ?? {}) as Record<string, { value: number } | undefined>;
  const left = (total: number, key: string) => Math.round((total - (so[key]?.value ?? 0)) * 100) / 100;
  const macros = { kcal: left(t.kcal, "kcal"), protein_g: left(t.protein_g, "protein"), carbs_g: left(t.carbs_g, "carbs"), fat_g: left(t.fat_g, "fat") };
  let values = macros;
  if (Object.values(macros).some((v) => v < 0)) {
    const r = ld.book.raise<typeof macros>({
      origin, code: "remainder_below_items", kind: "semantic",
      problem: `The items of ${date} already exceed its DAY TOTAL on ${Object.entries(macros).filter(([, v]) => v < 0).map(([k]) => k).join(", ")}, so the unitemised remainder would be negative there.`,
      proposed_fix: "Count those macros as 0 in the unitemised item.", proposal: Object.fromEntries(Object.entries(macros).map(([k, v]) => [k, Math.max(0, v)])) as typeof macros,
      day: date, row: t.row.cells(["A", "B", "E", "F", "G", "H"]),
    });
    if (!r.apply) return;
    values = r.value;
  }
  const item = { source: "manual", ...values, reason: "The Sheets DAY TOTAL exceeds the day's items; the difference was never itemised (ruled).", provenance, confidence: "low", label: REMAINDER_LABEL };
  const res = await ld.write("log_intake", { member, date, meal_slot: "snack", items: [item] }, origin, { evidence: t.row, key: "remainder" });
  if (!res) return;
  for (const it of res.items as { id: number }[]) ld.record(origin, { table: "intake_item", id: it.id, tool: "log_intake" });
  ld.facts.set(`remainder:${member}\u0000${date}`, { kcal: values.kcal, protein: values.protein_g, carbs: values.carbs_g, fat: values.fat_g, ruling: `${originKey(origin)}/day_total_with_items` });
}

async function loadDay(ld: Loader, member: string, date: string, facts: DayFacts): Promise<void> {
  if (!facts.total && facts.skipped.size === 0) return;
  const originRow = facts.total?.row ?? facts.origin;
  const origin = ld.origin(originRow);
  const input: Record<string, unknown> = { member, date, status: facts.total ? "complete" : "open" };
  if (facts.skipped.size > 0) input.skipped_meals = [...facts.skipped].sort();
  if (facts.total) {
    const t = facts.total;
    const mech = ld.book.raise({
      origin, code: "legacy_day_total", kind: "mechanical",
      problem: `A legacy DAY TOTAL row (${t.kcal} kcal) would double-count the day if read as an item.`,
      proposed_fix: "Keep it as the day's manual total, used only while the day has no items; mark the day complete.",
      proposal: { kcal: t.kcal, protein_g: t.protein_g, carbs_g: t.carbs_g, fat_g: t.fat_g }, day: date, row: t.row.cells(["A", "B", "E", "F", "G", "H"]),
    });
    if (!mech.apply) return;
    if (facts.items > 0) {
      const r = ld.book.raise<string | { keep_items_plus_remainder?: boolean; provenance?: string }>({
        origin, code: "day_total_with_items", kind: "semantic",
        problem: `${date} has ${facts.items} logged items and a DAY TOTAL of ${t.kcal} kcal; the two may disagree.`,
        proposed_fix: "Keep the items as the day's record; the DAY TOTAL is stored as the day's manual total, which the app ignores while items exist. Or override { keep_items_plus_remainder: true } to add the difference as an unitemised item.",
        proposal: "keep_items", day: date, row: t.row.cells(["A", "B", "E", "F", "G", "H"]),
      });
      if (!r.apply) return;
      if (typeof r.value === "object" && r.value?.keep_items_plus_remainder) await unitemised(ld, member, date, t, r.value.provenance ?? "reconstructed");
    }
    input.manual_total = { kcal: t.kcal, protein_g: t.protein_g, carbs_g: t.carbs_g, fat_g: t.fat_g, reason: "Legacy DAY TOTAL row in Sheets." };
  }
  await ld.write("set_day_status", input, origin, { evidence: originRow, key: "day_status" });
}
