/**
 * Train's Next session (spec §5): the API's next session, rows and states,
 * worded. Every load, step and state comes from next_prescription; this
 * only formats them (a duration in minutes is a unit of display).
 */
import { day, plainReason, plural, qty as q } from "./format";
import { plateLayout, type PlateLayout } from "./plates";
import { loadText } from "./format";
import { CORRECTED_REASON, REMOVED_REASON, setFix, type SetFix } from "./fixes";
import type { SheetTarget } from "./sheet";
import { planStep, type Plan } from "./writes";
import type { CheckOffer, DescribedSet, InventoryGaps, NextPrescription, Prescription, RecordRef, SessionsList } from "./types";
import { typedNumber } from "./typed";

export interface TrainData {
  own: boolean;
  viewing: string;
  next: NextPrescription;
  gaps: InventoryGaps | null;
  history: SessionsList | null;
}

export interface TrainRow {
  id: number;
  exercise: string;
  dose: string;
  load: { kind: "plates"; layout: PlateLayout } | { kind: "value"; text: string } | null;
  chip: { kind: Prescription["state"]["kind"]; text: string };
  cue: string | null;
  fallback: string | null;
  /** Your own view only: the inferred sets to confirm as logged. */
  confirm: { setIds: number[] } | null;
  /** Your own view only: an unverified step answerable in one tap either way. */
  check: { offer: CheckOffer } | null;
}

export type Question = { kind: "plates"; unit: "kg" | "lb"; values: number[]; text: string } | { kind: "chat"; text: string };

export interface TrainView {
  kind: "prescribed" | "record_only" | "empty";
  /** How a set's RIR is checked when it is edited (ticket 61). */
  mode: "prescribed" | "record_only";
  own: boolean;
  title: string | null;
  /** The next session's programme session and day, for its card's "Log a set". */
  session: { template: string; date: string | null } | null;
  policy: string | null;
  gaps: string[];
  rows: TrainRow[];
  question: Question | null;
  message: string | null;
  history: HistoryCard[];
  /** The start of the range shown; "Show earlier" reaches back from it. */
  historyFrom: string | null;
  /** The sessions read failed: say so, never "no sessions". */
  historyFailed: boolean;
}

const span = (low: number | null, high: number | null) => (low === null ? (high === null ? "" : q(high)) : high === null || high === low ? q(low) : `${q(low)}–${q(high)}`);

function dose(p: Prescription): string {
  const t = p.target;
  if (t.kind === "duration") {
    // Whole minutes read as minutes ("20–30 min"); anything else in seconds ("2 × 30–45 s"), never "0.5–0.75 min".
    const bounds = [t.low_s, t.high_s].filter((x): x is number => x !== null);
    const minutes = bounds.length > 0 && bounds.every((x) => x % 60 === 0);
    const time = minutes ? `${span(t.low_s === null ? null : t.low_s / 60, t.high_s === null ? null : t.high_s / 60)} min` : `${span(t.low_s, t.high_s)} s`;
    return `${p.sets && p.sets > 1 ? `${p.sets} × ` : ""}${time}`;
  }
  if (t.kind === "distance") return `${p.sets && p.sets > 1 ? `${p.sets} × ` : ""}${t.value === null ? "" : q(t.value)} ${t.unit ?? ""}`.trim();
  const reps = `${p.sets ? `${p.sets} × ` : ""}${span(t.low, t.high)}`;
  return p.rir_target ? `${reps} @ RIR ${span(p.rir_target.low, p.rir_target.high)}` : reps;
}

function chip(p: Prescription): TrainRow["chip"] {
  const s = p.state;
  switch (s.kind) {
    case "ready":
      return { kind: s.kind, text: s.next_load ? `Ready → ${loadText({ ...s.next_load, basis: p.load?.basis ?? null, bar: p.load?.bar ?? null })}` : "Ready" };
    case "needs_confirmation":
      return { kind: s.kind, text: `Needs confirmation (${plural(s.set_ids.length, "set", "sets")})` };
    case "check_at_gym":
      return { kind: s.kind, text: `Check at the gym (${s.question})` };
    case "holding":
      return { kind: s.kind, text: `Holding (${plainReason(s.reason)})` };
    case "cant_move":
      return { kind: s.kind, text: `Can't move (${plainReason(s.reason)})` };
  }
}

