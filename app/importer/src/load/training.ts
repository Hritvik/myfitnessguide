/**
 * Training: exercises (create_exercise), Hritvik's Program (create_programme),
 * Log rows as sessions and sets (start_session, log_set) and Cardio rows as
 * cardio sessions and classes (log_cardio).
 *
 * The Log's Total Load, Volume and e1RM are typed, not formulas: the app
 * recomputes them, so the typed values go to the write log's audit detail
 * and the parity report compares them. The typed total also says how a
 * per-hand / per-leg load was counted (unilateral or not) and what bar a
 * per-side load sat on.
 */
import type { Row } from "../grid";
import { PERSON_FILES } from "../layout";
import { parseRepRange, parseRirCell, ParseError } from "../parse";
import type { Cell } from "../snapshot";
import { originKey } from "../rulings";
import { readNativeLoad } from "@myfitnessguide/domain";
import { nativeOf, rowComposition } from "./compositions";
import { Loader, RowReader } from "./context";

// ----------------------------------------------------------------- exercises

type Kind = "barbell" | "dumbbell" | "machine" | "plate_loaded" | "cable" | "bodyweight" | "cardio_machine" | "other";

const KIND_RULES: [RegExp, Kind][] = [
  [/\bassisted\b/i, "machine"],
  [/\b(db|dumbbells?|hammer curl|bicep curl|goblet|farmer|lateral raise|front raise|swing)\b/i, "dumbbell"],
  [/\b(cable|pushdown|face pull|pulldown)\b/i, "cable"],
  [/\b(barbell|bench press|romanian deadlift|rdl)\b/i, "barbell"],
  [/\b(leg press|hack squat|hip thrust)\b/i, "plate_loaded"],
  [/\b(machine|leg extension|leg curl|hip abduction|seated calf|low row|seated row|chest press|rear delt fly|reverse delt fly)\b/i, "machine"],
  [/\b(treadmill|zone 2|intervals|walk)\b/i, "cardio_machine"],
  [/\b(pull-?up|dead hang|crunch|calf raise|squat|bridge|leg raise|cat and camel|child and cobra|side kick|kickback|mat workout|push-?up|plank)\b/i, "bodyweight"],
];

export function guessKind(name: string): Kind | null {
  return KIND_RULES.find(([re]) => re.test(name))?.[1] ?? null;
}

/** Program names carry a superset tag ("Cable Fly  [SS-A]"); the exercise is the name without it. */
export function programExercise(name: string): { name: string; tag: string | null } {
  const m = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(name.trim());
  return m ? { name: (m[1] as string).trim(), tag: m[2] as string } : { name: name.trim(), tag: null };
}

const lookalikeKey = (name: string) => name.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

export async function loadExercises(ld: Loader): Promise<void> {
  const seen = new Map<string, { name: string; row: Row }>();
  const visit = (name: string, row: Row) => {
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), { name, row });
  };
  for (const file of Object.keys(PERSON_FILES)) {
    for (const row of ld.sheet(file, "Program")?.rows() ?? []) visit(programExercise(row.text("C")).name, row);
    for (const row of ld.sheet(file, "Log")?.rows() ?? []) visit(row.text("E"), row);
  }
  const byKey = new Map<string, string>();
  for (const { name, row } of seen.values()) {
    const origin = ld.origin(row);
    const key = lookalikeKey(name);
    const twin = byKey.get(key);
    let alias = false;
    if (twin) {
      const r = ld.book.raise<string | { alias_of: string }>({
        origin, code: "exercise_mapping", kind: "semantic",
        problem: `"${name}" looks like "${twin}" (same name apart from a qualifier); they may be one exercise.`,
        proposed_fix: `Keep them as separate exercises, or set override to { alias_of: "${twin}" } to make "${name}" an alias.`,
        proposal: "separate", row: row.cells([row.tab.name === "Program" ? "C" : "E"]),
      });
      if (!r.apply) continue;
      if (typeof r.value === "object" && r.value !== null && "alias_of" in r.value) alias = true;
    } else byKey.set(key, name);
    if (alias) continue; // added as an alias of its twin below
    let kind = guessKind(name);
    if (kind === null) {
      const r = ld.book.raise<Kind>({
        origin, code: "exercise_kind", kind: "semantic",
        problem: `"${name}" does not say what kind of implement it is done on.`,
        proposed_fix: "Use other, or give the implement kind as override (barbell, dumbbell, machine, plate_loaded, cable, bodyweight, ...).",
        proposal: "other", row: row.cells([row.tab.name === "Program" ? "C" : "E"]),
      });
      if (!r.apply) continue;
      kind = r.value;
    }
    const aliases = [...seen.values()]
      .filter((x) => x.name !== name && lookalikeKey(x.name) === key)
      .filter((x) => {
        const id = `${ld.origin(x.row).file}/${x.row.tab.name}!${x.row.n}/exercise_mapping`;
        const prior = ld.book.previous(id);
        const ov = prior?.override as { alias_of?: string } | null | undefined;
        return prior?.decision === "accepted" && ov?.alias_of === name;
      })
      .map((x) => x.name);
    await ld.write("create_exercise", { name, implement_kind: kind, ...(aliases.length ? { aliases } : {}) }, origin, { evidence: row, key: "create_exercise" });
  }
}

