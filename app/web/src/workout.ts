/**
 * The Workout tab (spec §5): the next programme session or a saved
 * workout, adjusted block by block, saved with log_workout in one write.
 * Rows carry the planned load; reps and RIR start empty so nothing planned
 * is logged as done. A saved workout's changed lines ask once whether to
 * keep them; a programme session never asks.
 */
import { loadText, plainReason, plural, qty } from "./format";
import { loadInput, parseRir, plannedLoad, type LoadDraft } from "./setEntry";
import type { LogWorkout, NextForEntry, NextLoad, PrescribedLoad, WorkoutLineOut, WorkoutOut } from "./types";
import { planStep, type Plan } from "./writes";
import { typedNumber } from "./typed";

export type Source = { kind: "programme"; template: string } | { kind: "workout"; id: number; name: string } | { kind: "none" };
export type TargetKind = "reps" | "duration" | "distance";
export type DistUnit = "m" | "km" | "mi";
export interface RowDraft {
  /** A stable id, so focus and feedback follow the row when another is removed. */
  id: string;
  setType: "working" | "warm_up" | "back_off";
  /** What this set is counted in: reps, seconds held, or distance carried. */
  kind: TargetKind;
  reps: string;
  secs: string;
  dist: string;
  distUnit: DistUnit;
  rir: string;
  load: LoadDraft;
}
export interface Block {
  key: string;
  exercise: string;
  prescriptionId: number | null;
  substitutes: number | null;
  lineId: number | null;
  target: string | null;
  rows: RowDraft[];
}

let seq = 0;
const key = () => `b${++seq}`;
let rseq = 0;
const unitOf = (u: string | null): DistUnit => (u === "km" || u === "mi" ? u : "m");

/** A planned load as a row starts (setEntry's `plannedLoad`): a timed or measured line with none planned starts with no load (decision 94). */
const loadDraftOf = (l: PrescribedLoad | WorkoutLineOut["load"] | null, kind: TargetKind = "reps"): LoadDraft => plannedLoad(l, kind);

const range = (low: number | null, high: number | null) => (low === null ? null : low === high || high === null ? qty(low) : `${qty(low)}-${qty(high)}`);
const rowsOf = (n: number, setType: RowDraft["setType"], load: LoadDraft, kind: TargetKind = "reps", distUnit: DistUnit = "m"): RowDraft[] =>
  Array.from({ length: Math.max(1, n) }, () => ({ id: `r${++rseq}`, setType, kind, reps: "", secs: "", dist: "", distUnit, rir: "", load }));

export function fromNext(next: NextForEntry): { source: Source; blocks: Block[] } | null {
  if (next.programming_mode !== "prescribed" || !next.session || !next.prescriptions) return null;
  return {
    source: { kind: "programme", template: next.session },
    blocks: next.prescriptions.map((p) => {
      const t = p.target;
      const rir = p.rir_target ? range(p.rir_target.low, p.rir_target.high) : null;
      const reps = t.kind === "reps" ? range(t.low, t.high) : null;
      const secs = t.kind === "duration" ? range(t.low_s, t.high_s) : null;
      const text = reps ? `${reps} reps${rir ? ` at RIR ${rir}` : ""}` : secs ? `${secs} s` : t.kind === "distance" && t.value !== null ? `${qty(t.value)} ${t.unit ?? ""}`.trim() : null;
      return { key: key(), exercise: p.exercise, prescriptionId: p.prescription_id, substitutes: null, lineId: null, target: text, rows: rowsOf(p.sets ?? 1, "working", loadDraftOf(p.load, t.kind), t.kind, unitOf(t.kind === "distance" ? t.unit : null)) };
    }),
  };
}

