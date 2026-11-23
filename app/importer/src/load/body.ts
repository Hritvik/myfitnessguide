/**
 * Body -> one reading per measured cell (log_reading); Bloods -> one blood
 * draw per date column (log_blood_draw); Trajectory and the Chart Data goal
 * lifts -> goal points (create_goal_point).
 *
 * Body columns are found by their header, since the person files differ
 * after column X. Derived columns (7-day average, ratios, skinfold sum,
 * fat-free mass when it is a formula) are not imported: the app computes
 * them, and the parity report compares them.
 */
import { colLetter, type Row, type Sheet } from "../grid";
import { PERSON_FILES } from "../layout";
import { parseDate, parseNumber, ParseError } from "../parse";
import { Loader, RowReader } from "./context";

export interface BodyColumn {
  metric: string | null;
  unit: string;
  side?: "right";
  fasted?: boolean;
  bia?: boolean;
}

const BODY_COLUMNS: [RegExp, BodyColumn][] = [
  [/^weight am fasted/i, { metric: "weight", unit: "kg", fasted: true }],
  [/^weight other/i, { metric: "weight", unit: "kg" }],
  [/^waist-navel/i, { metric: "waist_navel", unit: "cm" }],
  [/^abdomen-widest/i, { metric: "abdomen_widest", unit: "cm" }],
  [/^shoulders circ/i, { metric: "shoulders", unit: "cm" }],
  [/^chest/i, { metric: "chest", unit: "cm" }],
  [/^arm r/i, { metric: "arm", unit: "cm", side: "right" }],
  [/^thigh r/i, { metric: "thigh", unit: "cm", side: "right" }],
  [/^hips/i, { metric: "hips", unit: "cm" }],
  [/^neck/i, { metric: "neck", unit: "cm" }],
  [/^sleep/i, { metric: "sleep", unit: "h" }],
  [/^bp systolic/i, { metric: "bp_systolic", unit: "mmHg" }],
  [/^bp diastolic/i, { metric: "bp_diastolic", unit: "mmHg" }],
  [/^resting hr/i, { metric: "resting_hr", unit: "bpm" }],
  [/^skinfold chest/i, { metric: "skinfold_chest", unit: "mm" }],
  [/^skinfold abdo/i, { metric: "skinfold_abdomen", unit: "mm" }],
  [/^skinfold thigh/i, { metric: "skinfold_thigh", unit: "mm" }],
  [/^bia skeletal/i, { metric: "bia_skeletal_muscle_mass", unit: "kg", bia: true }],
  [/^bia fat mass/i, { metric: "bia_body_fat_mass", unit: "kg", bia: true }],
  [/^bia body fat/i, { metric: "bia_body_fat_pct", unit: "pct", bia: true }],
  [/^bia fat-free/i, { metric: "bia_fat_free_mass", unit: "kg", bia: true }],
  [/^bia visceral/i, { metric: "bia_visceral_fat", unit: "score", bia: true }],
  [/^bia (body water|bmr)/i, { metric: null, unit: "", bia: true }],
];

/** The reading a Body column holds, by its header; null when it holds none. */
export function bodyColumnSpec(title: string): BodyColumn | null {
  return BODY_COLUMNS.find(([re]) => re.test(title))?.[1] ?? null;
}

/** Columns read for something else, or deliberately not imported (see DECISIONS.md). */
const NOT_READINGS = /^(date|week|7-day avg|conditions|sh:waist|waist:hip|waist:height|protein|photos|note|skinfold sum|bia device)/i;

export async function loadBody(ld: Loader): Promise<void> {
  for (const file of Object.keys(PERSON_FILES)) {
    const member = ld.memberOfFile(file);
    const sheet = ld.sheet(file, "Body");
    if (!member || !sheet) continue;
    const header = sheet.row(1);
    const columns: { col: string; spec: BodyColumn; title: string }[] = [];
    let deviceCol: string | null = null;
    for (let i = 0; i < sheet.data.cols; i++) {
      const col = colLetter(i);
      const title = header.text(col);
      if (!title) continue;
      if (/^bia device/i.test(title)) deviceCol = col;
      const spec = BODY_COLUMNS.find(([re]) => re.test(title))?.[1];
      if (spec) columns.push({ col, spec, title });
      else if (!NOT_READINGS.test(title) && title.length > 40) {
        await ld.write("write_member_note", { member, topic: `Body: header ${col}`, body: header.rendered(col) }, ld.origin(header), { key: `note_${col}` });
      }
    }
    for (const row of sheet.rows()) await loadBodyRow(ld, member, row, columns, deviceCol);
  }
}

