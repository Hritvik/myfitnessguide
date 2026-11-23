/**
 * The parity report (ticket *Parity gate for deleting formulas*): the
 * loaded data's computed values, read through the API's own tools and
 * views, against what the snapshot rendered.
 *
 * Each compared value is `within` tolerance, `explained` by a ruling naming
 * a cause (sheet-bug, missing-formula, rounding, typed-error,
 * manual-macros), or `unexplained`. Differences whose cause the gate ticket
 * already names are ruled mechanically; Log differences are typed values,
 * so each becomes a ruling (typed-error stays semantic). A difference
 * someone rules by hand in rulings.yaml (same id, a cause) is explained.
 *
 * The gate passes only when nothing is unexplained and no ruling is pending.
 */
import { importRead } from "@myfitnessguide/worker/importing";
import type { Row } from "./grid";
import { colIndex, colLetter as colLetterOf } from "./grid";
import { PERSON_FILES } from "./layout";
import type { Loader } from "./load/context";
import { parseDate, parseNumber, ParseError } from "./parse";
import { originKey, type Cause, type Origin, type Ruling } from "./rulings";

export type Status = "within" | "explained" | "unexplained";

export interface Comparison {
  id: string;
  group: string;
  origin: Origin;
  metric: string;
  sheet: number | null;
  app: number | null;
  delta: number | null;
  tolerance: number;
  status: Status;
  cause: Cause | null;
  ruling: string | null;
  decision: string | null;
  day: string | null;
  /** Rulings on rows of that day that hold a row back or change it (day totals only). */
  related?: string[];
}

export interface GroupSummary {
  group: string;
  compared: number;
  within: number;
  explained: number;
  unexplained: number;
  not_compared: number;
}

export interface ParityReport {
  version: 1;
  snapshot: string;
  gate: "PASS" | "FAIL";
  tolerances: Record<string, string>;
  summary: { compared: number; within: number; explained: number; unexplained: number; pending_rulings: number; explained_by_cause: Record<string, number> };
  groups: GroupSummary[];
  /** Rows loaded per table by this rehearsal. */
  loaded: Record<string, number>;
  /** Rulings by kind, decision and cause. */
  rulings: Record<string, number>;
  /** Every comparison not within tolerance, explained ones first by cause. */
  differences: Comparison[];
}

export const TOLERANCES = {
  row_kcal: 1,
  row_macro_g: 0.5,
  day_kcal: 5,
  day_macro_g: 2,
  micro_rel: 0.01,
  body_avg_kg: 0.05,
  ratio: 0.01,
  log_volume_kg: 1,
  log_e1rm_kg: 0.5,
};

const MACROS: [string, string, "kcal" | "g"][] = [["E", "kcal", "kcal"], ["F", "protein", "g"], ["G", "carbs", "g"], ["H", "fat", "g"]];
const ROW_MICROS: [string, string, number][] = [
  ["O", "sodium_mg", 0.1], ["P", "fibre_g", 0.1], ["Q", "iron_mg", 0.1], ["R", "b12_ug", 0.1], ["S", "calcium_mg", 0.1], ["T", "magnesium_mg", 0.1], ["U", "potassium_mg", 0.1],
  ["AA", "cost_min_inr", 0.01], ["AB", "cost_max_inr", 0.01],
];

interface Totals {
  [k: string]: { value: number; known: number; of: number } | undefined;
}

const known = (t: Totals | undefined, k: string): number | null => {
  const x = t?.[k];
  return x && x.known > 0 ? x.value : null;
};

function sheetNumber(row: Row, col: string): number | null {
  const text = row.rendered(col).trim();
  if (text === "") return null;
  try {
    return parseNumber(text.replace(/[₹%]/g, "")).value;
  } catch {
    return null;
  }
}

class Collector {
  readonly comparisons: Comparison[] = [];
  readonly notCompared = new Map<string, number>();

  constructor(readonly ld: Loader) {}

  skip(group: string, n = 1): void {
    this.notCompared.set(group, (this.notCompared.get(group) ?? 0) + n);
  }

