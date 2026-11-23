/**
 * The Set tab (spec §5): pick an exercise, give the load (value or plates),
 * reps, RIR and set type, preview with preview_set, save with log_set by
 * member and date (the session is found or created in the same write).
 */
import { qty } from "./format";
import { plateLoad, type PlateBuild } from "./plateBuilder";
import type { CatalogueHit, NextForEntry, PrescribedLoad, PreviewSet, RecentItems, WorkoutLineOut } from "./types";
import { planStep, type Plan } from "./writes";
import { typedNumber } from "./typed";

export interface ExerciseChoice {
  name: string;
  group: "Today" | "Next session" | "Recent" | "Search results";
  detail: string | null;
}

export function exerciseChoices(recent: RecentItems | null, next: NextForEntry | null, hits: CatalogueHit[] | null): ExerciseChoice[] {
  if (hits !== null) return hits.filter((h) => h.kind === "exercise").map((h) => ({ name: h.name, group: "Search results", detail: h.aliases.length ? `also "${h.aliases.join('", "')}"` : null }));
  const out: ExerciseChoice[] = [];
  const seen = new Set<string>();
  const add = (name: string, group: ExerciseChoice["group"], detail: string | null) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name, group, detail });
  };
  for (const e of recent?.exercises ?? []) if (e.today) add(e.exercise, "Today", null);
  for (const p of next?.prescriptions ?? []) add(p.exercise, "Next session", next?.session ?? null);
  for (const e of recent?.exercises ?? []) if (!e.today) add(e.exercise, "Recent", null);
  return out;
}

export type Basis = "total" | "per_side" | "per_hand" | "per_leg";
export type LoadDraft = { kind: "value"; value: string; unit: "kg" | "lb"; basis: Basis } | { kind: "plates"; build: PlateBuild } | { kind: "none" } | { kind: "not_recorded" };

export interface SetDraft {
  exercise: string;
  setType: "working" | "warm_up" | "back_off";
  /** Counted in reps (the default) or held for seconds (a hang, a plank). */
  kind?: "reps" | "duration";
  reps: string;
  secs?: string;
  rir: string;
  load: LoadDraft;
  /** The implement the member chose when the API asked which (click test P1-6); sent with every later set of this exercise. */
  implement?: string;
}

/**
 * A planned load as a form starts it: plates on a bar, a value with its
 * basis, or none. With nothing planned, a counted set asks for a load; a
 * timed one starts with none (web decision 94).
 */
export function plannedLoad(l: PrescribedLoad | WorkoutLineOut["load"] | null, kind: "reps" | "duration" | "distance" = "reps"): LoadDraft {
  if (l === null) return kind === "reps" ? { kind: "value", value: "", unit: "kg", basis: "total" } : { kind: "none" };
  if (l === "none") return { kind: "none" };
  if (l.plates && l.plates.length > 0) return { kind: "plates", build: { bar: l.bar ? { value: l.bar.value, unit: l.bar.unit } : null, plates: l.plates.map((p) => ({ value: p.value, unit: p.unit, count: p.count })) } };
  return { kind: "value", value: qty(l.value), unit: l.unit, basis: (l.basis ?? "total") as Basis };
}

/**
 * The Set form for a picked exercise, fresh: the next session's
 * prescription gives its load (bar and plates included) and whether it is
 * counted in reps or seconds; reps, seconds and RIR start empty, and
 * nothing from the exercise before carries over (click test P2-16, P2-17).
 */
export function draftForExercise(exercise: string, next: NextForEntry | null): SetDraft {
  const p = next?.prescriptions?.find((x) => x.exercise === exercise);
  const kind = p?.target.kind === "duration" ? "duration" : "reps";
  return { exercise, setType: "working", kind, reps: "", secs: "", rir: "", load: plannedLoad(p?.load ?? null, kind) };
}

/** "2" or "1-2"; empty is null; anything else, or a range that runs backwards, is bad. */
export function parseRir(text: string): { low: number; high: number } | null | "bad" {
  const t = text.trim();
  if (!t) return null;
  const m = /^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/.exec(t);
  if (!m) return "bad";
  const low = Number(m[1]);
  const high = m[2] === undefined ? low : Number(m[2]);
  return low > 10 || high > 10 || low > high ? "bad" : { low, high };
}

/** The Set tab's "Load as" chips, in order: every kind loadInput sends, "Not recorded" included (never defaulted). */
export const LOAD_CHIPS: readonly { kind: LoadDraft["kind"]; label: string }[] = [
  { kind: "value", label: "Weight" },
  { kind: "plates", label: "Plates" },
  { kind: "none", label: "Bodyweight" },
  { kind: "not_recorded", label: "Not recorded" },
];

export function loadInput(l: LoadDraft): { load: unknown } | { error: string } {
  if (l.kind === "none") return { load: "none" };
  if (l.kind === "not_recorded") return { load: "not_recorded" };
  if (l.kind === "plates") return plateLoad(l.build);
  const v = typedNumber(l.value, { signed: true });
  if (!l.value.trim() || !Number.isFinite(v)) return { error: "Enter the load." };
  return { load: { value: v, unit: l.unit, basis: l.basis } };
}