// ------------------------------------------------------------------ programme

interface Prescribed {
  row: Row;
  template: string;
  input: Record<string, unknown>;
  notes: string[];
}

export async function loadProgrammes(ld: Loader): Promise<void> {
  for (const file of Object.keys(PERSON_FILES)) {
    const member = ld.memberOfFile(file);
    const sheet = ld.sheet(file, "Program");
    const rows = sheet?.rows() ?? [];
    if (!member || !sheet || rows.length === 0) continue;
    const templates: string[] = [];
    const prescribed: Prescribed[] = [];
    const programmeNotes: { row: Row; topic: string; body: string }[] = [];
    for (const row of rows) {
      const template = row.text("A");
      if (template && !templates.includes(template)) templates.push(template);
      const p = prescription(ld, row);
      if (p === "note") {
        const ex = programExercise(row.text("C")).name;
        programmeNotes.push({ row, topic: `programme: ${ex} (${template})`, body: proseOf(row, PROGRAM_PROSE) });
      } else if (p) prescribed.push({ row, template, input: p.input, notes: p.notes });
    }
    // Sheets has no structured schedule: the order of first appearance makes a provisional rotation.
    const firstRow = sheet.row(1);
    const schedule = ld.book.raise<string | Record<string, number>>({
      origin: ld.origin(firstRow), code: "programme_schedule", kind: "semantic",
      problem: `Program holds no structured schedule. Handover describes ${member}'s plan in prose (a fixed weekday plan, set 3 Oct).`,
      proposed_fix: `Use a rotation in the order the templates first appear (${templates.join(", ")}), or set override to a weekday plan such as { "Lower B": 1, "Upper B": 2 } (ISO weekday, 1 = Monday).`,
      proposal: "rotation", row: {},
    });
    if (!schedule.apply) continue;
    const slots =
      typeof schedule.value === "object"
        ? Object.entries(schedule.value).map(([template, weekday]) => ({ weekday, template }))
        : templates.map((template, i) => ({ rotation_position: i + 1, template }));
    const startedOn = firstLogDate(ld, file) ?? ld.at.slice(0, 10);
    const res = await ld.write("create_programme", {
      member, name: "Programme", schedule_kind: typeof schedule.value === "object" ? "weekday" : "rotation", started_on: startedOn,
      templates: templates.map((t) => ({ name: t, session_type: "strength", prescriptions: prescribed.filter((p) => p.template === t).map((p) => p.input) })),
      slots,
    }, ld.origin(firstRow), { key: "create_programme" });
    if (!res) continue;
    const programmeId = (res.programme as { id: number }).id;
    ld.facts.set(`programme:${member}`, programmeId);
    for (const t of templates) {
      const list = prescribed.filter((p) => p.template === t);
      for (const [i, p] of list.entries()) {
        const id = ld.db.get<{ id: number }>(
          "SELECT p.id FROM prescription p JOIN session_template t ON t.id = p.template_id WHERE t.programme_id = ? AND t.name = ? AND p.position = ?",
          programmeId, t, i + 1,
        )?.id;
        if (id === undefined) continue;
        ld.record(ld.origin(p.row), { table: "prescription", id, tool: "create_programme" });
        if (p.notes.length > 0) {
          await ld.write("write_member_note", { member, topic: "prescription notes from Sheets", body: p.notes.join("\n"), subject: { table: "prescription", id } }, ld.origin(p.row), { key: "note" });
        }
      }
    }
    for (const n of programmeNotes) {
      await ld.write("write_member_note", { member, topic: n.topic, body: n.body, subject: { table: "programme", id: programmeId } }, ld.origin(n.row), { key: "note" });
    }
  }
}

const PROGRAM_PROSE: [string, string][] = [
  ["E", "Sets"], ["F", "Reps"], ["G", "RIR"], ["H", "Rest"], ["I", "Load value"], ["J", "Load unit"], ["K", "Load basis"],
  ["L", "Last moved"], ["M", "Progression rule"], ["N", "Cue / note"], ["O", "Current weight (typed)"], ["P", "Fallback"],
];

function proseOf(row: Row, cols: [string, string][]): string {
  return cols.filter(([c]) => row.rendered(c).trim() !== "" && row.rendered(c).trim() !== "-").map(([c, label]) => `${label}: ${row.rendered(c).trim()}`).join("\n");
}

function firstLogDate(ld: Loader, file: string): string | null {
  const dates: string[] = [];
  for (const row of ld.sheet(file, "Log")?.rows() ?? []) {
    try {
      const d = new RowReader(ld, row).date("A");
      if (d) dates.push(d);
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
    }
  }
  return dates.sort()[0] ?? null;
}

type Basis = "total" | "per_side" | "per_hand" | "per_leg" | "assistance" | "none";

/** Sheets' load basis text. "Per ankle" is per leg: one ankle weight on each leg (cutover, 6 Oct 2026). */
const BASIS: Record<string, Basis> = {
  total: "total", machine: "total", added: "total", "": "total", "per hand": "per_hand", "per side": "per_side", "per side added": "per_side",
  "per leg": "per_leg", "added, per leg": "per_leg", "per ankle": "per_leg", assistance: "assistance", bodyweight: "none",
};
const BASES = new Set<string>(["total", "per_side", "per_hand", "per_leg", "assistance", "none"]);