  /**
   * Compare one value. `explain` names the cause when the difference
   * matches a pattern the gate ticket already rules (mechanical) or one
   * that needs Hritvik (semantic).
   */
  compare(x: {
    group: string;
    origin: Origin;
    metric: string;
    sheet: number | null;
    app: number | null;
    tolerance: number;
    day?: string | null;
    related?: string[];
    explain?: (sheet: number | null, app: number | null) => { cause: Cause; kind: "mechanical" | "semantic"; problem: string; fix: string } | null;
  }): void {
    const id = `${originKey(x.origin)}/parity/${x.metric}`;
    const delta = x.sheet !== null && x.app !== null ? x.app - x.sheet : null;
    const within = (x.sheet === null && x.app === null) || (delta !== null && Math.abs(delta) <= x.tolerance + 1e-9);
    const base = { id, group: x.group, origin: x.origin, metric: x.metric, sheet: x.sheet, app: x.app, delta, tolerance: x.tolerance, day: x.day ?? null, ...(x.related?.length ? { related: x.related } : {}) };
    if (within) {
      this.comparisons.push({ ...base, status: "within", cause: null, ruling: null, decision: null });
      return;
    }
    const pattern = x.explain?.(x.sheet, x.app) ?? null;
    let ruling: Ruling | null = null;
    if (pattern) {
      ruling = this.ld.book.raise({
        origin: x.origin, code: "parity", key: x.metric, kind: pattern.kind, cause: pattern.cause,
        problem: `${x.metric}: Sheets rendered ${x.sheet ?? "blank"}, the app computes ${x.app === null ? "nothing" : round(x.app)}. ${pattern.problem}`,
        proposed_fix: pattern.fix, proposal: pattern.cause, ...(x.day ? { day: x.day } : {}),
      }).ruling;
    } else {
      const prior = this.ld.book.previous(id);
      if (prior && prior.cause) {
        ruling = this.ld.book.raise({
          origin: x.origin, code: "parity", key: x.metric, kind: "semantic", cause: prior.cause,
          problem: `${x.metric}: Sheets rendered ${x.sheet ?? "blank"}, the app computes ${x.app === null ? "nothing" : round(x.app)}.`,
          proposed_fix: "Ruled by hand.", proposal: prior.cause, ...(x.day ? { day: x.day } : {}),
        }).ruling;
      }
    }
    if (ruling && ruling.decision !== "rejected" && ruling.cause) {
      this.comparisons.push({ ...base, status: "explained", cause: ruling.cause, ruling: ruling.id, decision: ruling.decision });
    } else {
      this.comparisons.push({ ...base, status: "unexplained", cause: null, ruling: ruling?.id ?? null, decision: ruling?.decision ?? null });
    }
  }
}

const round = (x: number) => Math.round(x * 1000) / 1000;

export async function parity(ld: Loader, snapshotName: string, loaded: Record<string, number> = {}): Promise<ParityReport> {
  const c = new Collector(ld);
  await nutritionRows(ld, c);
  await dayTotals(ld, c);
  await chartRollups(ld, c);
  derivedRecipes(ld, c);
  foodSourceColumns(ld, c);
  body(ld, c);
  log(ld, c);
  return summarise(ld, c, snapshotName, loaded);
}

// ------------------------------------------------------------ nutrition rows

async function itemsOf(ld: Loader, member: string, date: string, cache: Map<string, Map<number, Totals>>): Promise<Map<number, Totals>> {
  const key = `${member}\u0000${date}`;
  let m = cache.get(key);
  if (!m) {
    const res = await importRead(ld.db, "day_items", { member, date }, ld.at);
    m = new Map(((res.items as { id: number; nutrients: Totals }[] | undefined) ?? []).map((i) => [i.id, i.nutrients]));
    cache.set(key, m);
  }
  return m;
}

/** Days whose Sheets total is under-reported by a ref'd row that rendered blank (a missing formula). */
const missingFormulaDays = new WeakMap<Loader, Set<string>>();

