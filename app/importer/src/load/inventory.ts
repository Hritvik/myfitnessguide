/**
 * The equipment inventory of each prescribed member's home gym (ticket 25),
 * from the Guide's gym notes, the Program's equipment remarks, the Log's
 * notes and what was actually lifted. Members with no programme (the
 * record-only and the not-started) get none.
 *
 * Every implement is a semantic `implement_inventory` ruling whose proposal
 * is the whole implement (name, kind, unit, loading, its loads each in its
 * native unit, loads known absent, its bar, whether the list is complete,
 * the prescriptions it carries), applied while pending: the notes are
 * prose, and only Hritvik can say the list is right. A decision may give
 * directives instead of a whole implement: `top: unknown` (the list's top
 * is not established) and `mixed_units` (each load in its own unit, which
 * every proposal already is).
 *
 * - Dumbbell racks, one per unit, from lists such as "kg rack runs
 *   6/8/10" or "the rack runs 5, 10 and 15 lb"; a list ending "..."
 *   has an unknown maximum; "12 kg dumbbells do not exist" records 12 kg
 *   as absent.
 * - Pre-weighted fixed bars, from the bars the notes name.
 * - One stack per prescribed machine or cable exercise: a stack that
 *   "steps in N kg" lists every multiple of N up to the heaviest such load
 *   seen; a measured stack ("(35, 41, 47)") lists those; and every load
 *   lifted on it, in its own unit. Loads a stepped stack can't make are
 *   named, not listed.
 * - Barbells and plate-loaded machines list no loads: theirs are the
 *   combinations of the gym's plates. A loadable barbell carries the bar
 *   the notes name; a sled is plates only (its weight unmarked).
 * - The gym's plates, per unit, are never all known: a denomination is
 *   confirmed when the notes say so ("N lb plates confirmed"), absent when
 *   they rule it out ("no 1.25 kg plate"), and inferred from each per-side
 *   load lifted on plate-loaded kit, as the fewest common plates that make
 *   it. Plates are data the importer reads mechanically and marks as
 *   unconfirmed, so they raise no ruling; the inventory_gaps tool asks.
 *
 * Inventories load after the Log, so imported sets keep no implement and
 * are never snapped: they are the record of what was lifted. A prescription
 * is linked to a listed implement when its load, read in its native unit,
 * is on the list, or above the known top of a list whose top is unknown
 * (in the same unit); to plate-loaded kit whenever its basis is per side.
 */
import { readNativeLoad, toKg, type LoadAmount } from "@myfitnessguide/domain";
import type { Row } from "../grid";
import { PERSON_FILES } from "../layout";
import type { Origin } from "../rulings";
import type { Loader } from "./context";
import { guessKind, programExercise } from "./training";

type Unit = "kg" | "lb";

interface Proposal {
  name: string;
  kind: string;
  unit: Unit;
  loading: "total" | "per_side" | "plates_only";
  loads: LoadAmount[];
  absent?: LoadAmount[];
  bar?: LoadAmount | null;
  load_list_complete: boolean;
  prescriptions: string[];
}

interface Text {
  origin: Origin;
  text: string;
  /** The exercise the cell is about (a Program or Log row), when it is one. */
  exercise: string | null;
}

