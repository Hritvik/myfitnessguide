// Small synthetic snapshots. Never real household data: invented people,
// foods and numbers in the real column layout.
import { placeholderMembers, type MembersConfig } from "../src/members";
import { SNAPSHOT_FORMAT, type Cell, type Snapshot, type SnapshotTab } from "../src/snapshot";

/** A cell: a raw value (rendered as its string), or a formula with what it rendered. */
export type FixtureCell = Cell | { f: string; v: string };
export type FixtureTabs = Record<string, Record<string, FixtureCell[][]>>;

export const CAPTURED_AT = "2026-10-05T19:07:21Z";

export function snapshot(files: FixtureTabs, capturedAt = CAPTURED_AT): Snapshot {
  const out: Snapshot = { format: SNAPSHOT_FORMAT, version: 1, captured_at: capturedAt, source: { tool: "fixture", auth_profile: "fixture" }, files: {} };
  for (const [file, tabs] of Object.entries(files)) {
    const built: Record<string, SnapshotTab> = {};
    for (const [name, grid] of Object.entries(tabs)) {
      const cols = Math.max(0, ...grid.map((r) => r.length));
      const formulas = grid.map((r) => Array.from({ length: cols }, (_, c) => {
        const x = r[c];
        return x === undefined ? "" : typeof x === "object" && x !== null ? x.f : x;
      }));
      const values = grid.map((r) => Array.from({ length: cols }, (_, c) => {
        const x = r[c];
        return x === undefined || x === null ? "" : typeof x === "object" ? x.v : String(x);
      }));
      built[name] = { range: `'${name}'!A1`, rows: grid.length, cols, values, formulas };
    }
    out.files[file] = { spreadsheet_id: `${file.toUpperCase()}_ID`, name: `Gym · ${file}`, modified_time: null, revision: null, tabs: built };
  }
  return out;
}

export const members = (): MembersConfig => ({
  household: "Test household",
  members: placeholderMembers().members.map((m) => ({ ...m, email: `${m.file}@example.com` })),
});

export const f = (formula: string, rendered: string | number) => ({ f: formula, v: String(rendered) });

// ------------------------------------------------------------- tab layouts

export const PEOPLE_HEADER = ["Person", "Active", "Sex", "Age", "Weight (kg)", "Height (cm)", "Goal", "Activity / training", "Diet", "Calories", "Protein (g)", "Carbs (g)", "Fat (g)", "Target basis", "last_reviewed", "notes", "rda_sodium_mg", "rda_fibre_g", "rda_iron_mg", "rda_b12_ug", "rda_calcium_mg", "rda_magnesium_mg", "rda_potassium_mg", "RDA basis"];

export function person(name: string, over: { sex?: string; height?: Cell; kcal?: Cell; protein?: Cell; carbs?: Cell; fat?: Cell; basis?: string; rda?: Cell[] } = {}): Cell[] {
  return [name, "Yes", over.sex ?? "M", 30, 70, over.height ?? 170, "Cut", "Desk", "Veg", over.kcal ?? 1800, over.protein ?? 120, over.carbs ?? 200, over.fat ?? 55, over.basis ?? "Set by the member.", "", "", ...(over.rda ?? [2000, 30, 19, 2.2, 1000, 440, 3510]), "ICMR"];
}

/** A person file's Catalogue with only the targets block's set_on date (J7). */
export function catalogueWithSetOn(serial: number): FixtureCell[][] {
  const rows: FixtureCell[][] = [["ref", "name", "serving", "calories", "protein_g", "carbs_g", "fat_g", "", "person"]];
  for (let i = 2; i <= 7; i++) rows.push(["", "", "", "", "", "", "", "", "", i === 7 ? serial : ""]);
  return rows;
}

export const FOOD_HEADER = ["Source", "Serving", "Calories per g protein", "Cost Min (₹/g protein)", "Cost Max (₹/g protein)", "Calories (kcal/serving)", "Protein (g/serving)", "Carbs (g/serving)", "Fat (g/serving)", "Price Min (₹/serving)", "Price Max (₹/serving)", "Protein per 100 kcal (g)", "Cost Min (₹/25g protein)", "Cost Max (₹/25g protein)", "Calories per 25g protein", "Servings for 25g protein", "Fat with 25g protein (g)", "Protein quality", "Primary Category", "Tags", "Food ID", "Last checked", "Assumptions / notes", "sodium_mg", "fibre_g", "iron_mg", "b12_ug", "calcium_mg", "magnesium_mg", "potassium_mg", "protein_band", "sat_fat_g", "total_sugars_g", "vitamin_c_mg"];

export interface Food {
  ref: string;
  name: string;
  serving: string;
  kcal: Cell;
  protein: Cell;
  carbs: Cell;
  fat: Cell;
  priceMin?: FixtureCell;
  priceMax?: FixtureCell;
  category?: string;
  band?: string;
  sodium?: Cell;
  iron?: Cell;
  derived?: Partial<Record<"C" | "D" | "E" | "L" | "M" | "N" | "O" | "P" | "Q", FixtureCell>>;
}

export function food(x: Food): FixtureCell[] {
  const d = x.derived ?? {};
  return [
    x.name, x.serving, d.C ?? "", d.D ?? "", d.E ?? "", x.kcal, x.protein, x.carbs, x.fat, x.priceMin ?? "", x.priceMax ?? "", d.L ?? "", d.M ?? "", d.N ?? "", d.O ?? "", d.P ?? "", d.Q ?? "",
    "", x.category ?? "Protein", "", x.ref, 46240, "", x.sodium ?? "", "", x.iron ?? "", "", "", "", "", x.band ?? "", "", "", "",
  ];
}