async function nutritionRows(ld: Loader, c: Collector): Promise<void> {
  const cache = new Map<string, Map<number, Totals>>();
  const missing = new Set<string>();
  missingFormulaDays.set(ld, missing);
  for (const file of Object.keys(PERSON_FILES)) {
    const member = ld.memberOfFile(file);
    const sheet = ld.sheet(file, "Nutrition");
    if (!member || !sheet) continue;
    for (const row of sheet.rows()) {
      const ref = row.text("M").toUpperCase();
      if (!ref) {
        if (!row.blank("C")) c.skip("Nutrition rows", 1); // typed macros are inputs, carried over
        continue;
      }
      const origin = ld.origin(row);
      const rec = ld.recordsOf(origin).find((r) => r.table === "intake_item");
      let date: string | null = null;
      try {
        date = parseDate(row.raw("A")).value;
      } catch (error) {
        if (!(error instanceof ParseError)) throw error;
      }
      if (!rec || !date) {
        c.skip("Nutrition rows", 1); // not loaded: its ruling says why
        continue;
      }
      const nutrients = (await itemsOf(ld, member, date, cache)).get(rec.id);
      const isRecipe = ref.startsWith("R");
      for (const [col, key, unit] of MACROS) {
        const sheetValue = sheetNumber(row, col);
        if (sheetValue === null && row.formula(col) !== null) missing.add(`${member}\u0000${date}`);
        c.compare({
          group: "Nutrition rows", origin, metric: key === "kcal" ? "kcal" : `${key}_g`, sheet: sheetValue, app: known(nutrients, key),
          tolerance: unit === "kcal" ? TOLERANCES.row_kcal : TOLERANCES.row_macro_g, day: date,
          explain: (s) => (s === null ? missingFormula(date as string) : staleMirror(ld, row, ref, col)),
        });
      }
      for (const [col, key, unit] of ROW_MICROS) {
        const sheetValue = sheetNumber(row, col);
        const app = known(nutrients, key);
        c.compare({
          group: "Nutrition rows (micros, cost)", origin, metric: key, sheet: sheetValue, app,
          tolerance: Math.max(unit, Math.abs(sheetValue ?? app ?? 0) * TOLERANCES.micro_rel), day: date,
          explain: () =>
            key === "iron_mg" && isRecipe
              ? { cause: "sheet-bug", kind: "mechanical", problem: "Recipe iron in Sheets sums Recipe Ingredients!S (cost_priced_flag), not iron.", fix: "None: the app recomputes iron from food sources." }
              : app === null && isRecipe && (ld.facts.get(`recipe:${ref}`) as { derived: boolean } | undefined)?.derived === false
                ? { cause: "manual-macros", kind: "mechanical", problem: `${ref} is a stored recipe: the app keeps its typed macros as manual macros, with no micronutrients or cost, where Sheets summed its partial lines.`, fix: "None until the recipe is derived from complete lines." }
                : sheetValue === null && row.formula(col) === null
                  ? { cause: "missing-formula", kind: "mechanical", problem: "The cell has no formula.", fix: "None: the app computes it." }
                  : staleMirror(ld, row, ref, col),
        });
      }
    }
  }
}

function missingFormula(day: string) {
  return { cause: "missing-formula" as const, kind: "mechanical" as const, problem: `A ref'd row rendered blank, so Sheets under-reported ${day}.`, fix: "None: the app computes the row; that day's Sheets total was low." };
}

/** The person file's Catalogue mirror disagreeing with base: Sheets rendered the stale copy. */
function staleMirror(ld: Loader, row: Row, ref: string, col: string) {
  const mirror = ld.sheet(row.tab.file, "Catalogue");
  if (!mirror) return null;
  const mcol = ({ E: "D", F: "E", G: "F", H: "G", O: "L", P: "M", Q: "N", R: "O", S: "P", T: "Q", U: "R", AA: "U", AB: "V" } as Record<string, string>)[col];
  if (!mcol) return null;
  for (let n = 2; n <= mirror.data.rows; n++) {
    const m = mirror.row(n);
    if (m.text("A").toUpperCase() !== ref) continue;
    return {
      cause: "sheet-bug" as const, kind: "semantic" as const,
      problem: `Sheets computed it from ${row.tab.file}'s Catalogue mirror (${m.rendered(mcol)} per serving), which may disagree with base.`,
      fix: "Confirm base is right (the app uses base) and the mirror was stale.",
    };
  }
  return { cause: "sheet-bug" as const, kind: "semantic" as const, problem: `${ref} is missing from ${row.tab.file}'s Catalogue mirror, so Sheets could not look it up.`, fix: "Confirm the app's value (from base) is right." };
}

// ---------------------------------------------------------------- day totals

async function dayTotals(ld: Loader, c: Collector): Promise<void> {
  const missing = missingFormulaDays.get(ld) ?? new Set();
  const held = heldRows(ld);
  for (const file of Object.keys(PERSON_FILES)) {
    const member = ld.memberOfFile(file);
    const sheet = ld.sheet(file, "Daily Nutrition");
    if (!member || !sheet || !ld.facts.has(`member:${member}`)) continue;
    for (const row of sheet.renderedRows()) {
      let date: string | null = null;
      try {
        date = parseDate(row.raw("A")).value ?? parseDate(row.rendered("A")).value;
      } catch {
        date = null;
      }
      if (!date) continue;
      const origin = ld.origin(row);
      const res = await importRead(ld.db, "day_totals", { member, date }, ld.at);
      const so = (res.so_far as Totals | undefined) ?? {};
      const day = date;
      for (const [col, key, unit] of [["C", "kcal", "kcal"], ["D", "protein", "g"], ["E", "carbs", "g"], ["F", "fat", "g"]] as const) {
        c.compare({
          group: "Day totals", origin, metric: key === "kcal" ? "kcal" : `${key}_g`, sheet: sheetNumber(row, col), app: known(so, key) ?? 0,
          tolerance: unit === "kcal" ? TOLERANCES.day_kcal : TOLERANCES.day_macro_g, day,
          related: held.get(`${file}\u0000${day}`) ?? [],
          explain: (s, a) => (missing.has(`${member}\u0000${day}`) ? missingFormula(day) : unitemised(ld, member, day, key, s, a, unit === "kcal" ? TOLERANCES.day_kcal : TOLERANCES.day_macro_g)),
        });
      }
    }
  }
}