const NUM = String.raw`\d+(?:\.\d+)?`;
const round2 = (x: number) => Math.round(x * 100) / 100;
const kgOf = (a: LoadAmount) => toKg(a.value, a.unit);
/** Amounts deduplicated (same unit and value) and ordered by weight. */
const tidy = (xs: LoadAmount[]): LoadAmount[] => {
  const seen = new Map<string, LoadAmount>();
  for (const x of xs) seen.set(`${round2(x.value)} ${x.unit}`, { value: round2(x.value), unit: x.unit });
  return [...seen.values()].sort((a, b) => kgOf(a) - kgOf(b) || (a.unit < b.unit ? -1 : 1));
};
const show = (xs: LoadAmount[]) => xs.map((x) => `${x.value} ${x.unit}`).join(", ");
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** Plate denominations a gym commonly has, per unit (the Worker's inventory_gaps asks about the same). */
const COMMON_PLATES: Record<Unit, number[]> = { kg: [1.25, 2.5, 5, 10, 15, 20, 25], lb: [2.5, 5, 10, 25, 35, 45] };
const PLATE_KINDS = new Set(["barbell", "plate_loaded"]);

function texts(ld: Loader, file: string): Text[] {
  const out: Text[] = [];
  const add = (row: Row, cols: string[], exercise: string | null) => {
    for (const c of cols) {
      const t = row.rendered(c).trim();
      if (t) out.push({ origin: ld.origin(row), text: t, exercise });
    }
  };
  for (const row of ld.sheet("base", "Guide")?.rows(1) ?? []) add(row, ["B", "C"], null);
  for (const row of ld.sheet(file, "Program")?.rows() ?? []) add(row, ["L", "M", "N", "O", "P"], programExercise(row.text("C")).name);
  for (const row of ld.sheet(file, "Log")?.rows() ?? []) add(row, ["P"], row.text("E"));
  for (const row of ld.sheet(file, "Agent Audit")?.rows() ?? []) add(row, ["F", "G", "H"], null);
  for (const row of ld.sheet(file, "Handover")?.rows(1) ?? []) add(row, ["B"], null);
  return out;
}

// ------------------------------------------------------------- dumbbells

function racks(all: Text[]): { unit: Unit; loads: LoadAmount[]; complete: boolean; origin: Origin; absent: LoadAmount[] }[] {
  const found = new Map<Unit, { loads: Set<number>; open: boolean; origin: Origin; removed: Set<number> }>();
  const at = (unit: Unit, origin: Origin) => {
    let r = found.get(unit);
    if (!r) found.set(unit, (r = { loads: new Set(), open: false, origin, removed: new Set() }));
    return r;
  };
  for (const t of all) {
    for (const m of t.text.matchAll(new RegExp(String.raw`\b(kg|lb) (?:dumbbells?|rack)(?: runs)?:? ((?:${NUM}/)+${NUM})(\.\.\.|…)?`, "gi"))) {
      const r = at((m[1] as string).toLowerCase() as Unit, t.origin);
      for (const v of (m[2] as string).split("/")) r.loads.add(Number(v));
      if (m[3]) r.open = true;
    }
    for (const m of t.text.matchAll(new RegExp(String.raw`\brack runs ((?:${NUM},?\s+)+(?:and\s+)?${NUM})\s*(kg|lb)\b`, "gi"))) {
      const r = at((m[2] as string).toLowerCase() as Unit, t.origin);
      for (const v of (m[1] as string).match(new RegExp(NUM, "g")) ?? []) r.loads.add(Number(v));
    }
  }
  for (const t of all) {
    for (const m of t.text.matchAll(new RegExp(String.raw`\b(${NUM}) ?(kg|lb) dumbbells? (?:do(?:es)? not|don't) exist`, "gi"))) {
      found.get((m[2] as string).toLowerCase() as Unit)?.removed.add(Number(m[1]));
    }
  }
  return (["kg", "lb"] as Unit[]).flatMap((unit) => {
    const r = found.get(unit);
    if (!r) return [];
    const loads = tidy([...r.loads].filter((l) => !r.removed.has(l)).map((value) => ({ value, unit })));
    return loads.length ? [{ unit, loads, complete: !r.open, origin: r.origin, absent: tidy([...r.removed].map((value) => ({ value, unit }))) }] : [];
  });
}

// ---------------------------------------------------------- bars, plates

/** A loadable barbell, when the notes describe one: the bar they name. */
function barbell(all: Text[]): { bar: LoadAmount | null; origin: Origin } | null {
  const loadable = all.find((t) => /plates are (?:in )?pounds/i.test(t.text)) ?? all.find((t) => /\bloadable\b/i.test(t.text));
  if (!loadable) return null;
  const named = all.map((t) => new RegExp(String.raw`\b(${NUM}) ?kg (?:Olympic|bar\b)`, "i").exec(t.text)).find((m) => m !== null);
  return { bar: named ? { value: Number(named[1]), unit: "kg" } : null, origin: loadable.origin };
}

function fixedBars(all: Text[]): { loads: LoadAmount[]; origin: Origin } | null {
  const loads: number[] = [];
  let origin: Origin | null = null;
  const patterns = [
    new RegExp(String.raw`rack goes (${NUM}) ?kg then (${NUM}) ?kg`, "gi"),
    new RegExp(String.raw`(?:fixed|pre-weighted)[^.;]{0,30}?\b(${NUM}) ?kg bar`, "gi"),
    new RegExp(String.raw`bar marked at (${NUM}) ?kg`, "gi"),
    new RegExp(String.raw`(${NUM}) \(fixed marked bar\)`, "gi"),
  ];
  for (const t of all) {
    for (const re of patterns) {
      for (const m of t.text.matchAll(re)) {
        loads.push(...m.slice(1).filter(Boolean).map(Number));
        origin ??= t.origin;
      }
    }
  }
  return origin && loads.length ? { loads: tidy(loads.map((value) => ({ value, unit: "kg" as Unit }))), origin } : null;
}

/** The fewest common plates of one unit that make a per-side amount; null when none do. */
function fewestPlates(amount: number, unit: Unit, absent: Set<number>): number[] | null {
  const plates = COMMON_PLATES[unit].filter((p) => !absent.has(p)).sort((a, b) => b - a);
  const q = (x: number) => Math.round(x * 4);
  const target = q(amount);
  if (Math.abs(amount * 4 - target) > 1e-6) return null;
  const best: (number[] | null)[] = new Array(target + 1).fill(null);
  best[0] = [];
  for (let i = 1; i <= target; i++) {
    for (const p of plates) {
      const prev = i - q(p) >= 0 ? best[i - q(p)] : null;
      if (prev && (best[i] === null || prev.length + 1 < (best[i] as number[]).length)) best[i] = [...prev, p];
    }
  }
  return best[target] ?? null;
}

/**
 * The gym's plates per unit: confirmed and absent from the notes, inferred
 * from the per-side loads lifted on barbells and plate-loaded machines.
 */
function plateSets(ld: Loader, member: string, all: Text[]): { unit: Unit; plates: { value: number; status: "confirmed" | "inferred" | "absent" }[] }[] {
  const status = new Map<string, "confirmed" | "inferred" | "absent">();
  const units = new Set<Unit>();
  const key = (unit: Unit, v: number) => `${unit} ${round2(v)}`;
  for (const t of all) {
    for (const m of t.text.matchAll(new RegExp(String.raw`\bno (${NUM}) ?(kg|lb) plates?\b`, "gi"))) {
      const unit = (m[2] as string).toLowerCase() as Unit;
      status.set(key(unit, Number(m[1])), "absent");
      units.add(unit);
    }
    for (const m of t.text.matchAll(new RegExp(String.raw`\b(${NUM}) ?(kg|lb) plates?[^.]{0,30}?\b(?:confirmed|available)`, "gi"))) {
      const unit = (m[2] as string).toLowerCase() as Unit;
      if (!status.has(key(unit, Number(m[1])))) status.set(key(unit, Number(m[1])), "confirmed");
      units.add(unit);
    }
    if (/plates are (?:in )?pounds/i.test(t.text)) units.add("lb");
  }
  const sets = ld.db.all<{ value: number | null; unit: Unit | null; plates: string | null }>(
    `SELECT v.load_value AS value, v.load_unit AS unit, v.plates FROM v_set v JOIN member m ON m.id = v.member_id
     WHERE m.name = ? AND v.load_status = 'entered' AND v.load_basis = 'per_side' AND v.implement_kind IN ('barbell', 'plate_loaded')`,
    member,
  );
  const amounts: LoadAmount[] = [];
  for (const s of sets) {
    if (s.plates) {
      const byUnit = new Map<Unit, number>();
      for (const p of JSON.parse(s.plates) as { value: number; unit: Unit; count?: number }[]) byUnit.set(p.unit, (byUnit.get(p.unit) ?? 0) + p.value * (p.count ?? 1));
      for (const [unit, value] of byUnit) amounts.push({ value, unit });
    } else if (s.value !== null && s.unit !== null && s.value > 0) amounts.push({ value: s.value, unit: s.unit });
  }
  for (const a of tidy(amounts)) {
    const absent = new Set([...status.entries()].filter(([k, v]) => v === "absent" && k.startsWith(`${a.unit} `)).map(([k]) => Number(k.split(" ")[1])));
    for (const p of fewestPlates(a.value, a.unit, absent) ?? []) {
      units.add(a.unit);
      if (!status.has(key(a.unit, p))) status.set(key(a.unit, p), "inferred");
    }
  }
  return (["kg", "lb"] as Unit[])
    .filter((u) => units.has(u))
    .map((unit) => ({
      unit,
      plates: [...status.entries()]
        .filter(([k]) => k.startsWith(`${unit} `))
        .map(([k, s]) => ({ value: Number(k.split(" ")[1]), status: s }))
        .sort((a, b) => a.value - b.value),
    }));
}

// ------------------------------------------------------------- machines

const STACKED = new Set(["machine", "cable", "plate_loaded"]);

interface Lifted {
  value: number;
  unit: Unit;
  basis: string;
  plates: string | null;
}

function liftedLoads(ld: Loader, member: string, exercise: string): Lifted[] {
  return ld.db.all<Lifted>(
    `SELECT v.load_value AS value, v.load_unit AS unit, v.load_basis AS basis, v.plates FROM v_set v JOIN member m ON m.id = v.member_id
     WHERE m.name = ? AND v.exercise_name = ? COLLATE NOCASE AND v.load_status = 'entered'`,
    member, exercise,
  );
}

function machine(ld: Loader, member: string, exercise: string, kind: string, own: Text[], row: Row, prescribed: LoadAmount & { basis: string } | null): { proposal: Proposal; excluded: LoadAmount[]; lifted: LoadAmount[]; origin: Origin } | null {
  const plates = kind === "plate_loaded";
  const all = liftedLoads(ld, member, exercise);
  // A cable worked one side per stack (a cable fly) lists one stack's loads, per side.
  const basis = plates || (all.some((l) => l.basis === "per_side") && !all.some((l) => l.basis === "total")) ? "per_side" : "total";
  const lifted = all.filter((l) => l.basis === basis && l.plates === null).map((l) => ({ value: l.value, unit: l.unit }));
  const label = kind === "cable" ? "cable stack" : plates ? "plates per side" : "machine stack";
  if (plates) {
    // A sled's loads are combinations of the gym's plates; its own weight is unmarked.
    return {
      proposal: { name: `${exercise} (${label})`, kind, unit: "kg", loading: "plates_only", loads: [], absent: [], bar: null, load_list_complete: false, prescriptions: [exercise] },
      excluded: [], lifted: tidy(lifted), origin: ld.origin(row),
    };
  }
  const named = own.flatMap((t) =>
    [
      new RegExp(String.raw`(?<!add )(?<!add the )(${NUM}) ?lb ?(?:/|per )\s?side`, "gi"),
      new RegExp(String.raw`\((${NUM}) ?lb\b`, "gi"),
      new RegExp(String.raw`(${NUM}) ?-> ?(${NUM}) ?lb`, "gi"),
      new RegExp(String.raw`\bat (${NUM}) ?lb`, "gi"),
    ].flatMap((re) => [...t.text.matchAll(re)].flatMap((m) => m.slice(1).filter(Boolean).map((v) => ({ value: Number(v), unit: "lb" as Unit })))),
  );
  const measured = own.flatMap((t) => [...t.text.matchAll(/stack measured[^(]*\(([\d.,\s]+)\)/gi)].flatMap((m) => ((m[1] as string).match(/\d+(?:\.\d+)?/g) ?? []).map((v) => ({ value: Number(v), unit: "kg" as Unit }))));
  const step = own.flatMap((t) => [...t.text.matchAll(/steps in (\d+(?:\.\d+)?) ?kg/gi)].map((m) => Number(m[1])))[0];
  const known = [...lifted, ...measured];
  const lbCount = known.filter((l) => l.unit === "lb").length;
  const unit: Unit = lbCount * 2 > known.length ? "lb" : "kg";
  let loads = tidy([...known, ...(unit === "lb" ? named : [])]);
  const excluded: LoadAmount[] = [];
  if (step) {
    const onStep = (l: LoadAmount) => l.unit === "kg" && Math.abs(l.value / step - Math.round(l.value / step)) < 1e-6;
    excluded.push(...loads.filter((l) => !onStep(l)));
    const candidates = [...loads.filter(onStep), ...(prescribed && prescribed.basis === basis && onStep(prescribed) ? [prescribed] : [])];
    const top = Math.max(step, ...candidates.map((l) => l.value));
    loads = [];
    for (let l = step; l <= top + 1e-9; l += step) loads.push({ value: round2(l), unit: "kg" });
  }
  if (loads.length === 0) return null;
  return {
    proposal: { name: `${exercise} (${label})`, kind, unit, loading: basis === "per_side" ? "per_side" : "total", loads, absent: [], bar: null, load_list_complete: false, prescriptions: [exercise] },
    excluded: tidy(excluded), lifted: tidy(lifted), origin: ld.origin(row),
  };
}

// ---------------------------------------------------------------- stage

interface PrescriptionRow {
  id: number;
  exercise: string;
  kind: string;
  value: number | null;
  unit: Unit | null;
  basis: string | null;
}

/** A prescription's load read in its native unit (9.07 kg is 20 lb), else as typed. */
function nativeLoad(p: PrescriptionRow): LoadAmount | null {
  if (p.value === null || p.unit === null) return null;
  const r = readNativeLoad(p.value, p.unit);
  return r.status === "clean" ? { value: r.value, unit: r.unit } : { value: p.value, unit: p.unit };
}

export async function loadInventory(ld: Loader): Promise<void> {
  for (const file of Object.keys(PERSON_FILES)) {
    const member = ld.memberOfFile(file);
    const programmeId = member ? (ld.facts.get(`programme:${member}`) as number | undefined) : undefined;
    if (!member || programmeId === undefined) continue;
    const gym = ld.db.get<{ name: string }>("SELECT g.name FROM gym g JOIN member m ON m.home_gym_id = g.id WHERE m.name = ?", member)?.name;
    if (!gym) continue;
    const all = texts(ld, file);
    const prescriptions = ld.db.all<PrescriptionRow>(
      `SELECT v.id, v.exercise_name AS exercise, e.implement_kind AS kind, v.current_load_value AS value, v.current_load_unit AS unit, v.current_load_basis AS basis
       FROM v_prescription v JOIN exercise e ON e.id = v.exercise_id JOIN session_template t ON t.id = v.template_id WHERE t.programme_id = ? ORDER BY v.template_id, v.position`,
      programmeId,
    );
    const planned: { proposal: Proposal; origin: Origin; notes: string[]; key?: string }[] = [];
    for (const r of racks(all)) {
      planned.push({
        proposal: { name: `Dumbbells (${r.unit})`, kind: "dumbbell", unit: r.unit, loading: "total", loads: r.loads, absent: r.absent, bar: null, load_list_complete: r.complete, prescriptions: prescriptions.filter((p) => p.kind === "dumbbell").map((p) => p.exercise) },
        origin: r.origin,
        notes: [r.complete ? "The list is closed (no trailing \"...\"); the lightest dumbbell is not established." : "The list ends \"...\": heavier ones may exist.", ...(r.absent.length ? [`Named as not existing: ${show(r.absent)}.`] : [])],
      });
    }
    const barbellLifts = prescriptions.filter((p) => p.kind === "barbell").map((p) => p.exercise);
    const bar = barbell(all);
    if (bar) {
      planned.push({
        // The ruling keeps the key it was decided under when the barbell was a list of pound plates per side.
        key: "barbell_lb_plates_per_side",
        proposal: { name: "Loadable barbell", kind: "barbell", unit: "kg", loading: "per_side", loads: [], absent: [], bar: bar.bar, load_list_complete: false, prescriptions: barbellLifts },
        origin: bar.origin,
        notes: [`Loaded with the gym's plates, kg and lb mixed; ${bar.bar ? `the bar is ${bar.bar.value} ${bar.bar.unit}` : "the bar's weight is not named"}.`],
      });
    }
    const fixed = fixedBars(all);
    if (fixed) planned.push({ proposal: { name: "Fixed bars", kind: "fixed_bar", unit: "kg", loading: "total", loads: fixed.loads, absent: [], bar: null, load_list_complete: false, prescriptions: [] }, origin: fixed.origin, notes: ["The bars the notes name; the top of the rack is not established."] });
    const seen = new Set<string>();
    for (const row of ld.sheet(file, "Program")?.rows() ?? []) {
      const exercise = programExercise(row.text("C")).name;
      const p = prescriptions.find((x) => x.exercise.toLowerCase() === exercise.toLowerCase());
      const kind = p?.kind ?? guessKind(exercise);
      if (!kind || !STACKED.has(kind) || seen.has(exercise.toLowerCase())) continue;
      seen.add(exercise.toLowerCase());
      const own = all.filter((t) => t.exercise?.toLowerCase() === exercise.toLowerCase());
      const load = p ? nativeLoad(p) : null;
      const m = machine(ld, member, exercise, kind, own, row, load && p?.basis ? { ...load, basis: p.basis } : null);
      if (m) {
        planned.push({
          proposal: m.proposal, origin: m.origin,
          notes: m.proposal.loading === "plates_only"
            ? [`Loaded with the gym's plates; the sled is unmarked. Per-side loads lifted: ${show(m.lifted) || "none single-unit"}.`]
            : [m.excluded.length ? `Loads this stack can't make, left off the list: ${show(m.excluded)}.` : "", "Every load lifted on it is listed, each in its own unit; heavier ones may exist."].filter(Boolean),
        });
      }
    }
    for (const plan of planned) await applyImplement(ld, gym, plan.proposal, plan.origin, plan.notes, prescriptions, plan.key);
    if (planned.some((p) => PLATE_KINDS.has(p.proposal.kind) && p.proposal.loading !== "total")) {
      const origin = planned.find((p) => PLATE_KINDS.has(p.proposal.kind))?.origin as Origin;
      for (const set of plateSets(ld, member, all)) {
        await ld.write("create_plate_set", {
          gym, unit: set.unit, complete: false, plates: set.plates,
          note: "Read at import: confirmed and absent from the notes, inferred from the per-side loads lifted (the fewest common plates that make each). Not every denomination is known.",
        }, origin, { key: `plate_set_${set.unit}` });
      }
    }
  }
}

const fits = (loading: string, basis: string) => (loading === "total" ? basis !== "per_side" : basis === "per_side");

/** A decision's directives (`top`, `mixed_units`) applied to the proposal, or the decided implement itself. */
function decided(proposal: Proposal, value: unknown): Proposal {
  if (value === null || typeof value !== "object" || "name" in value) return value as Proposal;
  const d = value as { top?: unknown; mixed_units?: unknown };
  const out = { ...proposal };
  if (typeof d.top === "string" && /unknown/i.test(d.top)) out.load_list_complete = false;
  return out;
}

async function applyImplement(ld: Loader, gym: string, proposal: Proposal, origin: Origin, notes: string[], prescriptions: PrescriptionRow[], key?: string): Promise<void> {
  const plateKit = (x: Proposal) => PLATE_KINDS.has(x.kind) && x.loading !== "total";
  const onList = (p: PrescriptionRow, x: Proposal) => {
    const load = nativeLoad(p);
    if (!load || p.basis === null || !fits(x.loading, p.basis)) return false;
    if (plateKit(x)) return true;
    const loads = x.loads.map((l) => (typeof l === "number" ? { value: l, unit: x.unit } : l));
    if (loads.some((l) => Math.abs(kgOf(l) - kgOf(load)) < 1e-6)) return true;
    // Above the known top of a list whose top is unknown, in the list's unit: it may exist (unverified).
    const top = loads.at(-1);
    return !x.load_list_complete && top !== undefined && load.unit === top.unit && kgOf(load) > kgOf(top);
  };
  const named = prescriptions.filter((p) => proposal.prescriptions.some((n) => n.toLowerCase() === p.exercise.toLowerCase()));
  const off = named.filter((p) => p.value !== null && !onList(p, proposal)).map((p) => `${p.exercise} (${p.value} ${p.unit} ${p.basis})`);
  const listed = plateKit(proposal) ? "loads from the gym's plates" : `${show(proposal.loads)}${proposal.load_list_complete ? "" : ", maximum unknown"}`;
  const r = ld.book.raise<unknown>({
    origin, code: "implement_inventory", key: key ?? slug(proposal.name), kind: "semantic",
    problem: [`${proposal.name} at ${gym}, read from the notes and the loads lifted: ${listed}.`, ...notes, off.length ? `Prescriptions whose load is not on the list stay unlinked: ${off.join("; ")}.` : ""].filter(Boolean).join(" "),
    proposed_fix: "Check the list against the gym and correct it as override (loads, load_list_complete), or reject to leave the implement out.",
    proposal,
  });
  if (!r.apply) return;
  const x = decided(proposal, r.value);
  const link = prescriptions.filter((p) => x.prescriptions.some((n) => n.toLowerCase() === p.exercise.toLowerCase()) && onList(p, x)).map((p) => p.id);
  await ld.write("create_implement", {
    gym, name: x.name, kind: x.kind, unit: x.unit, loading: x.loading, loads: x.loads, ...(x.absent?.length ? { absent: x.absent } : {}), ...(x.bar ? { bar: x.bar } : {}),
    load_list_complete: x.load_list_complete,
    ...(notes.length ? { note: notes.join(" ") } : {}), ...(link.length ? { link_prescriptions: link } : {}),
  }, origin, { key: `implement_${slug(x.name)}` });
}