export function fromWorkout(w: WorkoutOut): { source: Source; blocks: Block[] } {
  return {
    source: { kind: "workout", id: w.id, name: w.name },
    blocks: w.lines.map((l) => ({
      key: key(), exercise: l.exercise, prescriptionId: null, substitutes: null, lineId: l.id,
      target: l.target.kind === "reps" ? `${range(l.target.low, l.target.high)} reps${l.rir ? ` at RIR ${range(l.rir.low, l.rir.high)}` : ""}` : l.target.kind === "duration" ? `${qty(l.target.seconds)} s` : `${qty(l.target.value)} ${l.target.unit}`,
      rows: rowsOf(l.sets, l.set_type === "warm_up" || l.set_type === "back_off" ? l.set_type : "working", loadDraftOf(l.load, l.target.kind), l.target.kind, unitOf(l.target.kind === "distance" ? l.target.unit : null)),
    })),
  };
}

export function newBlock(exercise: string, kind: TargetKind = "reps"): Block {
  return { key: key(), exercise, prescriptionId: null, substitutes: null, lineId: null, target: null, rows: rowsOf(1, "working", loadDraftOf(null, kind), kind) };
}

export function addRow(b: Block): Block {
  const last = b.rows.at(-1);
  return { ...b, rows: [...b.rows, { id: `r${++rseq}`, setType: last?.setType ?? "working", kind: last?.kind ?? "reps", reps: "", secs: "", dist: "", distUnit: last?.distUnit ?? "m", rir: "", load: last?.load ?? loadDraftOf(null) }] };
}

export function removeRow(b: Block, i: number): Block {
  return { ...b, rows: b.rows.filter((_, j) => j !== i) };
}

/** Another exercise in a block's place: for a programme block, a substitution of its prescription. */
export function swap(b: Block, exercise: string): Block {
  return { ...b, exercise, substitutes: b.prescriptionId ?? b.substitutes, prescriptionId: null, lineId: b.lineId === null ? null : -Math.abs(b.lineId) };
}

export function workoutInput(member: string, date: string, source: Source, blocks: Block[], mode: "prescribed" | "record_only"): { input: Record<string, unknown> } | { error: string } {
  const sets: Record<string, unknown>[] = [];
  for (const b of blocks) {
    for (const [i, r] of b.rows.entries()) {
      const at = `${b.exercise}, set ${i + 1}`;
      const reps = typedNumber(r.reps);
      const secs = typedNumber(r.secs);
      const dist = typedNumber(r.dist);
      if (r.kind === "reps" && (!r.reps.trim() || !Number.isInteger(reps) || reps < 0 || reps > 200)) return { error: `${at}: enter the reps.` };
      if (r.kind === "duration" && (!r.secs.trim() || !Number.isInteger(secs) || secs <= 0)) return { error: `${at}: enter the seconds.` };
      if (r.kind === "distance" && (!r.dist.trim() || !Number.isFinite(dist) || dist <= 0)) return { error: `${at}: enter the distance.` };
      const rir = parseRir(r.rir);
      if (rir === "bad") return { error: `${at}: enter the reps in reserve as a number, or a range like 1-2.` };
      // Reps in reserve belongs to counted reps; a hold or a carry is timed or measured.
      if (rir === null && mode === "prescribed" && r.setType === "working" && r.kind === "reps") return { error: `${at}: enter the reps in reserve.` };
      // The Worker asks for a load on every set ("none" for bodyweight, "not_recorded" if never captured), so a blank load is an error, never a default.
      const load = r.load.kind === "value" && !r.load.value.trim() ? { error: "Give a load, or choose Bodyweight / Not recorded." } : loadInput(r.load);
      if ("error" in load) return { error: `${at}: ${load.error.charAt(0).toLowerCase()}${load.error.slice(1)}` };
      const substitution = b.substitutes !== null && r.setType === "working";
      sets.push({
        exercise: b.exercise,
        set_type: substitution ? "substitution" : r.setType,
        ...(substitution ? { substituted_prescription_id: b.substitutes } : {}),
        ...(r.kind === "reps" ? { reps } : r.kind === "duration" ? { duration_s: secs } : { distance: { value: dist, unit: r.distUnit } }),
        ...(rir ? { rir } : {}),
        load: load.load,
      });
    }
  }
  if (sets.length === 0) return { error: "Add a set." };
  const src = source.kind === "programme" ? { kind: "programme", template: source.template } : source.kind === "workout" ? { kind: "workout", workout: source.id } : { kind: "none" };
  return { input: { member, date, source: src, sets } };
}