/**
 * `template`: the session card's programme session when the sheet was opened
 * from a later session's card (click test P2-16), so the set starts that
 * session today; log_set otherwise takes the schedule's session for the day.
 */
export function setInput(member: string, date: string, d: SetDraft, mode: "prescribed" | "record_only", template: string | null = null): { input: Record<string, unknown> } | { error: string } {
  const built = setFields(member, date, d, mode);
  return template && "input" in built ? { input: { ...built.input, template } } : built;
}

function setFields(member: string, date: string, d: SetDraft, mode: "prescribed" | "record_only"): { input: Record<string, unknown> } | { error: string } {
  if (!d.exercise.trim()) return { error: "Choose the exercise." };
  if (d.kind === "duration") {
    // A hold is counted in seconds; reps in reserve belongs to counted reps (Worker decision 144).
    const secs = typedNumber(d.secs ?? "");
    if (!(d.secs ?? "").trim() || !Number.isInteger(secs) || secs <= 0) return { error: "Enter the seconds." };
    const rir = parseRir(d.rir);
    if (rir === "bad") return { error: "Enter the reps in reserve as a number, or a range like 1-2." };
    const load = loadInput(d.load);
    if ("error" in load) return load;
    return { input: { member, date, exercise: d.exercise, set_type: d.setType, duration_s: secs, ...(rir ? { rir } : {}), load: load.load } };
  }
  const reps = typedNumber(d.reps);
  if (!d.reps.trim() || !Number.isInteger(reps) || reps < 0 || reps > 200) return { error: "Enter the reps." };
  const rir = parseRir(d.rir);
  if (rir === "bad") return { error: "Enter the reps in reserve as a number, or a range like 1-2." };
  if (rir === null && mode === "prescribed" && d.setType === "working") return { error: "Enter the reps in reserve." };
  const load = loadInput(d.load);
  if ("error" in load) return load;
  const withImplement = d.implement && typeof load.load === "object" ? { ...(load.load as Record<string, unknown>), implement: d.implement } : load.load;
  return { input: { member, date, exercise: d.exercise, set_type: d.setType, reps, ...(rir ? { rir } : {}), load: withImplement } };
}

export function setPlan(input: Record<string, unknown>): Plan {
  return { steps: [planStep("log_set", input)], done: "Set logged." };
}

const kg = (v: number) => `${qty(v)} kg`;

/** preview_set's checks, in words. */
/**
 * preview_set's checks in words. `session: false` leaves out which session
 * the set would start: in a workout, the Save (log_workout) decides that
 * from the workout, so a single set's guess would mislead.
 */
export function setFeedback(p: PreviewSet, opts: { session?: boolean } = {}): string[] {
  const out: string[] = [];
  if (typeof p.set.total_kg === "number") out.push(`${kg(p.set.total_kg)} in all.`);
  if (p.snap?.status === "off_list") {
    const near = [p.snap.below, p.snap.above].filter((l): l is { value: number; unit: "kg" | "lb" } => !!l).map((l) => `${qty(l.value)} ${l.unit}`).join(", ");
    out.push(`${qty(p.snap.value)} ${p.snap.unit} isn't on the gym's list${near ? ` (nearest ${near})` : ""}. It will wait as a draft until the load is added.`);
  }
  if (p.implausible) out.push(`That is far from last time's ${kg(p.implausible.referenceKg)}. Check the unit and the basis.`);
  if (opts.session !== false && p.session.would_create) out.push(p.session.template ? `This starts today's ${p.session.template} session.` : "This starts a new session for the day.");
  return out;
}

export interface CardioDraft {
  activity: string;
  minutes: string;
  km: string;
  avgHr: string;
}

export function cardioPlan(member: string, date: string, d: CardioDraft): Plan | { error: string } {
  const minutes = typedNumber(d.minutes);
  // Rounded to the second it is stored in: minutes too few to be a second are refused, never sent as 0 s (ticket 67).
  const seconds = Math.round(minutes * 60);
  if (!d.minutes.trim() || !Number.isFinite(minutes) || seconds <= 0) return { error: "Enter how long." };
  const km = typedNumber(d.km);
  const hr = typedNumber(d.avgHr);
  // An optional field typed is sent or refused, never dropped (ticket 67); the Worker checks the heart rate's range.
  if (d.km.trim().includes(",")) return { error: "Use a point for the distance's decimal: 2.5, not 2,5." };
  if (d.km.trim() && !(Number.isFinite(km) && km > 0)) return { error: "Enter the distance in km above 0, or leave it blank if not known." };
  if (d.avgHr.trim() && !(Number.isInteger(hr) && hr > 0)) return { error: "Enter the average heart rate as a whole number above 0, or leave it blank if not known." };
  const block = {
    kind: "steady",
    ...(d.activity.trim() ? { activity: d.activity.trim() } : {}),
    duration_s: seconds,
    ...(d.km.trim() ? { distance: { value: km, unit: "km" } } : {}),
    ...(d.avgHr.trim() ? { avg_hr: hr } : {}),
  };
  return { steps: [planStep("log_cardio", { member, date, session_type: "cardio", blocks: [block] })], done: "Cardio logged." };
}