function row(p: Prescription, own: boolean): TrainRow {
  const layout = p.load ? plateLayout(p.load) : null;
  const fallbacks = p.fallbacks.length > 0 ? `Or: ${p.fallbacks.join(", ")}.` : null;
  // The fallback note is coach text, its member's alone; the fallback exercises' names are training (web decision 81).
  const fallback = [own ? p.fallback_note : null, fallbacks].filter((x): x is string => !!x).join(" ") || null;
  const s = p.state;
  return {
    id: p.prescription_id,
    exercise: p.exercise,
    dose: dose(p),
    load: p.load === null ? null : layout ? { kind: "plates", layout } : { kind: "value", text: loadText(p.load) },
    chip: chip(p),
    // Coach notes are their member's alone (Worker decision 135, web decision 81): they cite BMR, BIA and bloods.
    cue: own ? p.cue : null,
    fallback,
    confirm: own && s.kind === "needs_confirmation" ? { setIds: s.set_ids } : null,
    check: own && s.kind === "check_at_gym" && s.offer?.if_exists.tool === "add_implement_load" ? { offer: s.offer } : null,
  };
}

const POLICY: Record<string, string> = {
  hold: "Hold the loads: it has been a while since this session.",
  back_off: "Back off the loads after the layoff.",
};

function question(gaps: InventoryGaps | null): Question | null {
  const ask = gaps?.ask;
  if (!ask) return null;
  if (ask.kind === "plate_denominations" && ask.unit && ask.unknown && ask.unknown.length > 0) {
    return { kind: "plates", unit: ask.unit, values: ask.unknown, text: `Which of these ${ask.unit} plates are on the rack? Tap the ones you see; the rest are saved as not there.` };
  }
  return { kind: "chat", text: `${ask.question} Tell the agent at the gym.` };
}

export function buildTrain(data: TrainData): TrainView {
  const n = data.next;
  const history = { history: data.history ? buildHistory(data.history, data.own) : [], historyFrom: data.history?.from ?? null, historyFailed: data.history === null };
  const base = { own: data.own, mode: n.programming_mode, title: null, session: null, policy: null, gaps: [], rows: [], question: null, ...history };
  if (n.programming_mode === "record_only") {
    return { ...base, kind: "record_only", message: `Programmed by ${data.viewing}'s trainer: sessions are recorded here, not prescribed.` };
  }
  if (!n.session) {
    const message = n.message === "no active programme" || n.message === undefined ? "No programme yet. The agent sets one up from your Guide." : "The schedule has no training day ahead.";
    return { ...base, kind: "empty", message };
  }
  return {
    kind: "prescribed",
    own: data.own,
    mode: n.programming_mode,
    title: n.date ? `${n.session}, ${day(n.date)}` : n.session,
    session: { template: n.session, date: n.date ?? null },
    policy: n.layoff_policy ? (POLICY[n.layoff_policy] ?? null) : null,
    gaps: (n.gaps ?? []).map((g) => `Not done yet: ${g.exercise} (${g.template})`),
    rows: (n.prescriptions ?? []).map((p) => row(p, data.own)),
    question: data.own ? question(data.gaps) : null,
    message: null,
    ...history,
  };
}

/**
 * "Log a set" on the session's card (click test P2-16): a later session's
 * card sends its template, so the set starts that session today, early,
 * rather than landing in the session the schedule has for today.
 */
export function setTarget(view: TrainView, exercise: string, member: string, today: string): SheetTarget {
  const later = view.session !== null && view.session.date !== null && view.session.date > today;
  return { tab: "set", exercise, member, ...(later && view.session ? { template: view.session.template } : {}) };
}

/** Identifies a question, so a new one starts with no taps carried over from the last. */
export function questionKey(q: Question): string {
  return q.kind === "plates" ? `${q.unit}|${q.values.join(",")}` : "chat";
}

export interface HistoryCard {
  id: number;
  title: string;
  summary: string;
  records: string[];
  /** "Imported from Sheets." when the import wrote the session. */
  note: string | null;
  /** `fix`: your own confirmed set's Edit and Remove (ticket 61); `confirm`: your own draft set's records to confirm here (click test P1-5). */
  sets: { id: number; text: string; draft: boolean; fix?: SetFix; confirm?: RecordRef[] }[];
  /** Your own confirmed cardio session's Edit (a lone block's minutes) and Remove (every block), click test P2-20. */
  cardioFix?: CardioFix;
  /** A gym session's cardio blocks (a treadmill line, ticket 68): "Cardio: 1 block, 20 min", its own row under the sets. */
  cardio?: string;
}