/**
 * A basis Sheets gives in words the app doesn't know: a semantic ruling with
 * no proposal. A decided override `{ basis }` (the app's name or Sheets'
 * words) is the basis; one that is neither is a new ruling. Undefined = leave
 * the load (or the set) out.
 */
function ruledBasis(ld: Loader, row: Row, cells: string[]): Basis | undefined {
  const origin = ld.origin(row);
  const r = ld.book.raise<{ basis?: unknown } | null>({
    origin, code: "load_basis", kind: "semantic", problem: `Load basis "${row.text("K")}" is not one the app knows.`,
    proposed_fix: "Say how the load was counted: override { basis: total | per_side | per_hand | per_leg | assistance | none }.", proposal: null, row: row.cells(cells),
  });
  if (!r.apply) return undefined;
  const text = String(r.value?.basis ?? "").trim().toLowerCase();
  const basis = BASES.has(text) ? (text as Basis) : BASIS[text];
  if (basis !== undefined && text !== "") return basis;
  ld.book.raise({
    origin, code: "load_basis_override", kind: "semantic", problem: `The ruling gives the basis "${String(r.value?.basis ?? "")}", which is not one the app knows.`,
    proposed_fix: "Give one of total, per_side, per_hand, per_leg, assistance or none.", proposal: null, row: row.cells(cells),
  });
  return undefined;
}

function prescription(ld: Loader, row: Row): { input: Record<string, unknown>; notes: string[] } | "note" | null {
  const origin = ld.origin(row);
  const rd = new RowReader(ld, row);
  const { name, tag } = programExercise(row.text("C"));
  let sets: number | null = null;
  let reps: ReturnType<typeof parseRepRange> = null;
  let rir: { low: number; high: number } | null = null;
  try {
    sets = rd.num("E");
  } catch {
    sets = null;
  }
  reps = parseRepRange(row.raw("F"));
  if (reps?.repair === "range_date_serial") rd.serial("F", row.raw("F") as number, "rep range");
  const rirCell = parseRirCell(row.raw("G"));
  if (rirCell.kind === "range") rir = { low: rirCell.low, high: rirCell.high };
  if (!sets || !Number.isInteger(sets) || !reps || !rir) {
    const r = ld.book.raise<string | { prescription_target?: string; progression?: string }>({
      origin, code: "not_a_strength_prescription", kind: "semantic",
      problem: `"${row.text("C")}" has no sets / rep range / RIR target a prescription can hold (sets "${row.text("E")}", reps "${row.rendered("F")}", RIR "${row.text("G")}").`,
      proposed_fix: "Keep it as a note on the programme, or override { prescription_target: duration | distance | reps, progression: manual } to keep it as a prescription with that target and no RIR.",
      proposal: "member_note", row: row.cells(["A", "C", "E", "F", "G"]),
    });
    rd.flush();
    if (!r.apply) return null;
    if (typeof r.value === "object" && r.value !== null && r.value.prescription_target) {
      return targetPrescription(ld, row, r.value.prescription_target, sets, reps, rir);
    }
    return "note";
  }
  const input: Record<string, unknown> = { exercise: name, sets, rep_low: reps.low, rep_high: reps.high, rir_target_low: rir.low, rir_target_high: rir.high };
  const rest = /^(\d+)\s*s$/i.exec(row.text("H"));
  if (rest) input.rest_s = Number(rest[1]);
  const load = programLoad(ld, row, rd);
  if (load) input.load = load;
  const rule = /when\s+(\d+)\s*x\s*(\d+)/i.exec(row.text("M"));
  const proposal = rule ? { kind: "rep_top", target_sets: Number(rule[1]), rep_top: Number(rule[2]), rir_floor: rir.low } : { kind: "manual" };
  const r = ld.book.raise<Record<string, unknown>>({
    origin, code: "progression_rule", kind: "semantic",
    problem: `The progression rule is prose: "${row.text("M")}".`,
    proposed_fix: rule ? `Store it as rep_top: ${rule[1]} sets reaching ${rule[2]} reps at RIR ${rir.low} or more (the increment stays in the note).` : "Store it as a manual rule (the agent decides), keeping the prose in a note.",
    proposal, row: row.cells(["C", "M"]),
  });
  if (r.apply) input.progression_rule = storedRule(r.value);
  const cue = [row.text("N"), tag ? `Superset ${tag}.` : ""].filter(Boolean).join(" ");
  if (cue) input.cue = cue;
  if (row.text("P")) input.fallback_note = row.text("P");
  rd.flush();
  const notes = proseOf(row, [["L", "Last moved"], ["M", "Progression rule"], ["O", "Current weight (typed)"]]);
  return { input, notes: notes ? [notes] : [] };
}

/**
 * A ruled progression rule as the API stores it. Rulings give the increment
 * in kg with a basis (`{ min_kg, max_kg, basis }`, 0/0 meaning the smallest
 * producible step), a cue, per_leg, and a RIR floor that may be
 * "from_prescription".
 */
