/**
 * base People -> the household, its members (emails and modes from
 * members.json), home gyms, each member's height reading, and a dated
 * target per member with its reasoning and the RDA block.
 */
import { parseDate, ParseError } from "../parse";
import { Loader, RowReader } from "./context";

const RDA: [string, string][] = [
  ["Q", "sodium_mg"], ["R", "fibre_g"], ["S", "iron_mg"], ["T", "b12_ug"], ["U", "calcium_mg"], ["V", "magnesium_mg"], ["W", "potassium_mg"],
];
const MACROS: [string, string][] = [["J", "kcal"], ["K", "protein_g"], ["L", "carbs_g"], ["M", "fat_g"]];

export async function loadPeople(ld: Loader): Promise<void> {
  await ld.write("create_household", { name: ld.members.household }, { file: "base", tab: "People", row: 1 });
  const people = ld.sheet("base", "People");
  const rows = people?.rows() ?? [];
  const known: string[] = [];
  for (const row of rows) {
    const name = row.text("A");
    const origin = ld.origin(row);
    const cfg = ld.members.members.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (!cfg) {
      ld.book.raise({
        origin, code: "unknown_member", kind: "semantic",
        problem: `People lists "${name}", who has no entry in members.json (email, programming mode, person file).`,
        proposed_fix: "Add the member to ~/.config/myfitnessguide/members.json, or leave the row out.",
        proposal: null, row: row.cells(["A", "B", "C"]),
      });
      continue;
    }
    const sex = row.text("C").toUpperCase();
    const res = await ld.write("create_member", {
      name: cfg.name, email: cfg.email, programming_mode: cfg.programming_mode,
      ...(sex === "M" ? { sex: "male" } : sex === "F" ? { sex: "female" } : {}),
      ...(cfg.week_anchor_date ? { week_anchor_date: cfg.week_anchor_date } : {}),
    }, origin, { evidence: row });
    if (res) {
      const id = (res.member as { id: number }).id;
      ld.record(origin, { table: "member", id, tool: "create_member" });
      ld.facts.set(`member:${cfg.name}`, id);
      known.push(cfg.name);
    }
  }
  // Home gyms, in members.json order.
  for (const [i, m] of ld.members.members.entries()) {
    if (!known.includes(m.name)) continue;
    await ld.write("create_gym", { name: m.gym, home_of: [m.name] }, { file: "members.json", tab: "gyms", row: i + 1 });
  }
  for (const row of rows) {
    const cfg = ld.members.members.find((m) => m.name.toLowerCase() === row.text("A").toLowerCase());
    if (!cfg || !known.includes(cfg.name)) continue;
    await loadPersonFacts(ld, row, cfg.name, cfg.file);
  }
}

/** The date a member's first Body row was taken, else the capture date: People holds no date for height. */
function heightDate(ld: Loader, file: string): string {
  const body = ld.sheet(file, "Body");
  const dates: string[] = [];
  for (const r of body?.rows() ?? []) {
    try {
      const d = parseDate(r.raw("A")).value;
      if (d) dates.push(d);
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
    }
  }
  return dates.sort()[0] ?? ld.at.slice(0, 10);
}

async function loadPersonFacts(ld: Loader, row: import("../grid").Row, member: string, file: string): Promise<void> {
  const origin = ld.origin(row);
  const rd = new RowReader(ld, row);
  let height: number | null = null;
  const macros: { nutrient: string; kind: string; value: number }[] = [];
  try {
    height = rd.num("F");
    for (const [col, nutrient] of MACROS) {
      const v = rd.num(col);
      if (v !== null) macros.push({ nutrient, kind: "target", value: v });
    }
    for (const [col, nutrient] of RDA) {
      const v = rd.num(col);
      if (v !== null) macros.push({ nutrient, kind: "reference_intake", value: v });
    }
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    ld.book.raise({
      origin, code: "unreadable_value", kind: "semantic", problem: error.message,
      proposed_fix: "Correct the cell in the snapshot's source, or leave the row's targets out.", proposal: null, row: row.cells(["F", "J", "K", "L", "M"]),
    });
    return;
  }
  rd.flush();
  if (height !== null) {
    const res = await ld.write("log_reading", {
      member, date: heightDate(ld, file), metric: "height", value: height, unit: "cm", body_state: "not_recorded", measurer: "not_recorded",
      note: "From base People; Sheets holds no date for height, so it is dated to the member's first Body row.",
    }, origin, { key: "height", evidence: row });
    if (res) ld.record(origin, { table: "reading", id: (res.reading as { id: number }).id, tool: "log_reading" });
  }
  if (macros.length === 0) return;

  // The targets' set-on date lives only in the person file's mirrored targets block (Catalogue J7).
  let effective: string | null = null;
  const catalogue = ld.sheet(file, "Catalogue");
  if (catalogue && catalogue.data.rows >= 7) {
    try {
      effective = parseDate(catalogue.row(7).raw("J")).value;
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
    }
  }
  if (!effective) {
    const r = ld.book.raise<string>({
      origin, code: "target_date", kind: "semantic",
      problem: `${member}'s targets have no set-on date (${file} Catalogue!J7 is blank or missing).`,
      proposed_fix: `Date them to the snapshot's capture day, ${ld.at.slice(0, 10)}, or give the real date as override.`,
      proposal: ld.at.slice(0, 10), row: row.cells(["J", "K", "L", "M"]),
    });
    if (!r.apply) return;
    effective = r.value;
  }
  const reasoning = row.text("N") || "Imported from base People; no reasoning was recorded.";
  const res = await ld.write("set_target", { member, effective_from: effective, provenance: "import", reasoning, values: macros }, origin, { key: "target", evidence: row });
  if (res) ld.record(origin, { table: "target", id: (res.target as { id: number }).id, tool: "set_target" });
}