export const RECIPES_HEADER = ["Dish", "Meal Type", "Prep Type", "Calories per g protein", "Calories", "Protein (g)", "Carbs (g)", "Fats (g)", "Ingredients", "Method", "Source / assumptions", "Ingredient coverage", "Linked items", "Linked calories", "Linked protein (g)", "Linked carbs (g)", "Linked fat (g)", "Linked cost min (₹)", "Linked cost max (₹)", "Calories per 25g protein", "Protein per 100 kcal (g)", "Servings for 25g protein", "Carbs with 25g protein (g)", "Fat with 25g protein (g)", "Recipe ID", "Derivation", "Ingredient lines", "sodium_mg", "fibre_g", "iron_mg", "b12_ug", "calcium_mg", "magnesium_mg", "potassium_mg", "micro_cov", "pct_protein_complete", "kind"];

export function recipe(x: { ref: string; name: string; macros: FixtureCell[]; derivation: "derived" | "stored"; kind?: string; iron?: FixtureCell }): FixtureCell[] {
  const row: FixtureCell[] = Array.from({ length: 37 }, () => "");
  row[0] = x.name;
  row[1] = "Lunch";
  row[2] = "Cook";
  x.macros.forEach((m, i) => (row[4 + i] = m));
  row[24] = x.ref;
  row[25] = x.derivation;
  row[29] = x.iron ?? "";
  row[36] = x.kind ?? "dish";
  return row;
}

export const RI_HEADER = ["Recipe", "Food ID", "Source", "Quantity (source servings)", "Portion note", "Calories", "Protein (g)", "Carbs (g)", "Fat (g)", "Cost Min (₹)", "Cost Max (₹)", "Link status", "Notes", "Recipe ID"];

export function line(recipeName: string, foodRef: string, qty: Cell, recipeRef: string): FixtureCell[] {
  return [recipeName, foodRef, "", qty, "", "", "", "", "", "", "", "Confirmed", "", recipeRef];
}

export const NUTRITION_HEADER = ["Date", "Meal", "Item", "Qty", "Calories", "Protein (g)", "Carbs (g)", "Fat (g)", "Confidence", "Source", "Note", "Person", "ref", "qty", "sodium_mg", "fibre_g", "iron_mg", "b12_ug", "calcium_mg", "magnesium_mg", "potassium_mg", "cov_weight", "protein_complete_g", "prot_complete_g", "prot_partial_g", "prot_incomplete_g", "cost_min_inr", "cost_max_inr", "cost_cov_kcal"];

export function intake(x: { date: Cell; meal: Cell; item: string; qtyText?: string; macros?: FixtureCell[]; confidence?: string; source?: string; person: string; ref?: string; qty?: Cell; micros?: FixtureCell[]; cost?: FixtureCell[] }): FixtureCell[] {
  const m = x.macros ?? ["", "", "", ""];
  const micros = x.micros ?? ["", "", "", "", "", "", ""];
  return [x.date, x.meal, x.item, x.qtyText ?? "", ...m, x.confidence ?? "Medium", x.source ?? "Estimate", "", x.person, x.ref ?? "", x.qty ?? "", ...micros, "", "", "", "", "", ...(x.cost ?? ["", "", ""])];
}

export const DAILY_HEADER = ["Date", "Person", "Calories", "Protein (g)", "Carbs (g)", "Fat (g)", "Entries"];

export const LOG_HEADER = ["Date", "Week", "Phase", "Session", "Exercise", "Muscle Group", "Set", "Reps", "RIR", "Weight (kg)", "Load Basis", "Total Load (kg)", "Volume (kg)", "e1RM (kg)", "Source", "Note", "Set Type", "Distance (m)", "Duration (s)"];

export function set(x: { date: Cell; session: string; exercise: string; set: Cell; reps: Cell; rir?: Cell; weight?: Cell; basis?: string; total?: Cell; volume?: Cell; e1rm?: Cell; type?: string; distance?: Cell; duration?: Cell }): Cell[] {
  return [x.date, 1, "P1", x.session, x.exercise, "Chest", x.set, x.reps, x.rir ?? "", x.weight ?? "", x.basis ?? "total", x.total ?? "", x.volume ?? "", x.e1rm ?? "", "RC", "", x.type ?? "", x.distance ?? "", x.duration ?? ""];
}

export const CARDIO_HEADER = ["Date", "Week", "Phase", "Type", "Block", "Duration (min)", "Speed (km/h)", "Incline %", "Distance (km)", "Pace (min/km)", "Avg HR", "Max HR", "RPE", "Conversational?", "Note", "Rounds", "Recovery HR"];

export const BODY_HEADER = ["Date", "Week", "Weight AM Fasted (kg)", "7-day Avg (fasted only)", "Weight Other (kg)", "Conditions", "Waist-Navel (cm)", "Abdomen-Widest (cm)", "Shoulders circ (cm)", "Chest (cm)", "Arm R (cm)", "Thigh R (cm)", "Hips (cm)", "Neck (cm)", "Sh:Waist", "Waist:Hip", "Waist:Height", "Protein (g)", "Photos?", "Sleep (h)", "Note", "BP Systolic", "BP Diastolic", "Resting HR"];

export const PROGRAM_HEADER = ["Session", "#", "Exercise", "Pattern", "Sets", "Reps", "RIR", "Rest", "Load value", "Load unit", "Load basis", "Last Moved", "Progression Rule", "Cue / Note", "Current Wt (kg)", "Fallback"];

export const AUDIT_HEADER = ["Date", "Time", "Agent", "Action", "Affected tab / range", "Reason", "Prior value / reference", "Result"];

/** The minimum base file: People with the three members. */
export function basePeople(): FixtureCell[][] {
  return [PEOPLE_HEADER, person("Hritvik"), person("Asha", { sex: "F", height: 150 }), person("Kabir")];
}