async function loadBodyRow(ld: Loader, member: string, row: Row, columns: { col: string; spec: BodyColumn; title: string }[], deviceCol: string | null): Promise<void> {
  const origin = ld.origin(row);
  const rd = new RowReader(ld, row);
  let date: string | null = null;
  try {
    date = rd.date("A");
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
  }
  if (!date) {
    ld.book.raise({ origin, code: "unreadable_date", kind: "semantic", problem: `Date "${row.text("A")}" is not a date.`, proposed_fix: "Give the date, or leave the row out.", proposal: null, row: row.cells(["A", "C", "E", "G"]) });
    return;
  }
  const conditions = row.text("F");
  const device = deviceCol ? row.text(deviceCol) : "";
  let note = row.text("U");
  let wrote = false;
  for (const { col, spec, title } of columns) {
    if (row.blank(col) || row.formula(col) !== null) continue;
    let value: number | null;
    try {
      value = rd.num(col);
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      ld.book.raise({ origin, code: "unreadable_value", key: col, kind: "semantic", problem: `${title}: ${error.message}`, proposed_fix: "Correct the value, or leave it out.", proposal: null, row: row.cells(["A", col]) });
      continue;
    }
    if (value === null) continue;
    let metric = spec.metric;
    let unit = spec.unit;
    if (metric === null) {
      const r = ld.book.raise<{ add_metric?: string } | null>({
        origin, code: "unknown_metric", key: col, kind: "semantic",
        problem: `"${title}" (${value}) has no metric in the app.`,
        proposed_fix: "Add the metric by migration and re-run (override { add_metric: <code> }), or leave the value out (it stays in the snapshot).", proposal: null, row: row.cells(["A", col]),
      });
      // A metric added by migration (0020): the header names the unit, "BIA BMR (kcal)".
      const added = r.apply && typeof r.value === "object" && r.value !== null ? r.value.add_metric : undefined;
      const headerUnit = /\(([^)]+)\)\s*$/.exec(title)?.[1]?.trim();
      if (!added || !headerUnit) continue;
      metric = added;
      unit = headerUnit === "%" ? "pct" : headerUnit;
    }
    const input: Record<string, unknown> = {
      member, date, metric, value, unit, body_state: spec.fasted ? "fasted" : "not_recorded", measurer: "not_recorded",
      ...(spec.side ? { side: spec.side } : {}),
      ...(spec.bia && device ? { method: device } : {}),
      ...(conditions ? { conditions } : {}),
      ...(note ? { note } : {}),
    };
    const res = await ld.write("log_reading", input, origin, { evidence: row, key: `reading_${col}` });
    if (res) {
      ld.record(origin, { table: "reading", id: (res.reading as { id: number }).id, tool: "log_reading" });
      if (note) note = "";
      wrote = true;
    }
  }
  rd.flush();
  if (note && !wrote) {
    await ld.write("write_member_note", { member, topic: `Body note ${date}`, body: note }, origin, { key: "note" });
  }
}

// ------------------------------------------------------------------- Bloods

interface RefRange {
  low?: number;
  high?: number;
  unit?: string;
}