const CHART_COLUMNS: Record<string, [string, "macro_kcal" | "macro_g" | "micro" | "cost"]> = {
  calories: ["kcal", "macro_kcal"], protein: ["protein", "macro_g"], carbs: ["carbs", "macro_g"], fat: ["fat", "macro_g"],
  "sodium (mg)": ["sodium_mg", "micro"], "fibre (g)": ["fibre_g", "micro"], "iron (mg)": ["iron_mg", "micro"], "b12 (ug)": ["b12_ug", "micro"],
  "calcium (mg)": ["calcium_mg", "micro"], "magnesium (mg)": ["magnesium_mg", "micro"], "potassium (mg)": ["potassium_mg", "micro"],
  "cost min (inr)": ["cost_min_inr", "cost"], "cost max (inr)": ["cost_max_inr", "cost"],
};

/** "26 Jul" (Chart Data's date format, no year): the capture year. */
function chartDate(text: string, year: string): string | null {
  try {
    return parseDate(`${text.trim()} ${year}`).value;
  } catch {
    return null;
  }
}

/** Chart Data's daily rollups (macros, micros, cost) against day_totals. */
async function chartRollups(ld: Loader, c: Collector): Promise<void> {
  const year = ld.at.slice(0, 4);
  const held = heldRows(ld);
  for (const file of Object.keys(PERSON_FILES)) {
    const member = ld.memberOfFile(file);
    const sheet = ld.sheet(file, "Chart Data");
    if (!member || !sheet || !ld.facts.has(`member:${member}`)) continue;
    const header = sheet.row(1);
    const cols: [string, string, string][] = [];
    for (let i = 0; i < sheet.data.cols; i++) {
      const col = colLetterOf(i);
      const spec = CHART_COLUMNS[header.rendered(col).trim().toLowerCase()];
      if (spec && !cols.some(([, k]) => k === spec[0])) cols.push([col, spec[0], spec[1]]);
    }
    for (const row of sheet.renderedRows()) {
      const date = chartDate(row.rendered("A"), year);
      if (!date) continue;
      const res = await importRead(ld.db, "day_totals", { member, date }, ld.at);
      const totals: Totals = { ...((res.so_far as Totals) ?? {}), ...((res.micros as Totals) ?? {}) };
      const cost = res.cost_inr as { min: Totals[string]; max: Totals[string] } | null;
      if (cost) Object.assign(totals, { cost_min_inr: cost.min ?? undefined, cost_max_inr: cost.max ?? undefined });
      const origin = ld.origin(row);
      for (const [col, key, kind] of cols) {
        const sheetValue = sheetNumber(row, col);
        const app = known(totals, key);
        const metric = kind.startsWith("macro") && key !== "kcal" ? `${key}_g` : key;
        c.compare({
          group: "Day totals (Chart Data rollups)", origin, metric, sheet: sheetValue, app, day: date, related: held.get(`${file}\u0000${date}`) ?? [],
          tolerance: kind === "macro_kcal" ? TOLERANCES.day_kcal : kind === "macro_g" ? TOLERANCES.day_macro_g : Math.max(kind === "cost" ? 0.01 : 0.1, Math.abs(sheetValue ?? app ?? 0) * TOLERANCES.micro_rel),
          explain: (s, a) => {
            if (s === 0 && a === null) {
              return { cause: "sheet-bug", kind: "mechanical", problem: "Chart Data's SUMIF reads 0 for a day whose rows carry no value; the app says unknown (blank is never zero).", fix: "None: the app reports it as unknown, with coverage." };
            }
            if (s === null && row.formula(col) === null && !arrayCovers(sheet, col)) {
              return { cause: "sheet-bug", kind: "mechanical", problem: `Chart Data ${col} has no formula on this row (Hritvik's sodium column lost its formula).`, fix: "None: the app computes the day's total." };
            }
            if (kind.startsWith("macro")) {
              const remainder = unitemised(ld, member, date, key, s, a, kind === "macro_kcal" ? TOLERANCES.day_kcal : TOLERANCES.day_macro_g);
              if (remainder) return remainder;
            }
            const rows = c.comparisons.filter((x) => x.origin.file === file && x.day === date && x.metric === metric && x.group.startsWith("Nutrition rows") && x.status === "explained");
            if (rows.length === 0) return null;
            const cause = rows[0]?.cause as Cause;
            const mechanical = rows.every((x) => c.ld.book.get(x.ruling ?? "")?.kind === "mechanical");
            return { cause, kind: mechanical ? "mechanical" : "semantic", problem: `The day's rows carry explained differences (${rows.map((x) => originKey(x.origin)).join(", ")}).`, fix: "Follows from the row rulings." };
          },
        });
      }
    }
  }
}