export interface CardioFix {
  remove: RecordRef[];
  /** The session retracted after its blocks; null when it also holds sets, which stay (ticket 68). */
  session: number | null;
  /** "Remove 30 min of cardio on Mon 5 Oct?" */
  ask: string;
  /** Null when the session has more than one block: remove it and log it again. */
  edit: { id: number; minutes: string } | null;
}

/**
 * A cardio session removed: its blocks, then the session itself (so its
 * energy and its card go too), one held plan with a key per step and the
 * fixed reason (web decisions 76 and 101, Worker decision 146).
 */
export function removeCardioPlan(blocks: RecordRef[], sessionId: number | null): Plan {
  const blocksStep = planStep("retract", { records: blocks, reason: REMOVED_REASON });
  // A gym session's treadmill block goes alone: the session and its sets stay (ticket 68).
  if (sessionId === null) return { steps: [blocksStep], done: "Removed." };
  return { steps: [blocksStep, planStep("retract", { records: [{ table: "session", id: sessionId }], reason: REMOVED_REASON })], done: "Removed." };
}

/** A lone block's minutes, in one amend of its duration; the same minutes, however written ("30.0"), sends nothing. */
export function editCardioPlan(e: { id: number; minutes: string }, minutes: string): Plan | { error: string } {
  const m = typedNumber(minutes);
  const seconds = Math.round(m * 60);
  if (!Number.isFinite(m) || seconds <= 0) return { error: "Enter the minutes as a number, at least a second's worth." };
  if (m > 600) return { error: "Enter the minutes, up to 600." };
  if (minutes.trim() === e.minutes || seconds === Math.round(Number(e.minutes) * 60)) return { error: "Nothing changed." };
  return { steps: [planStep("amend", { record: { table: "cardio_block", id: e.id }, changes: { duration_s: seconds }, reason: CORRECTED_REASON })], done: `Changed to ${q(m)} min.` };
}

const SESSION_TITLE: Record<string, string> = { strength: "Gym session", class: "Dance class", cardio: "Cardio" };
const ONE = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function setLoad(s: DescribedSet): string {
  if (s.load_status === "none") return "bodyweight";
  if (s.load_status === "not_recorded" || s.load_value === null || s.load_unit === null) return "load not recorded";
  return loadText({ value: s.load_value, unit: s.load_unit, basis: s.load_basis, bar: s.bar, plates: s.plates });
}

function setRir(r: DescribedSet["rir"]): string {
  if (r === null) return "RIR blank";
  if (r === "not_recorded") return "RIR not recorded";
  return `RIR ${span(r.low, r.high)}`;
}

/** "26 min 40 s", "45 s", "2 min". */
function seconds(total: number): string {
  const m = Math.floor(total / 60);
  const s = Math.round(total % 60);
  return m === 0 ? `${s} s` : s === 0 ? `${m} min` : `${m} min ${s} s`;
}

/**
 * A set as Train lists it. Counted reps read "10 × 40 kg, RIR 2"; a hold or
 * a carry reads by its time or distance, its load only when it had one, and
 * its RIR only when given (click test P2-14).
 */
function setText(x: DescribedSet): string {
  const name = `${x.exercise}${x.set_type === "working" ? "" : `, ${x.set_type.replace("_", "-")}`}`;
  const amount = x.reps === null ? (x.duration_s ? seconds(x.duration_s) : x.distance ? `${q(x.distance.value)} ${x.distance.unit}` : null) : null;
  if (amount === null) return `${name}: ${x.reps ?? "?"} × ${setLoad(x)}, ${setRir(x.rir)}`;
  const load = x.load_status === "none" ? "" : x.load_status === "not_recorded" ? ", load not recorded" : ` with ${setLoad(x)}`;
  const rir = x.rir !== null && x.rir !== "not_recorded" ? `, ${setRir(x.rir)}` : "";
  return `${name}: ${amount}${load}${rir}`;
}

function cardioFix(s: SessionsList["sessions"][number]): CardioFix {
  const ids = s.cardio?.block_ids ?? [];
  const mins = s.cardio?.duration_s ? `${q(s.cardio.duration_s / 60)} min of ` : "";
  const withSets = s.sets.length > 0;
  return {
    remove: ids.map((id) => ({ table: "cardio_block", id })),
    session: withSets ? null : s.id,
    ask: `Remove ${mins}${withSets ? "cardio" : (SESSION_TITLE[s.session_type]?.toLowerCase() ?? "cardio")} on ${day(s.date)}?`,
    edit: ids.length === 1 && s.cardio?.duration_s ? { id: ids[0] as number, minutes: q(Math.round((s.cardio.duration_s / 60) * 100) / 100) } : null,
  };
}