export interface LineChanges {
  remove: number[];
  add: Record<string, unknown>[];
  amend: { lineId: number; changes: Record<string, unknown> }[];
}

const repsOk = (v: number) => Number.isInteger(v) && v >= 0 && v <= 200;

/**
 * The line target the member logged for some rows: the reps range (working
 * sets, else all), the one duration or distance when every row agrees; null
 * when nothing is entered (or they disagree). Never a default.
 */
function targetOf(rows: RowDraft[]): Record<string, unknown> | null {
  const kind = rows[0]?.kind ?? "reps";
  const same = rows.filter((r) => r.kind === kind);
  if (kind === "duration") {
    const v = [...new Set(same.map((r) => typedNumber(r.secs)))];
    return same.every((r) => r.secs.trim()) && v.length === 1 && Number.isInteger(v[0]) && (v[0] as number) > 0 ? { duration_s: v[0] } : null;
  }
  if (kind === "distance") {
    const v = [...new Set(same.map((r) => `${r.dist.trim()}|${r.distUnit}`))];
    const [value, unit] = (v[0] ?? "|").split("|");
    return same.every((r) => r.dist.trim()) && v.length === 1 && Number.isFinite(typedNumber(value ?? "")) && typedNumber(value ?? "") > 0 ? { distance: { value: typedNumber(value ?? ""), unit } } : null;
  }
  const of = (rs: RowDraft[]) => rs.map((r) => typedNumber(r.reps)).filter(repsOk);
  const working = of(same.filter((r) => r.setType === "working"));
  const reps = working.length > 0 ? working : of(same);
  return reps.length > 0 ? { reps: { low: Math.min(...reps), high: Math.max(...reps) } } : null;
}

const hasTarget = (l: Record<string, unknown>) => "reps" in l || "duration_s" in l || "distance" in l;

/** A saved line's own target, in the shape add_workout_line takes, when it is of the kind the block is counted in. */
function lineTarget(line: WorkoutLineOut, kind: TargetKind): Record<string, unknown> | null {
  const t = line.target;
  if (t.kind !== kind) return null;
  return t.kind === "reps" ? { reps: { low: t.low, high: t.high } } : t.kind === "duration" ? { duration_s: t.seconds } : { distance: { value: t.value, unit: t.unit } };
}

/**
 * What changed against the saved workout; null when nothing did. An added
 * exercise carries the reps range the member logged for it, and none when
 * they logged none: nothing is guessed, and workoutPlan asks. A swapped
 * line, with no reps logged, keeps the target of the line it replaces.
 */
export function workoutChanges(w: WorkoutOut, blocks: Block[]): LineChanges | null {
  const out: LineChanges = { remove: [], add: [], amend: [] };
  const shown = blocks.filter((b) => b.rows.length > 0);
  for (const line of w.lines) {
    const kept = shown.find((b) => b.lineId === line.id);
    const swapped = shown.find((b) => b.lineId === -line.id);
    if (swapped) {
      const target = targetOf(swapped.rows) ?? lineTarget(line, swapped.rows[0]?.kind ?? "reps");
      out.remove.push(line.id);
      out.add.push({ exercise: swapped.exercise, sets: swapped.rows.length, ...(target ?? {}), position: line.position });
    } else if (!kept) out.remove.push(line.id);
    else if (kept.rows.length !== line.sets) out.amend.push({ lineId: line.id, changes: { sets: kept.rows.length } });
  }
  for (const b of shown.filter((x) => x.lineId === null)) {
    out.add.push({ exercise: b.exercise, sets: b.rows.length, ...(targetOf(b.rows) ?? {}) });
  }
  return out.remove.length + out.add.length + out.amend.length > 0 ? out : null;
}