/**
 * A day whose DAY TOTAL exceeded its items carries an unitemised manual item
 * for the difference (Hritvik's keep_items_plus_remainder): Sheets' daily
 * total sums the items only, so the app is above it by that item. Decided
 * by the ruling, so mechanical.
 */
function unitemised(ld: Loader, member: string, day: string, key: string, sheet: number | null, app: number | null, tolerance: number) {
  const r = ld.facts.get(`remainder:${member}\u0000${day}`) as Record<string, number | string> | undefined;
  const part = r?.[key];
  if (typeof part !== "number" || sheet === null || app === null || Math.abs(app - sheet - part) > tolerance + 1e-9) return null;
  return {
    cause: "manual-macros" as const, kind: "mechanical" as const,
    problem: `The app counts the unitemised remainder ruled in ${String(r?.ruling)} (${Math.round(part * 100) / 100}); Sheets' daily total sums the items only.`,
    fix: "None: the day's record is its items plus the ruled remainder.",
  };
}

function arrayCovers(sheet: import("./grid").Sheet, col: string): boolean {
  const f = sheet.data.formulas[1]?.[colIndex(col)];
  return typeof f === "string" && f.startsWith("=ARRAYFORMULA");
}

/** Semantic rulings on Nutrition rows, by file and day: a day total can differ until they are decided. */
function heldRows(ld: Loader): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of ld.book.all()) {
    if (r.origin.tab !== "Nutrition" || r.kind !== "semantic" || r.code === "parity") continue;
    const row = ld.sheet(r.origin.file, "Nutrition")?.row(r.origin.row);
    if (!row) continue;
    let day: string | null = r.day;
    try {
      day ??= parseDate(row.raw("A")).value;
    } catch {
      continue;
    }
    if (!day) continue;
    const key = `${r.origin.file}\u0000${day}`;
    out.set(key, [...(out.get(key) ?? []), r.id]);
  }
  return out;
}

// ------------------------------------------------------------ derived recipes

function derivedRecipes(ld: Loader, c: Collector): void {
  for (const row of ld.sheet("base", "Recipes")?.rows() ?? []) {
    const origin = ld.origin(row);
    if (row.text("Z").toLowerCase() !== "derived") {
      c.skip("Derived recipes"); // stored macros are inputs, carried over
      continue;
    }
    const rec = ld.recordsOf(origin).find((r) => r.table === "recipe");
    if (!rec) {
      c.skip("Derived recipes");
      continue;
    }
    const app = ld.db.get<Record<string, number | null>>("SELECT kcal_per_serving AS kcal, protein_g_per_serving AS protein, carbs_g_per_serving AS carbs, fat_g_per_serving AS fat FROM v_recipe WHERE id = ?", rec.id);
    for (const [col, key, unit] of MACROS) {
      c.compare({ group: "Derived recipes", origin, metric: key === "kcal" ? "kcal" : `${key}_g`, sheet: sheetNumber(row, col), app: app?.[key] ?? null, tolerance: unit === "kcal" ? TOLERANCES.row_kcal : TOLERANCES.row_macro_g });
    }
  }
}

// ------------------------------------------------------- Food Source columns