export function storedRule(value: Record<string, unknown>): Record<string, unknown> {
  if (value.kind !== "rep_top") return { kind: "manual", ...(typeof value.cue === "string" ? { cue: value.cue } : {}) };
  const out: Record<string, unknown> = { kind: "rep_top", target_sets: value.target_sets, rep_top: value.rep_top, rir_floor: value.rir_floor };
  const inc = value.increment as { min_kg?: number; max_kg?: number; basis?: string; min?: number; max?: number } | undefined;
  if (inc && inc.min_kg !== undefined) {
    const max = inc.max_kg ?? inc.min_kg;
    out.increment = inc.min_kg === 0 && max === 0 ? "smallest_step" : { min: inc.min_kg, max, unit: "kg", ...(inc.basis ? { basis: inc.basis } : {}) };
  } else if (inc) out.increment = inc;
  if (value.per_leg === true) out.per_leg = true;
  if (typeof value.cue === "string") out.cue = value.cue;
  if (value.autoregulation) out.autoregulation = value.autoregulation;
  return out;
}

/** A Program row's starting load (I value, J unit, K basis), when it is one; assistance is negative. */
function programLoad(ld: Loader, row: Row, rd: RowReader): Record<string, unknown> | null {
  let basis: Basis | undefined = BASIS[row.text("K").toLowerCase()];
  const unit = row.text("J").toLowerCase();
  let value: number | null = null;
  try {
    value = rd.num("I");
  } catch {
    value = null;
  }
  if (value === null || (unit !== "kg" && unit !== "lb")) return null;
  // A load whose basis isn't known is a ruling, never dropped silently.
  if (basis === undefined) basis = ruledBasis(ld, row, ["C", "I", "J", "K"]);
  if (!basis || basis === "none") return null;
  // In its native unit (9.07 kg is 20 lb). A planned load clean in no unit (a
  // kg bar plus lb plates as one total) stays as typed: it is a plan, and
  // the coach moves it with programme_change.
  const signed = basis === "assistance" ? -value : value;
  const read = readNativeLoad(signed, unit);
  const load = read.status === "clean" ? { value: read.value, unit: read.unit } : { value: signed, unit };
  return { ...load, basis: basis === "assistance" ? "total" : basis };
}