export function asksToKeep(source: Source, changes: LineChanges | null): boolean {
  return source.kind === "workout" && changes !== null;
}

export function workoutPlan(input: Record<string, unknown>, keep: "once" | "update" | "new", w: WorkoutOut | null, changes: LineChanges | null, blocks: Block[], newName?: string): Plan | { error: string } {
  const log = planStep("log_workout", input);
  if (keep === "once" || !w || !changes) return { steps: [log], done: "Logged." };
  const reason = `Changed when logging on ${String(input.date)}`;
  if (keep === "new") {
    if (!newName?.trim()) return { error: "Name the new workout." };
    const lines: Record<string, unknown>[] = [];
    for (const b of blocks.filter((x) => x.rows.length > 0)) {
      // One line per run of consecutive sets of one type, so warm-ups never count as working sets.
      for (const run of runs(b.rows)) {
        const target = targetOf(run);
        if (!target) return { error: `${b.exercise}: enter the ${run[0]?.kind === "duration" ? "seconds" : run[0]?.kind === "distance" ? "distance" : "reps"} to save it in the workout.` };
        // A default load only when every set in the run had the same one: never a guessed one.
        const loads = run.map((r) => loadInput(r.load));
        const first = loads[0];
        const agree = first !== undefined && "load" in first && loads.every((l) => "load" in l && JSON.stringify(l.load) === JSON.stringify(first.load));
        lines.push({ exercise: b.exercise, set_type: run[0]?.setType ?? "working", sets: run.length, ...target, ...(agree && first && "load" in first ? { load: first.load } : {}) });
      }
    }
    return { steps: [log, planStep("create_workout", { name: newName.trim(), lines, reason })], done: `Logged, and saved as ${newName.trim()}.` };
  }
  const unasked = changes.add.find((l) => !hasTarget(l));
  if (unasked) return { error: `${String(unasked.exercise)}: enter the reps, seconds or distance to save it in the workout.` };
  // Adds first: a workout keeps at least one line, so removing the last before its replacement lands would stop the plan after the session was saved.
  // add_workout_line at a position moves later lines down and remove_workout_line renumbers nothing, so each swap
  // is added at its old line's current position (tracked below) and the old line is removed afterwards.
  const at = new Map(w.lines.map((l) => [l.id, l.position]));
  const adds = changes.add.map((l) => {
    const { position, ...line } = l as Record<string, unknown> & { position?: number };
    if (position === undefined) return planStep("add_workout_line", { workout: w.id, line, reason });
    const old = w.lines.find((x) => x.position === position);
    const here = old ? (at.get(old.id) ?? position) : position;
    for (const [id, pos] of at) if (pos >= here) at.set(id, pos + 1);
    return planStep("add_workout_line", { workout: w.id, line, position: here, reason });
  });
  const steps = [
    log,
    ...adds,
    ...changes.remove.map((id) => planStep("remove_workout_line", { line_id: id, reason })),
    ...changes.amend.map((a) => planStep("amend", { record: { table: "workout_line", id: a.lineId }, changes: a.changes, reason })),
  ];
  return { steps, done: `Logged, and ${w.name} is updated for everyone.` };
}

/** Consecutive rows of one set type. */
function runs(rows: RowDraft[]): RowDraft[][] {
  const out: RowDraft[][] = [];
  for (const r of rows) {
    const last = out.at(-1);
    if (last && last[0]?.setType === r.setType) last.push(r);
    else out.push([r]);
  }
  return out;
}

/** A next load, worded by the one load formatter (format.ts). */
const nextText = (l: NextLoad | null) => (l ? loadText({ value: l.value, unit: l.unit, basis: null, bar: null, plates: l.plates }) : null);