function foodSourceColumns(ld: Loader, c: Collector): void {
  for (const row of ld.sheet("base", "Food Sources")?.rows() ?? []) {
    const origin = ld.origin(row);
    const rec = ld.recordsOf(origin).find((r) => r.table === "food_source");
    if (!rec) continue;
    const s = ld.db.get<{ kcal: number; protein_g: number; fat_g: number; price_min_inr: number | null; price_max_inr: number | null }>("SELECT kcal, protein_g, fat_g, price_min_inr, price_max_inr FROM v_food_source WHERE id = ?", rec.id);
    if (!s) continue;
    const p = s.protein_g > 0 ? s.protein_g : null;
    const cols: [string, string, number | null][] = [
      ["C", "kcal_per_g_protein", p ? s.kcal / p : null],
      ["D", "cost_min_per_g_protein", p && s.price_min_inr !== null ? s.price_min_inr / p : null],
      ["E", "cost_max_per_g_protein", p && s.price_max_inr !== null ? s.price_max_inr / p : null],
      ["L", "protein_per_100_kcal", s.kcal > 0 ? (s.protein_g / s.kcal) * 100 : null],
      ["M", "cost_min_per_25g_protein", p && s.price_min_inr !== null ? (s.price_min_inr / p) * 25 : null],
      ["N", "cost_max_per_25g_protein", p && s.price_max_inr !== null ? (s.price_max_inr / p) * 25 : null],
      ["O", "kcal_per_25g_protein", p ? (s.kcal / p) * 25 : null],
      ["P", "servings_for_25g_protein", p ? 25 / p : null],
      ["Q", "fat_with_25g_protein", p ? (s.fat_g / p) * 25 : null],
    ];
    for (const [col, metric, app] of cols) {
      const sheet = sheetNumber(row, col);
      c.compare({
        group: "Food Source derived columns", origin, metric, sheet, app, tolerance: Math.max(0.01, Math.abs(sheet ?? app ?? 0) * TOLERANCES.micro_rel),
        explain: () =>
          sheet === null && !arrayFormulaCovers(ld, col, row.n) && row.formula(col) === null
            ? { cause: "sheet-bug", kind: "mechanical", problem: "The cell has no formula (Food Sources D/E were never filled down to the newest rows).", fix: "None: the app computes it." }
            : null,
      });
    }
  }
}

/** An ARRAYFORMULA in row 2 of the column covers every row below it. */
function arrayFormulaCovers(ld: Loader, col: string, n: number): boolean {
  const f = ld.snap.files.base?.tabs["Food Sources"]?.formulas[1]?.[colIndex(col)];
  return n > 2 && typeof f === "string" && f.startsWith("=ARRAYFORMULA");
}

// ---------------------------------------------------------------------- body

function body(ld: Loader, c: Collector): void {
  for (const file of Object.keys(PERSON_FILES)) {
    const member = ld.memberOfFile(file);
    const sheet = ld.sheet(file, "Body");
    const memberId = member ? (ld.facts.get(`member:${member}`) as number | undefined) : undefined;
    if (!sheet || memberId === undefined) continue;
    for (const row of sheet.rows()) {
      let date: string | null = null;
      try {
        date = parseDate(row.raw("A")).value;
      } catch {
        date = null;
      }
      if (!date) continue;
      const origin = ld.origin(row);
      if (row.formula("D") !== null) {
        const app = ld.db.get<{ avg_kg: number }>("SELECT avg_kg FROM v_weight_7d WHERE member_id = ? AND day = ?", memberId, date)?.avg_kg ?? null;
        c.compare({ group: "Body 7-day average", origin, metric: "weight_7d_avg_kg", sheet: sheetNumber(row, "D"), app, tolerance: TOLERANCES.body_avg_kg });
      } else if (!row.blank("D")) c.skip("Body 7-day average");
      const reading = (metric: string) =>
        ld.db.get<{ v: number }>("SELECT value_canonical AS v FROM v_reading WHERE member_id = ? AND metric = ? AND measured_on = ? ORDER BY id LIMIT 1", memberId, metric, date)?.v ?? null;
      const height = ld.db.get<{ v: number }>("SELECT value_canonical AS v FROM v_reading WHERE member_id = ? AND metric = 'height' AND measured_on <= ? ORDER BY measured_on DESC, id DESC LIMIT 1", memberId, date)?.v ?? null;
      const waist = reading("waist_navel");
      const ratios: [string, string, number | null][] = [
        ["O", "shoulder_to_waist", waist && reading("shoulders") ? (reading("shoulders") as number) / waist : null],
        ["P", "waist_to_hip", waist && reading("hips") ? waist / (reading("hips") as number) : null],
        ["Q", "waist_to_height", waist && height ? waist / height : null],
      ];
      for (const [col, metric, app] of ratios) {
        if (row.formula(col) === null) {
          if (!row.blank(col)) c.skip("Body ratios");
          continue;
        }
        const hard = /\/\s*(\d{3})\s*,/.exec(row.formula(col) ?? "");
        c.compare({
          group: "Body ratios", origin, metric, sheet: sheetNumber(row, col), app, tolerance: TOLERANCES.ratio,
          explain: (s) =>
            hard && waist && s !== null && Math.abs(Math.round((waist / Number(hard[1])) * 100) / 100 - s) <= TOLERANCES.ratio
              ? { cause: "sheet-bug", kind: "mechanical", problem: `Sheets hard-codes height ${hard[1]} cm; the app uses the stored height${height ? ` (${height} cm)` : ""}.`, fix: "None: the app's ratio uses the stored height." }
              : null,
        });
      }
    }
  }
}