/** A Program row kept as a prescription with a duration, distance or RIR-less rep target, its rule manual. */
function targetPrescription(
  ld: Loader, row: Row, kind: string, sets: number | null, reps: ReturnType<typeof parseRepRange>, rir: { low: number; high: number } | null,
): { input: Record<string, unknown>; notes: string[] } | null {
  const { name, tag } = programExercise(row.text("C"));
  const f = row.rendered("F").trim();
  let target: Record<string, unknown>;
  if (kind === "duration") {
    const m = /^(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?\s*(min|mins|minutes|s|sec|secs|seconds)$/i.exec(f);
    const scale = m && /^m/i.test(m[3] as string) ? 60 : 1;
    target = m ? { kind: "duration", low_s: Math.round(Number(m[1]) * scale), high_s: Math.round(Number(m[2] ?? m[1]) * scale) } : { kind: "duration" };
  } else if (kind === "distance") {
    const m = /^(\d+(?:\.\d+)?)\s*(m|km|mi)$/i.exec(f);
    if (!m) return unreadableTarget(ld, row, kind);
    target = { kind: "distance", value: Number(m[1]), unit: (m[2] as string).toLowerCase() };
  } else {
    if (!reps) return unreadableTarget(ld, row, kind);
    target = { kind: "reps" };
  }
  const input: Record<string, unknown> = { exercise: name, target, progression_rule: { kind: "manual" } };
  const rd = new RowReader(ld, row);
  const load = programLoad(ld, row, rd);
  rd.flush();
  if (load) input.load = load;
  if (sets !== null && Number.isInteger(sets) && sets >= 1) input.sets = sets;
  if (kind === "reps" && reps) Object.assign(input, { rep_low: reps.low, rep_high: reps.high });
  if (rir) Object.assign(input, { rir_target_low: rir.low, rir_target_high: rir.high });
  const rest = /^(\d+)\s*s$/i.exec(row.text("H"));
  if (rest) input.rest_s = Number(rest[1]);
  const cue = [row.text("N"), tag ? `Superset ${tag}.` : ""].filter(Boolean).join(" ");
  if (cue) input.cue = cue;
  if (row.text("P")) input.fallback_note = row.text("P");
  const notes = proseOf(row, [["F", "Target in Sheets"], ["L", "Last moved"], ["M", "Progression rule"], ["O", "Current weight (typed)"]]);
  return { input, notes: notes ? [notes] : [] };
}

function unreadableTarget(ld: Loader, row: Row, kind: string): null {
  ld.book.raise({
    origin: ld.origin(row), code: "prescription_target", kind: "semantic",
    problem: `"${row.text("C")}" was ruled a ${kind} prescription, but "${row.rendered("F")}" is not a ${kind}.`,
    proposed_fix: "Give the target as override (for example { kind: distance, value: 40, unit: m }), or leave it out.", proposal: null, row: row.cells(["A", "C", "F"]),
  });
  return null;
}

// --------------------------------------------------------------------- Log

const SET_TYPES: Record<string, string> = { "": "working", working: "working", calibration: "calibration", "warm-up": "warm_up", warmup: "warm_up", "warm up": "warm_up", accessory: "working", "back-off": "back_off" };

const near = (a: number, b: number, tol = 0.051) => Math.abs(a - b) <= tol;

export async function loadLog(ld: Loader): Promise<void> {
  for (const file of Object.keys(PERSON_FILES)) {
    const member = ld.memberOfFile(file);
    if (!member) continue;
    const programmeId = ld.facts.get(`programme:${member}`) as number | undefined;
    const templates = new Set(
      programmeId === undefined ? [] : ld.db.all<{ name: string }>("SELECT name FROM session_template WHERE programme_id = ?", programmeId).map((t) => t.name.toLowerCase()),
    );
    const sessions = new Map<string, number>();
    const lastRowFor = new Map<string, Row>();
    const used = new Map<string, Set<number>>();
    for (const row of runningOrder(ld, file, ld.sheet(file, "Log")?.rows() ?? [])) {
      const origin = ld.origin(row);
      const rd = new RowReader(ld, row);
      let date: string | null = null;
      try {
        date = rd.date("A");
      } catch (error) {
        if (!(error instanceof ParseError)) throw error;
      }
      if (!date || !row.text("E")) {
        ld.book.raise({ origin, code: "unreadable_row", kind: "semantic", problem: `A Log row has no readable date or exercise ("${row.text("A")}", "${row.text("E")}").`, proposed_fix: "Correct it, or leave it out.", proposal: null, row: row.cells(["A", "D", "E", "G", "H"]) });
        continue;
      }
      const sessionName = row.text("D");
      const key = `${date}\u0000${sessionName.toLowerCase()}`;
      let sessionId = sessions.get(key);
      if (sessionId === undefined) {
        const res = await ld.write("start_session", {
          member, date, session_type: "strength",
          ...(templates.has(sessionName.toLowerCase()) ? { template: sessionName } : {}),
          ...(sessionName ? { note: `Sheets session: ${sessionName}` } : {}),
        }, origin, { evidence: row, key: "start_session" });
        if (!res) continue;
        sessionId = (res.session as { id: number }).id;
        sessions.set(key, sessionId);
        ld.record(origin, { table: "session", id: sessionId, tool: "start_session" });
      }
      lastRowFor.set(key, row);
      await loadSet(ld, row, rd, sessionId, used);
    }
    // A historical session is finished once its rows are in: end it so the
    // imported history is confirmed rather than left in the live-session draft
    // state start_session always opens with.
    for (const [key, sessionId] of sessions) {
      const row = lastRowFor.get(key);
      if (!row) continue;
      await ld.write("end_session", { session_id: sessionId }, ld.origin(row), { evidence: row, key: "end_session" });
    }
  }
}

/**
 * The Log rows in running order. A pointer row ruled `{ replace_with_rows:
 * "<file>/Log!<from>-<to>", at_position_of: "<file>/Log!<n>" }` has the
 * rows it names moved to its place (log_set appends, so sheet order is the
 * session's running order). The pointer row itself stays where it is, to be
 * refused and ruled as before.
 */
export function runningOrder(ld: Loader, file: string, rows: Row[]): Row[] {
  let out = [...rows];
  for (const pointer of rows) {
    const prior = ld.book.previous(`${file}/Log!${pointer.n}/rejected_by_api/log_set`);
    const ov = prior?.override as { replace_with_rows?: string; at_position_of?: string } | null | undefined;
    if (!ov?.replace_with_rows) continue;
    const range = /^([^/]+)\/Log!(\d+)-(\d+)$/.exec(ov.replace_with_rows);
    const at = /^([^/]+)\/Log!(\d+)$/.exec(ov.at_position_of ?? `${file}/Log!${pointer.n}`);
    if (!range || !at || range[1] !== file || at[1] !== file) continue;
    const [from, to, n] = [Number(range[2]), Number(range[3]), Number(at[2])];
    const moved = out.filter((r) => r.n >= from && r.n <= to);
    out = out.filter((r) => r.n < from || r.n > to);
    const i = out.findIndex((r) => r.n === n);
    out.splice(i + 1, 0, ...moved);
  }
  return out;
}

async function loadSet(ld: Loader, row: Row, rd: RowReader, sessionId: number, used: Map<string, Set<number>>): Promise<void> {
  const origin = ld.origin(row);
  const exercise = row.text("E");
  let reps: number | null = null, setNo: number | null = null, weight: number | null = null, typedTotal: number | null = null, volume: number | null = null, e1rm: number | null = null;
  let distance: number | null = null, duration: number | null = null;
  // "20 per leg": reps counted per side, as typed text.
  const perSide = /^(\d+)\s*per (leg|side|arm|hand)$/i.exec(row.text("H"));
  // Reps read by hand when a ruling gives them ({ reps, note }) for a cell that isn't a number.
  let handReps: { reps: number; note: string | null } | null = null;
  const read = () => {
    if (handReps) reps = handReps.reps;
    else if (perSide) {
      reps = Number(perSide[1]);
      rd.note("H", "text_number");
    } else reps = rd.num("H");
    setNo = rd.num("G");
    weight = rd.num("J");
    typedTotal = rd.num("L");
    volume = rd.num("M");
    e1rm = rd.num("N");
    distance = rd.num("R");
    duration = rd.num("S");
  };
  try {
    read();
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    const r = ld.book.raise<{ reps?: number; note?: string } | null>({ origin, code: "unreadable_value", kind: "semantic", problem: error.message, proposed_fix: "Correct the row (override { reps, note }), or leave it out.", proposal: null, row: row.cells(["E", "G", "H", "J", "K", "L", "M", "N", "R", "S"]) });
    const given = r.apply && typeof r.value === "object" && r.value !== null && typeof r.value.reps === "number" ? r.value : null;
    if (!given) return;
    handReps = { reps: given.reps as number, note: given.note ?? null };
    try {
      read();
    } catch (again) {
      if (!(again instanceof ParseError)) throw again;
      return;
    }
  }
  const input: Record<string, unknown> = { session_id: sessionId, exercise };
  if (reps !== null) input.reps = reps;
  if (distance !== null) input.distance = { value: distance, unit: "m" };
  if (duration !== null) input.duration_s = Math.round(duration);

  // Set type.
  const typeText = row.text("Q").toLowerCase();
  let setType = SET_TYPES[typeText];
  if (!setType) {
    const r = ld.book.raise<string | { set_type?: string; replaces?: string }>({
      origin, code: typeText.startsWith("substitut") ? "substitution_set" : "set_type", kind: "semantic",
      problem: typeText.startsWith("substitut")
        ? "A substitution set; Sheets does not say which prescription it replaced, which the app needs."
        : `Set type "${row.text("Q")}" is not one the app knows.`,
      proposed_fix: "Log it as a working set, keeping the Sheets type in the note, or override { set_type: substitution, replaces: <prescribed exercise> }.", proposal: "working", row: row.cells(["E", "Q"]),
    });
    if (!r.apply) return;
    if (typeof r.value === "object" && r.value !== null) {
      setType = r.value.set_type ?? "working";
      if (setType === "substitution") {
        const replaced = r.value.replaces ? replacedPrescription(ld, sessionId, r.value.replaces) : null;
        if (replaced === null) {
          ld.book.raise({
            origin, code: "substitution_target", kind: "semantic",
            problem: `The ruling says this set replaced "${r.value.replaces ?? ""}", which no prescription of the member's programme names.`,
            proposed_fix: "Name the prescribed exercise it replaced, or log it as a working set.", proposal: null, row: row.cells(["A", "D", "E", "Q"]),
          });
          return;
        }
        input.substituted_prescription_id = replaced;
      }
    } else setType = r.value;
  }
  input.set_type = setType;

  // Set number: unique per exercise in a session.
  const usedKey = `${sessionId}\u0000${exercise.toLowerCase()}`;
  const taken = used.get(usedKey) ?? new Set<number>();
  used.set(usedKey, taken);
  if (setNo !== null && Number.isInteger(setNo) && setNo >= 1) {
    if (taken.has(setNo)) {
      const r = ld.book.raise({ origin, code: "duplicate_set_number", kind: "semantic", problem: `Set ${setNo} of ${exercise} appears twice in this session.`, proposed_fix: "Number it after the session's other sets of the exercise.", proposal: "next", row: row.cells(["A", "D", "E", "G"]) });
      if (!r.apply) return;
      setNo = Math.max(0, ...taken) + 1;
    }
    taken.add(setNo);
    input.set_number = setNo;
  } else {
    setNo = Math.max(0, ...taken) + 1;
    taken.add(setNo);
    input.set_number = setNo;
  }

  // Load as entered, read with the typed total.
  const basisText = row.text("K").toLowerCase();
  const basis = BASIS[basisText] ?? ruledBasis(ld, row, ["E", "J", "K", "L"]);
  if (basis === undefined) return;
  // A load typed in kg is read in its native unit (9.07 kg is the 20 lb
  // dumbbell); one clean in neither unit or in both is a ruling.
  const native = (typed: number): { value: number; unit: "kg" | "lb"; as_stated?: true } | null => {
    const n = nativeOf(typed);
    if (n) return n;
    const r = ld.book.raise<{ value: number; unit: "kg" | "lb" }>({
      origin, code: "load_unit", kind: "semantic",
      problem: `${typed} kg is not a whole or half number in kg or lb (or is one in both), so its unit can't be read.`,
      proposed_fix: "Keep it as typed, or give the load in its own unit (override { value, unit }).",
      proposal: { value: typed, unit: "kg" }, row: row.cells(["E", "J", "K", "L", "P"]),
    });
    return r.apply ? { ...r.value, as_stated: true } : null;
  };
  const composed = weight !== null && (basis === "per_side" || basis === "total") ? rowComposition(ld, origin.file, row, basis, weight) : null;
  if (basis === "none") input.load = "none";
  else if (weight === null) input.load = basisText === "" ? "none" : "not_recorded";
  else if (composed) {
    // The plates on each side, units mixed; the bar the note names, or what the typed total leaves.
    const { composition } = composed;
    const bar = composition.bar ?? { value: basis === "per_side" && typedTotal !== null ? Math.max(0, Math.round((typedTotal - 2 * weight) * 10) / 10) : 0, unit: "kg" as const };
    input.load = { basis: "per_side", plates: composition.plates, bar };
  } else if (basis === "assistance") {
    const n = native(-weight);
    if (!n) return;
    input.load = { ...n, basis: "total" };
  } else if (basis === "per_side") {
    const bar = typedTotal !== null ? Math.max(0, Math.round((typedTotal - 2 * weight) * 10) / 10) : 0;
    const n = native(weight);
    if (!n) return;
    input.load = { ...n, basis, bar: { value: bar, unit: "kg" } };
  } else if (basis === "per_hand" || basis === "per_leg") {
    // Per hand, a typed total of one hand's load means a one-arm set. Per leg
    // it does not: Sheets types one leg's load as the total of a single-leg
    // set that covered both legs (volume counts both legs).
    const unilateral = basis === "per_hand" && typedTotal !== null && near(typedTotal, weight) && !near(typedTotal, 2 * weight);
    const n = native(weight);
    if (!n) return;
    input.load = { ...n, basis, ...(unilateral ? { unilateral: true } : {}) };
  } else {
    const n = native(weight);
    if (!n) return;
    input.load = { ...n, basis };
  }

  // RIR.
  const rirCell = parseRirCell(row.raw("I"));
  if (rirCell.kind === "blank") input.rir = "not_recorded";
  else if (rirCell.kind === "range") {
    input.rir = rirCell.low === rirCell.high ? rirCell.low : { low: rirCell.low, high: rirCell.high };
    if (rirCell.repair === "rir_date_serial") rd.serial("I", row.raw("I") as number, "RIR");
    else if (rirCell.repair === "text_number") rd.note("I", "text_number");
  } else {
    const r = ld.book.raise<string>({
      origin, code: "rir_text", kind: "semantic",
      problem: `RIR "${rirCell.text}" is not a number or a range.`,
      proposed_fix: "Store RIR as not recorded, keeping the text in the set's note.", proposal: "not_recorded", row: row.cells(["E", "H", "I"]),
    });
    if (!r.apply) return;
    input.rir = r.value;
  }
  const note = [row.text("P"), handReps?.note ?? "", perSide && !handReps ? `Reps in Sheets: ${row.text("H")}` : "", rirCell.kind === "unreadable" ? `RIR in Sheets: ${rirCell.text}` : rirCell.kind === "range" && rirCell.note ? `RIR in Sheets: ${rirCell.note}` : "", typeText && SET_TYPES[typeText] === undefined ? `Sheets set type: ${row.text("Q")}` : "", typeText === "accessory" ? "Sheets set type: accessory" : ""].filter(Boolean).join("; ");
  if (note) input.note = note;
  rd.flush();
  const typed = { total_kg: typedTotal, volume_kg: volume, e1rm_kg: e1rm, week: cellOrNull(row.raw("B")), phase: row.text("C") || null, muscle_group: row.text("F") || null, source: row.text("O") || null };
  const res = await ld.write("log_set", input, origin, { evidence: row, detail: { typed }, key: "log_set" });
  if (res) {
    ld.record(origin, { table: "session_set", id: (res.set as { id: number }).id, tool: "log_set" });
    return;
  }
  // A refused set ruled out, with its note kept on the prescription it was for.
  const refused = ld.book.get(`${originKey(origin)}/rejected_by_api/log_set`);
  const keep = (refused?.override as { member_note_on_prescription?: boolean } | null)?.member_note_on_prescription === true;
  if (!refused || refused.decision !== "rejected" || !keep) return;
  const session = ld.db.get<{ template_id: number | null; member: string; performed_on: string }>(
    "SELECT se.template_id, m.name AS member, se.performed_on FROM session se JOIN member m ON m.id = se.member_id WHERE se.id = ?", sessionId,
  );
  const prescriptionId = session ? replacedPrescription(ld, sessionId, exercise) : null;
  if (!session || prescriptionId === null) {
    ld.book.raise({ origin, code: "note_without_prescription", kind: "semantic", problem: `No prescription of ${exercise} to keep this left-out set's note on.`, proposed_fix: "Keep the note on the session instead, or drop it.", proposal: null, row: row.cells(["A", "D", "E", "P"]) });
    return;
  }
  const body = [`${session.performed_on}, ${row.text("D")}: set ${row.text("G")} of ${exercise} was left out of the import (no reps).`, row.text("P") ? `Note in Sheets: ${row.text("P")}` : ""].filter(Boolean).join("\n");
  await ld.write("write_member_note", { member: session.member, topic: "set left out of the import", body, subject: { table: "prescription", id: prescriptionId } }, origin, { key: "note" });
}

/**
 * The prescription an exercise name stands for in a session: in the
 * session's template first, else anywhere in the member's active programme.
 * Names match the exercise or any of its aliases, ignoring case.
 */
function replacedPrescription(ld: Loader, sessionId: number, name: string): number | null {
  const match = `(e.name = ?1 COLLATE NOCASE OR e.id IN (SELECT target_id FROM alias WHERE kind = 'exercise' AND alias = ?1 COLLATE NOCASE))`;
  const inTemplate = ld.db.get<{ id: number }>(
    `SELECT p.id FROM prescription p JOIN exercise e ON e.id = p.exercise_id JOIN session s ON s.template_id = p.template_id WHERE s.id = ?2 AND ${match} ORDER BY p.position LIMIT 1`,
    name, sessionId,
  );
  if (inTemplate) return inTemplate.id;
  // "Leg Press Machine" logged against the template's "Leg Press": one prescription whose name the set's contains, or the reverse.
  const contained = ld.db.all<{ id: number }>(
    `SELECT p.id FROM prescription p JOIN exercise e ON e.id = p.exercise_id JOIN session s ON s.template_id = p.template_id
     WHERE s.id = ?2 AND (instr(lower(?1), lower(e.name)) > 0 OR instr(lower(e.name), lower(?1)) > 0)`,
    name, sessionId,
  );
  if (contained.length === 1) return (contained[0] as { id: number }).id;
  const inProgramme = ld.db.get<{ id: number }>(
    `SELECT p.id FROM prescription p JOIN exercise e ON e.id = p.exercise_id JOIN session_template t ON t.id = p.template_id
     JOIN programme pr ON pr.id = t.programme_id JOIN session s ON s.member_id = pr.member_id WHERE s.id = ?2 AND pr.active = 1 AND ${match} ORDER BY t.id, p.position LIMIT 1`,
    name, sessionId,
  );
  return inProgramme?.id ?? null;
}

const cellOrNull = (c: Cell) => (c === "" ? null : c);

// ------------------------------------------------------------------ Cardio

export async function loadCardio(ld: Loader): Promise<void> {
  for (const file of Object.keys(PERSON_FILES)) {
    const member = ld.memberOfFile(file);
    if (!member) continue;
    const groups = new Map<string, { date: string; type: string; rows: Row[] }>();
    for (const row of ld.sheet(file, "Cardio")?.rows() ?? []) {
      let date: string | null = null;
      try {
        date = new RowReader(ld, row).date("A");
      } catch (error) {
        if (!(error instanceof ParseError)) throw error;
      }
      if (!date) {
        ld.book.raise({ origin: ld.origin(row), code: "unreadable_date", kind: "semantic", problem: `Date "${row.text("A")}" is not a date.`, proposed_fix: "Give the date, or leave the row out.", proposal: null, row: row.cells(["A", "D", "E", "F"]) });
        continue;
      }
      const type = row.text("D");
      const key = `${date}\u0000${type.toLowerCase()}`;
      const g = groups.get(key) ?? { date, type, rows: [] };
      g.rows.push(row);
      groups.set(key, g);
    }
    for (const g of groups.values()) await loadCardioSession(ld, member, g);
  }
}

async function loadCardioSession(ld: Loader, member: string, g: { date: string; type: string; rows: Row[] }): Promise<void> {
  const first = g.rows[0] as Row;
  const isClass = /dance|class/i.test(g.type);
  const blocks: Record<string, unknown>[] = [];
  const blockRows: Row[] = [];
  for (const row of g.rows) {
    const rd = new RowReader(ld, row);
    const origin = ld.origin(row);
    try {
      const label = `${g.type} ${row.text("E")}`;
      const block: Record<string, unknown> = {
        kind: /interval|anaerobic/i.test(label) ? "interval" : /warm/i.test(label) ? "warm_up" : /cool/i.test(label) ? "cool_down" : "steady",
        activity: isClass ? "dance" : g.type,
      };
      const minutes = rd.num("F");
      if (minutes !== null && minutes > 0) block.duration_s = Math.round(minutes * 60);
      const speed = rd.num("G");
      if (speed !== null) block.speed = { value: speed, unit: "km/h" };
      const incline = rd.num("H");
      if (incline !== null) block.incline_pct = incline;
      const km = rd.num("I");
      if (km !== null && km > 0) block.distance = { value: km, unit: "km" };
      for (const [col, key] of [["K", "avg_hr"], ["L", "max_hr"], ["Q", "recovery_hr"]] as const) {
        const v = rd.num(col);
        if (v === null) continue;
        if (Number.isInteger(v)) block[key] = v;
        else {
          const r = ld.book.raise<number>({ origin, code: "hr_not_integer", key: col, kind: "semantic", problem: `Heart rate ${v} is not a whole number of beats per minute.`, proposed_fix: `Round it to ${Math.round(v)}.`, proposal: Math.round(v), row: row.cells([col]) });
          if (r.apply) block[key] = r.value;
        }
      }
      const rpe = rd.num("M");
      if (rpe !== null) block.rpe = rpe;
      const conv = row.text("N").toLowerCase();
      if (conv === "yes") block.conversational = true;
      else if (conv === "no") block.conversational = false;
      const rounds = rd.num("P");
      if (rounds !== null) block.rounds = rounds;
      const note = [row.text("O"), conv && conv !== "yes" && conv !== "no" ? `Conversational: ${row.text("N")}` : "", row.text("J") ? `Pace in Sheets: ${row.rendered("J")}` : ""].filter(Boolean).join("; ");
      if (note) block.note = note;
      rd.flush();
      blocks.push(block);
      blockRows.push(row);
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      ld.book.raise({ origin, code: "unreadable_value", kind: "semantic", problem: error.message, proposed_fix: "Correct the block, or leave it out.", proposal: null, row: row.cells(["A", "D", "E", "F", "G", "H", "I", "K", "L"]) });
    }
  }
  if (blocks.length === 0) return;
  const origin = ld.origin(first);
  const res = await ld.write("log_cardio", { member, date: g.date, session_type: isClass ? "class" : "cardio", note: `Sheets type: ${g.type}`, blocks }, origin, { evidence: first, key: "log_cardio" });
  if (!res) return;
  ld.record(origin, { table: "session", id: (res.session as { id: number }).id, tool: "log_cardio" });
  for (const [i, b] of (res.blocks as { id: number }[]).entries()) {
    const row = blockRows[i];
    if (row) ld.record(ld.origin(row), { table: "cardio_block", id: b.id, tool: "log_cardio" });
  }
}