const cardioWords = (c: NonNullable<SessionsList["sessions"][number]["cardio"]>) => `${plural(c.blocks, "block", "blocks")}${c.duration_s === null ? "" : `, ${q(c.duration_s / 60)} min`}`;

/** Session cards, newest first as the API returns them; every figure is the API's, only worded here. `own`: your own sessions, whose confirmed sets can be fixed. */
export function buildHistory(list: SessionsList, own = false): HistoryCard[] {
  return list.sessions.map((s) => ({
    id: s.id,
    title: `${day(s.date)}: ${s.template ?? SESSION_TITLE[s.session_type] ?? s.session_type}`,
    summary: s.cardio && s.sets.length === 0
      ? `${cardioWords(s.cardio)}${s.energy_kcal === null ? "" : `, ${q(s.energy_kcal)} kcal`}`
      : `${plural(s.working_sets, "working set", "working sets")}, ${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(s.volume_kg)} kg volume`,
    // A gym session with a treadmill block (ticket 68) says both: the sets above, the cardio as its own row.
    ...(s.cardio && s.sets.length > 0 ? { cardio: `Cardio: ${cardioWords(s.cardio)}` } : {}),
    ...(own && s.state === "confirmed" && s.cardio?.block_ids?.length ? { cardioFix: cardioFix(s) } : {}),
    records: s.records.map((r) => `Best e1RM on ${r.exercise}: ${ONE.format(r.e1rm_kg)} kg (was ${ONE.format(r.previous_best_kg)} kg)`),
    note: s.imported ? "Imported from Sheets." : null,
    sets: s.sets.map((x) => ({
      id: x.id,
      text: setText(x),
      draft: x.state === "draft",
      ...(own && x.state === "confirmed" ? { fix: setFix(x) } : {}),
      ...(own && x.state === "draft" ? { confirm: [{ table: "session_set", id: x.id }] } : {}),
    })),
  }));
}

/** The session open beside the list: the one picked, else the newest with sets (a class has none), else the newest. */
export function selectedSession(cards: HistoryCard[], picked: number | null): HistoryCard | null {
  return cards.find((c) => c.id === picked) ?? cards.find((c) => c.sets.length > 0) ?? cards[0] ?? null;
}

/**
 * The one session list (wide-layout spec §5, review #4, #5): the sessions
 * "Show earlier" added after the page's own, its status and the session
 * picked, for one member. `history` lists the page's sessions then these,
 * and `open` shows the pick, so an earlier session opens as any other.
 */
export interface SessionHistory {
  member: string;
  earlier: HistoryCard[];
  from: string | null;
  status: "idle" | "loading" | "error";
  picked: number | null;
  /** The `before` of the "Show earlier" load in flight, or null: only its answer is taken. */
  asking: string | null;
}

/**
 * Every action names the member it is for, and a load's answer the `before` it
 * asked for: one that lands after a switch, or after a newer load, is dropped.
 */
export type HistoryAction =
  | { kind: "pick"; member: string; id: number }
  | { kind: "loading"; member: string; before: string }
  | { kind: "loaded"; member: string; before: string; cards: HistoryCard[]; from: string }
  | { kind: "failed"; member: string; before: string };

export function emptyHistory(member: string): SessionHistory {
  return { member, earlier: [], from: null, status: "idle", picked: null, asking: null };
}

export function historyStep(s: SessionHistory, a: HistoryAction): SessionHistory {
  if (a.member !== s.member) return s;
  switch (a.kind) {
    case "pick":
      return { ...s, picked: a.id };
    case "loading":
      return { ...s, status: "loading", asking: a.before };
    case "failed":
      return a.before === s.asking ? { ...s, status: "error", asking: null } : s;
    case "loaded":
      return a.before === s.asking ? { ...s, status: "idle", asking: null, earlier: [...s.earlier, ...a.cards], from: a.from } : s;
  }
}

/**
 * What `history` lists and `open` shows: the page's sessions then the earlier
 * ones, the oldest date shown (where "Show earlier" reads before), and the
 * session open (`selectedSession` over the whole list).
 */
export function sessionList(shown: HistoryCard[], shownFrom: string | null, s: SessionHistory): { cards: HistoryCard[]; oldest: string | null; selected: HistoryCard | null } {
  const cards = [...shown, ...s.earlier];
  return { cards, oldest: s.from ?? shownFrom, selected: selectedSession(cards, s.picked) };
}