// ----------------------------------------------------------------------- Log

function log(ld: Loader, c: Collector): void {
  for (const file of Object.keys(PERSON_FILES)) {
    for (const row of ld.sheet(file, "Log")?.rows() ?? []) {
      const origin = ld.origin(row);
      const rec = ld.recordsOf(origin).find((r) => r.table === "session_set");
      const typedVolume = sheetNumber(row, "M");
      const typedE1rm = sheetNumber(row, "N");
      if (!rec) {
        if (typedVolume !== null || typedE1rm !== null) c.skip("Log (typed volume, e1RM)");
        continue;
      }
      const app = ld.db.get<{ volume_kg: number | null; e1rm_kg: number | null; reps: number | null; total_load_kg: number | null; implements_sharing: number }>("SELECT volume_kg, e1rm_kg, reps, total_load_kg, implements_sharing FROM v_set WHERE id = ?", rec.id);
      const rounded = app?.total_load_kg !== null && app?.total_load_kg !== undefined ? Math.round(app.total_load_kg * 10) / 10 : null;
      // e1RM is on the per-implement load (0017), which Sheets rounded on its own.
      const roundedPerImplement = app?.total_load_kg !== null && app?.total_load_kg !== undefined ? Math.round((app.total_load_kg / app.implements_sharing) * 10) / 10 : null;
      if (typedVolume !== null) {
        c.compare({
          group: "Log (typed volume, e1RM)", origin, metric: "volume_kg", sheet: typedVolume, app: app?.volume_kg ?? null,
          tolerance: Math.max(TOLERANCES.log_volume_kg, typedVolume * 0.005),
          explain: (s) => typedDifference(s, rounded !== null && app?.reps ? rounded * app.reps : null, TOLERANCES.log_volume_kg),
        });
      }
      if (typedE1rm !== null) {
        if (app?.e1rm_kg === null || app?.e1rm_kg === undefined) c.skip("Log (typed volume, e1RM)"); // the app's e1RM is only for RIR 0, 1-12 reps
        else {
          c.compare({
            group: "Log (typed volume, e1RM)", origin, metric: "e1rm_kg", sheet: typedE1rm, app: app.e1rm_kg, tolerance: TOLERANCES.log_e1rm_kg,
            explain: (s) => typedDifference(s, roundedPerImplement !== null && app.reps ? roundedPerImplement * (1 + app.reps / 30) : null, TOLERANCES.log_e1rm_kg),
          });
        }
      }
    }
  }
}

function typedDifference(sheet: number | null, fromRounded: number | null, tol: number) {
  if (sheet !== null && fromRounded !== null && Math.abs(sheet - fromRounded) <= tol) {
    return { cause: "rounding" as const, kind: "mechanical" as const, problem: "The typed value was computed from the load rounded for display.", fix: "None: the app computes from the true load." };
  }
  return { cause: "typed-error" as const, kind: "semantic" as const, problem: "The typed value differs from the app's recompute beyond rounding.", fix: "Confirm the app's value (computed from the stored load and reps); the typed value stays in the write log's audit detail." };
}

// ------------------------------------------------------------------- summary