/** Each linked lift's state, in words, from log_workout. */
export function progressLines(result: LogWorkout): string[] {
  return result.progression.map((p) => {
    const s = p.state;
    switch (s.kind) {
      case "ready":
        return `${p.exercise}: ready${nextText(s.next_load) ? `, ${nextText(s.next_load)} next time` : ""}.`;
      case "needs_confirmation":
        return `${p.exercise}: confirm the reps first, then ${nextText(s.next_load) ?? "the next load"}.`;
      case "check_at_gym":
        return `${p.exercise}: check at the gym. ${s.question}`;
      case "holding":
        return `${p.exercise}: holding (${plainReason(s.reason)}).`;
      case "cant_move":
        return `${p.exercise}: can't move (${plainReason(s.reason)}).`;
    }
  });
}

interface LoggedSetOut {
  set?: { exercise?: string; set_number?: number; state?: string; implement?: string | null };
  snap?: { status: string; value: number; unit: string } | null;
}

/** "sets 1-4", "sets 1, 3", "set 2". */
function setNumbers(ns: number[]): string {
  const sorted = [...ns].sort((a, b) => a - b);
  if (sorted.length === 1) return `set ${sorted[0]}`;
  const run = sorted.every((v, i) => i === 0 || v === (sorted[i - 1] as number) + 1);
  return `sets ${run ? `${sorted[0]}-${sorted.at(-1)}` : sorted.join(", ")}`;
}

/**
 * The sets log_workout stored as drafts, in words (click test P1-5): which
 * exercise's sets, and why when the API says (a load not on the implement's
 * list at the gym), and where to confirm them. Empty when none is a draft.
 */
export function draftLines(result: LogWorkout, who: { member: string; own: boolean } = { member: "", own: true }): string[] {
  const drafts = (result.sets as LoggedSetOut[]).filter((x) => x.set?.state === "draft");
  if (drafts.length === 0) return [];
  const groups = new Map<string, { exercise: string; numbers: number[]; why: string | null }>();
  for (const d of drafts) {
    const exercise = d.set?.exercise ?? "a set";
    const offList = d.snap?.status === "off_list";
    const why = offList && d.snap ? `${qty(d.snap.value)} ${d.snap.unit} isn't on the gym's list for the ${d.set?.implement ?? "implement"}` : null;
    const key = `${exercise}|${why ?? ""}`;
    const g = groups.get(key) ?? { exercise, numbers: [], why };
    if (d.set?.set_number !== undefined) g.numbers.push(d.set.set_number);
    groups.set(key, g);
  }
  const parts = [...groups.values()].map((g) => `${g.exercise}${g.numbers.length > 0 ? ` ${setNumbers(g.numbers)}` : ""}${g.why ? `, because ${g.why}` : ""}`);
  const one = drafts.length === 1;
  // Another member's sets are theirs to confirm (review round): only they can, on their own Train.
  const next = who.own ? `Confirm ${one ? "it" : "them"} on Train if that is what you lifted.` : `${who.member} confirms ${one ? "it" : "them"} on their Train.`;
  return [`${drafts.length} of them went in as ${one ? "a draft" : "drafts"}, not confirmed: ${parts.join("; ")}. ${next}`];
}

/** What the after-Save screen says: how many sets went where, which went in as drafts and why, then each linked prescription's state. */
export function loggedLines(result: LogWorkout, who?: { member: string; own: boolean }): string[] {
  const where = result.session.workout ?? result.session.template;
  const blocks = result.cardio?.length ?? 0;
  const what = [result.sets.length > 0 || blocks === 0 ? plural(result.sets.length, "set", "sets") : null, blocks > 0 ? plural(blocks, "cardio block", "cardio blocks") : null].filter(Boolean).join(" and ");
  return [`${what} saved${where ? ` in ${where}` : ""}.`, ...draftLines(result, who), ...progressLines(result)];
}

export function offerSaveAsWorkout(result: LogWorkout): boolean {
  return result.session.created && result.session.workout === null && result.session.template === null;
}

export function saveAsWorkoutPlan(sessionId: number, name: string): Plan | { error: string } {
  if (!name.trim()) return { error: "Name the workout." };
  return { steps: [planStep("save_session_as_workout", { session_id: sessionId, name: name.trim(), reason: "Saved from the app" })], done: `Saved as ${name.trim()}.` };
}