export function parseRef(text: string): RefRange | null {
  const t = text.trim();
  let m = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*([^\d\s(][^(]*)?$/.exec(t);
  if (m) return { low: Number(m[1]), high: Number(m[2]), ...(m[3]?.trim() ? { unit: (m[3] as string).trim() } : {}) };
  m = /^([<>])=?\s*(\d+(?:\.\d+)?)\s*([^\d\s(][^(]*)?$/.exec(t);
  if (m) {
    const v = Number(m[2]);
    return { ...(m[1] === "<" ? { high: v } : { low: v }), ...(m[3]?.trim() ? { unit: (m[3] as string).trim() } : {}) };
  }
  return null;
}

const ABSENT = /^(not (retested|done|received)|-|n\/a)$/i;

export async function loadBloods(ld: Loader): Promise<void> {
  for (const file of Object.keys(PERSON_FILES)) {
    const member = ld.memberOfFile(file);
    const sheet = ld.sheet(file, "Bloods");
    if (!member || !sheet) continue;
    await loadBloodsTab(ld, member, sheet);
  }
}

async function loadBloodsTab(ld: Loader, member: string, sheet: Sheet): Promise<void> {
  const all: Row[] = [];
  for (let n = 1; n <= sheet.data.rows; n++) all.push(sheet.row(n));
  const header = all.find((r) => r.text("A").toLowerCase() === "marker");
  if (!header) {
    ld.book.raise({ origin: { file: sheet.file, tab: sheet.name, row: 1 }, code: "no_marker_table", kind: "semantic", problem: "Bloods has no Marker header row.", proposed_fix: "Keep the tab as a note only.", proposal: null });
    return;
  }
  const labRows = all.filter((r) => r.n > header.n && !r.blank("A") && !r.blank("D"));
  const lastLab = labRows.at(-1)?.n ?? header.n;
  const drawCols = ["B", "C", "D", "E"].filter((c) => {
    try {
      return parseDate(header.raw(c)).value !== null;
    } catch {
      return false;
    }
  });
  const title = (all[0]?.text("B") ?? "").split(/[.:]/)[0]?.trim() ?? "";
  const unitsRuling = ld.book.raise<string>({
    origin: ld.origin(header), code: "lab_units", kind: "semantic",
    problem: "Most results carry no unit in Sheets (only some reference ranges name one), and the app needs a unit for every numeric result.",
    proposed_fix: 'Record the unit as "not recorded" where Sheets gives none (the lab report PDFs hold the real units).',
    proposal: "not recorded",
  });
  const hdr = new RowReader(ld, header);
  for (const col of drawCols) {
    const date = hdr.date(col) as string;
    const lab = ld.book.raise<string>({
      origin: ld.origin(header), code: "blood_lab", key: col, kind: "semantic",
      problem: `The ${date} draw's lab is named only in prose ("${all[0]?.text("B").slice(0, 80) ?? ""}").`,
      proposed_fix: title ? `Use "${title}", or give the lab as override.` : "Give the lab as override.",
      proposal: title || null,
    });
    if (!lab.apply) continue;
    const results: Record<string, unknown>[] = [];
    for (const row of labRows) {
      const rr = await labResults(ld, member, row, col, date, unitsRuling.apply ? unitsRuling.value : null);
      results.push(...rr);
    }
    if (results.length === 0) continue;
    const res = await ld.write("log_blood_draw", { member, date, lab: lab.value, results }, ld.origin(header), { evidence: header, key: `draw_${col}` });
    if (res) ld.record(ld.origin(header), { table: "blood_draw", id: (res.draw as { id: number }).id, tool: "log_blood_draw" });
  }
  hdr.flush();
  const prose = all.filter((r) => r.n !== header.n && !labRows.includes(r) && !(r.n > header.n && r.n < lastLab) && r.rendered("A") + r.rendered("B") + r.rendered("C") !== "");
  if (prose.length > 0) {
    const body = prose.map((r) => ["A", "B", "C", "D", "E", "F", "G"].map((c) => r.rendered(c).trim()).filter(Boolean).join(" | ")).join("\n");
    await ld.write("write_member_note", { member, topic: "bloods: notes from Sheets", body }, ld.origin(prose[0] as Row), { key: "note" });
  }
}

async function labResults(ld: Loader, member: string, row: Row, col: string, date: string, defaultUnit: string | null): Promise<Record<string, unknown>[]> {
  const origin = ld.origin(row);
  const rd = new RowReader(ld, row);
  const marker = row.text("A");
  const cellText = row.text(col);
  if (cellText === "") return [];
  if (/not received/i.test(cellText)) {
    const r = ld.book.raise<Record<string, unknown>>({
      origin, code: "result_not_received", key: col, kind: "semantic",
      problem: `${marker} was ordered for the ${date} draw but the result was never received.`,
      proposed_fix: `Raise an open data flag "${marker} result never received".`,
      proposal: { member, subtype: "data", subject: `${marker} result never received (${date} draw)`, raised_on: date },
      row: row.cells(["A", col]),
    });
    if (r.apply) await ld.write("raise_flag", r.value as Record<string, unknown>, origin, { key: `flag_${col}` });
    return [];
  }
  if (ABSENT.test(cellText)) return [];
  const refText = row.text("D");
  const note = row.text("G");
  // A combined row ("Creatinine / GFR" = "0.88 / 119") splits into its markers.
  const markers = marker.split(/\s+\/\s+/);
  const values = cellText.split(/\s*\/\s*/);
  const refs = refText.split(/\s+\/\s+/);
  let parts: { marker: string; text: string; ref: string }[] = [{ marker, text: cellText, ref: refText }];
  if (markers.length > 1 && values.length === markers.length) {
    const r = ld.book.raise({
      origin, code: "combined_marker", kind: "semantic",
      problem: `"${marker}" holds ${markers.length} markers in one row ("${cellText}").`,
      proposed_fix: `Split it into ${markers.join(", ")}, pairing values and ranges in order.`,
      proposal: "split", row: row.cells(["A", "B", "C", "D"]),
    });
    if (!r.apply) return [];
    parts = markers.map((m, i) => ({ marker: m, text: values[i] as string, ref: refs.length === markers.length ? (refs[i] as string) : refText }));
  }
  const out: Record<string, unknown>[] = [];
  for (const p of parts) {
    let value: number | null;
    try {
      const parsed = parseNumber(p.text);
      value = parsed.value;
      if (parsed.repair) rd.note(col, parsed.repair);
    } catch {
      out.push({ marker: p.marker, value_text: p.text, ...(note ? { note } : {}) });
      continue;
    }
    if (value === null) continue;
    const ref = parseRef(p.ref);
    if (value !== null && ref?.low !== undefined && value < ref.low / 10 && value < 1) {
      const r = ld.book.raise<number>({
        origin, code: "percent_as_fraction", ...(parts.length > 1 ? { key: p.marker } : {}), kind: "semantic",
        problem: `${p.marker} is ${value} against a range of ${p.ref}: a percentage stored as a fraction.`,
        proposed_fix: `Read it as ${Math.round(value * 100 * 1e6) / 1e6}.`,
        proposal: Math.round(value * 100 * 1e6) / 1e6, row: row.cells(["A", col, "D"]),
      });
      if (!r.apply) continue;
      value = r.value;
    }
    const unit = ref?.unit ?? defaultUnit;
    if (unit === null) continue;
    out.push({
      marker: p.marker, value, unit,
      ...(ref?.low !== undefined ? { ref_low: ref.low } : {}),
      ...(ref?.high !== undefined ? { ref_high: ref.high } : {}),
      ...(p.ref ? { ref_text: p.ref } : {}),
      ...(note ? { note } : {}),
    });
  }
  rd.flush();
  return out;
}

// -------------------------------------------------------------------- goals

function targetDate(ld: Loader): string | null {
  for (const file of ["base", ...Object.keys(PERSON_FILES)]) {
    for (const row of ld.sheet(file, "Guide")?.rows(1) ?? []) {
      if (row.text("B").toLowerCase() !== "target date") continue;
      const m = /(\d{1,2} [A-Za-z]{3} \d{4})/.exec(row.text("C"));
      if (!m) continue;
      try {
        return parseDate(m[1] as string).value;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function loadGoals(ld: Loader): Promise<void> {
  for (const file of Object.keys(PERSON_FILES)) {
    const member = ld.memberOfFile(file);
    if (!member) continue;
    for (const row of ld.sheet(file, "Trajectory")?.rows() ?? []) {
      const origin = ld.origin(row);
      const rd = new RowReader(ld, row);
      let week: string | null;
      let waist: number | null;
      let weight: number | null;
      try {
        week = rd.date("B");
        waist = rd.num("D");
        weight = rd.num("F");
      } catch (error) {
        if (!(error instanceof ParseError)) throw error;
        ld.book.raise({ origin, code: "unreadable_value", kind: "semantic", problem: error.message, proposed_fix: "Correct the row, or leave it out.", proposal: null, row: row.cells(["A", "B", "D", "F"]) });
        continue;
      }
      if (!week) continue;
      const note = [row.text("C"), row.text("H")].filter(Boolean).join("; ");
      for (const [metric, value, unit] of [["waist_navel", waist, "cm"], ["weight", weight, "kg"]] as const) {
        if (value === null) continue;
        const res = await ld.write("create_goal_point", {
          member, metric, week_of: week, tier: "planned", basis: "absolute", value_low: value, value_high: value, unit, ...(note ? { note } : {}),
        }, origin, { evidence: row, key: `goal_${metric}` });
        if (res) ld.record(origin, { table: "goal_point", id: (res.goal_point as { id: number }).id, tool: "create_goal_point" });
      }
      rd.flush();
    }
    // Goal lifts: Chart Data AD (lift) and AG (goal), rows 3-9; typed, with no date.
    const chart = ld.sheet(file, "Chart Data");
    if (!chart) continue;
    const due = targetDate(ld);
    for (let n = 3; n <= Math.min(chart.data.rows, 9); n++) {
      const row = chart.row(n);
      const lift = row.text("AD");
      if (!lift || row.formula("AG") !== null) continue;
      let goal: number | null;
      try {
        goal = parseNumber(row.raw("AG")).value;
      } catch {
        goal = null;
      }
      if (goal === null) continue;
      const origin = ld.origin(row);
      const r = ld.book.raise<string>({
        origin, code: "undated_goal_lift", kind: "semantic",
        problem: `The goal lift "${lift}" (${goal} kg e1RM) has no date; a goal point needs one.`,
        proposed_fix: due ? `Date it to the Guide's target date, ${due}.` : "Give the date as override.",
        proposal: due, row: row.cells(["AD", "AG"]),
      });
      if (!r.apply) continue;
      await ld.write("create_goal_point", {
        member, exercise: lift, week_of: r.value, tier: "planned", basis: "absolute", value_low: goal, value_high: goal, unit: "kg",
        note: "Goal lift from Chart Data; Sheets gives no date.",
      }, origin, { evidence: row, key: "goal_lift" });
    }
  }
}