function summarise(ld: Loader, c: Collector, snapshotName: string, loaded: Record<string, number>): ParityReport {
  const groups = new Map<string, GroupSummary>();
  const g = (name: string) => {
    let x = groups.get(name);
    if (!x) groups.set(name, (x = { group: name, compared: 0, within: 0, explained: 0, unexplained: 0, not_compared: 0 }));
    return x;
  };
  for (const cmp of c.comparisons) {
    const x = g(cmp.group);
    x.compared++;
    x[cmp.status]++;
  }
  for (const [name, n] of c.notCompared) g(name).not_compared += n;
  const byCause: Record<string, number> = {};
  for (const cmp of c.comparisons) if (cmp.status === "explained" && cmp.cause) byCause[cmp.cause] = (byCause[cmp.cause] ?? 0) + 1;
  const pending = ld.book.all().filter((r) => r.decision === "pending").length;
  const unexplained = c.comparisons.filter((x) => x.status === "unexplained").length;
  const rulingCounts: Record<string, number> = {};
  for (const r of ld.book.all()) {
    const key = `${r.kind} ${r.decision}${r.cause ? ` (${r.cause})` : ""}`;
    rulingCounts[key] = (rulingCounts[key] ?? 0) + 1;
  }
  const order: Record<Status, number> = { unexplained: 0, explained: 1, within: 2 };
  return {
    version: 1,
    snapshot: snapshotName,
    gate: unexplained === 0 && pending === 0 ? "PASS" : "FAIL",
    tolerances: {
      "Nutrition rows": "±1 kcal, ±0.5 g per macro",
      "Day totals": "±5 kcal, ±2 g per macro",
      "Micros and cost": "±1% or one display unit (0.1, cost 0.01)",
      "Derived recipes": "±1 kcal, ±0.5 g per macro",
      "Food Source derived columns": "±1% or one display unit (0.01)",
      "Body 7-day average": "±0.05 kg",
      "Body ratios": "±0.01 (one display unit)",
      "Log (typed)": "volume ±1 kg or 0.5%, e1RM ±0.5 kg; any difference is a ruling",
    },
    summary: {
      compared: c.comparisons.length,
      within: c.comparisons.filter((x) => x.status === "within").length,
      explained: c.comparisons.filter((x) => x.status === "explained").length,
      unexplained,
      pending_rulings: pending,
      explained_by_cause: Object.fromEntries(Object.entries(byCause).sort()),
    },
    groups: [...groups.values()],
    loaded,
    rulings: Object.fromEntries(Object.entries(rulingCounts).sort()),
    differences: c.comparisons.filter((x) => x.status !== "within").sort((a, b) => order[a.status] - order[b.status] || (a.cause ?? "").localeCompare(b.cause ?? "") || a.id.localeCompare(b.id)),
  };
}

export function parityMarkdown(r: ParityReport): string {
  const lines: string[] = [];
  lines.push(`# Parity report`, "", `Snapshot: \`${r.snapshot}\``, "", `**Gate: ${r.gate}** — ${r.summary.unexplained} unexplained differences, ${r.summary.pending_rulings} pending rulings.`, "");
  lines.push(`Compared ${r.summary.compared} values: ${r.summary.within} within tolerance, ${r.summary.explained} explained by a ruling, ${r.summary.unexplained} unexplained.`, "");
  if (Object.keys(r.summary.explained_by_cause).length) lines.push(`Explained by cause: ${Object.entries(r.summary.explained_by_cause).map(([k, v]) => `${k} ${v}`).join(", ")}.`, "");
  lines.push("| Group | Compared | Within | Explained | Unexplained | Not compared |", "|---|---:|---:|---:|---:|---:|");
  for (const g of r.groups) lines.push(`| ${g.group} | ${g.compared} | ${g.within} | ${g.explained} | ${g.unexplained} | ${g.not_compared} |`);
  lines.push("", "Not compared: typed inputs (ref-less meals, stored recipes, typed Body averages and ratios), rows a ruling holds back, and typed e1RM where the app computes none (RIR above 0 or more than 12 reps).", "");
  lines.push("## Records loaded", "", "| Table | Rows |", "|---|---:|");
  for (const [t, n] of Object.entries(r.loaded)) lines.push(`| ${t} | ${n} |`);
  lines.push("", "## Rulings", "", "| Kind, decision (cause) | Count |", "|---|---:|");
  for (const [k, n] of Object.entries(r.rulings)) lines.push(`| ${k} | ${n} |`);
  lines.push("");
  lines.push("## Tolerances", "");
  for (const [k, v] of Object.entries(r.tolerances)) lines.push(`- ${k}: ${v}`);
  const unexplained = r.differences.filter((d) => d.status === "unexplained");
  lines.push("", `## Unexplained differences (${unexplained.length})`, "");
  if (unexplained.length) {
    lines.push("| Where | Metric | Sheets | App | Δ | Related rulings |", "|---|---|---:|---:|---:|---|");
    for (const d of unexplained) lines.push(`| ${originKey(d.origin)} | ${d.metric} | ${fmt(d.sheet)} | ${fmt(d.app)} | ${fmt(d.delta)} | ${(d.related ?? []).join(", ")} |`);
  }
  const explained = r.differences.filter((d) => d.status === "explained");
  lines.push("", `## Explained differences (${explained.length})`, "");
  if (explained.length) {
    lines.push("| Where | Metric | Sheets | App | Cause | Decision | Day |", "|---|---|---:|---:|---|---|---|");
    for (const d of explained) lines.push(`| ${originKey(d.origin)} | ${d.metric} | ${fmt(d.sheet)} | ${fmt(d.app)} | ${d.cause} | ${d.decision} | ${d.day ?? ""} |`);
  }
  return `${lines.join("\n")}\n`;
}

const fmt = (x: number | null) => (x === null ? "blank" : String(round(x)));
