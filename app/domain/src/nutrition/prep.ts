/**
 * Prep scheduling: turn a recipe's ordered prep steps and a plan's meal
 * occasions into dated tasks (handover, 23 Nov 2026; decision 169).
 *
 * Pure: no database, no clock. The Worker resolves recipes, eaters and food
 * names and passes plain occurrences in; the result is what preview and
 * save return and what `prep_task` stores.
 */
import { addDays, daysBetween, WEEKDAYS, weekdayOf } from "../dates";

export type PrepLead = "same_meal" | "minutes_before" | "hours_before" | "evening_before" | "day_before";
export type PrepWho = "eater" | "cook" | "anyone";
export type PrepStorage = "fridge" | "freezer" | "counter";

export interface PrepStep {
  action: string;
  lead: PrepLead;
  lead_min_h: number | null;
  lead_max_h: number | null;
  duration_min: number | null;
  who: PrepWho;
  batchable: boolean;
  keeps_days: number | null;
  /** Steps prepared together share a group, so they batch with each other and not with another night's work. */
  batch_group: string | null;
  /** How many days of consumers one batch may cover; defaults to `keeps_days`. */
  batch_days: number | null;
  storage: PrepStorage | null;
  /** A batch beyond `keeps_days` can be frozen and thawed instead of split. */
  freezer_ok: boolean;
  food: string | null;
  amount_value: number | null;
  amount_unit: string | null;
  note: string | null;
}

/** One planned meal that a step belongs to. */
export interface PrepOccurrence {
  date: string;
  meal_slot: string;
  /** The planned cook or dish the step is for, as the member sees it. */
  meal: string;
  /** The recipe the step came from. */
  recipe: string;
  /** Members with a portion of the dish; empty when shares are not decided. */
  eaters: readonly string[];
  /** The recipe step's position, so consecutive steps can be ordered. */
  position?: number;
  step: PrepStep;
}

export interface PrepFor {
  date: string;
  meal_slot: string;
  meal: string;
}

export interface PrepQuantity {
  food: string | null;
  value: number | null;
  unit: string | null;
}

export interface PrepPart {
  storage: PrepStorage | null;
  quantity: PrepQuantity[];
  for: PrepFor[];
}

export interface PrepTask {
  /** Stable across plan revisions: a done task stays done after an edit. */
  task_key: string;
  due_by: string;
  window_start: string;
  window_end: string;
  action: string;
  who: PrepWho;
  assignees: string[];
  quantity: PrepQuantity[];
  for: PrepFor[];
  /** Present only for a batch whose parts are kept differently: the split. */
  parts: PrepPart[];
  batch_id: string | null;
  storage: PrepStorage | null;
  note: string | null;
}

/** Where a meal slot sits in the day; the lead window is measured from it. */
const MEAL_TIME: Record<string, string> = {
  breakfast: "08:00",
  lunch: "13:00",
  dinner: "20:00",
  snack: "17:00",
  pre_workout: "06:30",
  post_workout: "09:30",
};

/** A frozen batch is usable this long; the thaw task brings it back to the fridge. */
export const FREEZER_DAYS = 30;

/** A batch never reaches further than this, even across a freezer. */
const MAX_BATCH_DAYS = FREEZER_DAYS;

const DEFAULT_LEAD: Record<PrepLead, { min: number; max: number }> = {
  same_meal: { min: 0, max: 0 },
  minutes_before: { min: 0.5, max: 1 },
  hours_before: { min: 4, max: 12 },
  evening_before: { min: 12, max: 18 },
  day_before: { min: 18, max: 30 },
};

function at(date: string, time: string): string {
  return `${date}T${time}`;
}

function shiftMinutes(dateTime: string, minutes: number): string {
  const [date, time] = dateTime.split("T") as [string, string];
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [h, min] = time.split(":").map(Number) as [number, number];
  const moved = new Date(Date.UTC(y, m - 1, d, h, min) + minutes * 60_000);
  return `${moved.toISOString().slice(0, 10)}T${moved.toISOString().slice(11, 16)}`;
}

/** The window a step opens and closes in, before batching. */
export function prepWindow(step: PrepStep, date: string, mealSlot: string): { start: string; end: string } {
  const fallback = DEFAULT_LEAD[step.lead];
  const minH = step.lead_min_h ?? fallback.min;
  // A single bound must not invert the window: the nearest lead can be
  // further out than the default furthest one.
  const maxH = Math.max(minH, step.lead_max_h ?? fallback.max);
  // The evening and day before are calendar offsets, not hour counts: they
  // mean the previous day whatever slot the meal is in.
  if (step.lead === "evening_before") {
    return { start: at(addDays(date, -1), "18:00"), end: at(addDays(date, -1), "22:00") };
  }
  if (step.lead === "day_before") {
    return { start: at(addDays(date, -1), "08:00"), end: at(addDays(date, -1), "22:00") };
  }
  const meal = at(date, MEAL_TIME[mealSlot] ?? "12:00");
  if (step.lead === "same_meal") return { start: shiftMinutes(meal, -30), end: meal };
  return { start: shiftMinutes(meal, -maxH * 60), end: shiftMinutes(meal, -minH * 60) };
}

function foodKey(q: PrepQuantity): string {
  return `${(q.food ?? "").trim().toLowerCase()}|${(q.unit ?? "").trim().toLowerCase()}`;
}

function mergeQuantities(into: PrepQuantity[], add: readonly PrepQuantity[]): void {
  for (const q of add) {
    const key = foodKey(q);
    const found = into.find((existing) => foodKey(existing) === key);
    if (!found) {
      into.push({ ...q });
    } else if (found.value !== null && q.value !== null) {
      found.value = Math.round((found.value + q.value) * 1000) / 1000;
    }
  }
}

function sameFor(a: PrepFor, b: PrepFor): boolean {
  return a.date === b.date && a.meal_slot === b.meal_slot && a.meal === b.meal;
}

function addFor(into: PrepFor[], add: readonly PrepFor[]): void {
  for (const f of add) if (!into.some((existing) => sameFor(existing, f))) into.push(f);
}

const normal = (action: string) => action.trim().replace(/\s+/g, " ").toLowerCase();

/** A short, deterministic identity for a task across plan revisions. */
function fnv1a(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** A short, deterministic identity for a task across plan revisions; content-derived, so two different jobs never share one. */
export function prepTaskKey(task: Omit<PrepTask, "task_key">): string {
  const body = JSON.stringify({
    due: task.due_by,
    action: normal(task.action),
    who: task.who,
    assignees: [...task.assignees].sort(),
    quantity: task.quantity,
    for: task.for,
    batch: task.batch_id,
    storage: task.storage,
  });
  const readable = normal(task.action).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "task";
  return `${readable}#${fnv1a(body, 0x811c9dc5)}${fnv1a(body, 0x01000193)}`;
}

interface Expanded extends PrepTask {
  step: PrepStep;
  eaters: string[];
  recipe: string;
  position: number;
  /** The consumer meal's own datetime, for batching order. */
  consumes: string;
}

function expand(occurrence: PrepOccurrence, step: PrepStep): Expanded {
  const window = prepWindow(step, occurrence.date, occurrence.meal_slot);
  const assignees = step.who === "eater" ? [...new Set(occurrence.eaters)] : [];
  const task: Omit<Expanded, "task_key" | "consumes" | "step" | "eaters" | "recipe" | "position"> = {
    due_by: window.end,
    window_start: window.start,
    window_end: window.end,
    action: step.action.trim(),
    who: step.who,
    assignees,
    quantity: step.amount_value === null ? [] : [{ food: step.food, value: step.amount_value, unit: step.amount_unit }],
    for: [{ date: occurrence.date, meal_slot: occurrence.meal_slot, meal: occurrence.meal }],
    parts: [],
    batch_id: null,
    storage: step.storage,
    note: step.note,
  };
  return {
    ...task,
    task_key: prepTaskKey(task),
    step,
    eaters: [...occurrence.eaters],
    recipe: occurrence.recipe,
    position: occurrence.position ?? 0,
    consumes: at(occurrence.date, MEAL_TIME[occurrence.meal_slot] ?? "12:00"),
  };
}

/** One task without the scheduler's private fields (step, eaters, consumes). */
function plainTask(task: PrepTask): PrepTask {
  return {
    task_key: task.task_key,
    due_by: task.due_by,
    window_start: task.window_start,
    window_end: task.window_end,
    action: task.action,
    who: task.who,
    assignees: task.assignees,
    quantity: task.quantity,
    for: task.for,
    parts: task.parts,
    batch_id: task.batch_id,
    storage: task.storage,
    note: task.note,
  };
}

/** Two non-batchable tasks at the same moment are one job, whatever their foods. */
function sameMoment(a: Expanded, b: Expanded): boolean {
  return normal(a.action) === normal(b.action) && a.who === b.who && a.window_start === b.window_start;
}

function combine(a: Expanded, b: Expanded): Expanded {
  mergeQuantities(a.quantity, b.quantity);
  addFor(a.for, b.for);
  for (const eater of b.eaters) if (!a.eaters.includes(eater)) a.eaters.push(eater);
  if (a.assignees.length > 1) a.assignees.sort();
  a.consumes = a.consumes < b.consumes ? a.consumes : b.consumes;
  a.due_by = a.due_by < b.due_by ? a.due_by : b.due_by;
  a.window_end = a.window_end > b.window_end ? a.window_end : b.window_end;
  a.task_key = prepTaskKey(a);
  return a;
}

/** The date a batch is made on: the weekly session when it fits, else the first window. */
function batchDate(start: string, firstUse: string, dueBy: string, batchDay: number | null): string {
  const opened = start.slice(0, 10);
  if (batchDay === null) return opened;
  let candidate = opened;
  for (let i = 0; i < 7; i++) {
    const day = addDays(opened, i);
    if (WEEKDAYS.indexOf(weekdayOf(day)) === batchDay) {
      candidate = day;
      break;
    }
  }
  // A batch day that would delay the first meal (or land after the first
  // deadline) is not used.
  return candidate <= firstUse.slice(0, 10) && `${candidate}T10:00` <= dueBy ? candidate : opened;
}

/** The wall-clock midpoint of two YYYY-MM-DDTHH:MM values. */
function midpoint(a: string, b: string): string {
  const ms = (Date.parse(`${a}:00Z`) + Date.parse(`${b}:00Z`)) / 2;
  return new Date(ms).toISOString().slice(0, 16);
}

/**
 * Consecutive steps of one recipe on the same food happen in order: the
 * soak must finish before the cook begins. When their windows overlap, they
 * split at the overlap's midpoint instead of both running 08:00-22:00.
 */
function orderConsecutiveSteps(tasks: Expanded[]): void {
  const groups = new Map<string, Expanded[]>();
  for (const task of tasks) {
    const foods = task.quantity.map((q) => q.food?.trim().toLowerCase()).filter((food): food is string => Boolean(food));
    if (foods.length === 0) continue;
    const key = `${task.recipe}|${foods.join("|")}`;
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => a.position - b.position);
    for (let i = 1; i < ordered.length; i++) {
      const first = ordered[i - 1]!;
      const next = ordered[i]!;
      if (first.position >= next.position) continue;
      const start = first.window_start > next.window_start ? first.window_start : next.window_start;
      const end = first.window_end < next.window_end ? first.window_end : next.window_end;
      if (start >= end) continue;
      const boundary = midpoint(start, end);
      first.window_end = boundary;
      first.due_by = boundary;
      first.task_key = prepTaskKey(first);
      next.window_start = boundary;
      next.task_key = prepTaskKey(next);
    }
  }
}

/**
 * The schedule for a plan: one task per prep moment, batchable steps merged
 * across consumers within their shelf life, and a thaw task for each part
 * that has to be frozen to reach a later meal.
 */
export function buildPrepSchedule(occurrences: readonly PrepOccurrence[], options: { batch_day?: number | null; from?: string } = {}): PrepTask[] {
  const batchDay = options.batch_day ?? null;
  // Work that had to start before the plan does is not the plan's to ask for.
  const expanded = occurrences
    .filter((occurrence) => options.from === undefined || prepWindow(occurrence.step, occurrence.date, occurrence.meal_slot).start.slice(0, 10) >= options.from)
    .map((o) => expand(o, o.step));
  orderConsecutiveSteps(expanded);

  const groups = new Map<string, Expanded[]>();
  const singles: Expanded[] = [];
  for (const task of expanded) {
    if (!task.step.batchable) {
      singles.push(task);
      continue;
    }
    const key = `${normal(task.step.batch_group ?? task.action)}|${normal(task.action)}|${task.who}`;
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }

  // Same-moment jobs first, whatever their foods: "soak these two" is one task.
  const tasks: PrepTask[] = [];
  const moments: Expanded[] = [];
  for (const single of singles) {
    const twin = moments.find((m) => sameMoment(m, single));
    if (twin) combine(twin, single);
    else moments.push(single);
  }
  tasks.push(...moments.map(plainTask));

  for (const [groupKey, members] of groups) {
    const sorted = [...members].sort((a, b) => a.consumes.localeCompare(b.consumes));
    let current: Expanded[] = [];
    const flush = () => {
      if (current.length === 0) return;
      tasks.push(...finishBatch(current, batchDay, groupKey));
      current = [];
    };
    for (const member of sorted) {
      if (current.length === 0) {
        current.push(member);
        continue;
      }
      const base = current[0]!;
      const span = daysBetween(base.window_start.slice(0, 10), member.consumes.slice(0, 10));
      // Steps merged under one action share the group's widest horizon, so a
      // four-day chickpea soak is not cut short by the kala chana's one day.
      const horizons = [...current, member].map((m) => m.step.batch_days ?? m.step.keeps_days);
      const horizon = horizons.every((h) => h === null) ? null : Math.max(...horizons.filter((h): h is number => h !== null));
      const freezerOk = [...current, member].some((m) => m.step.freezer_ok);
      const reach = horizon === null ? null : freezerOk ? Math.max(horizon, MAX_BATCH_DAYS) : horizon;
      if (reach !== null && span <= reach && span <= MAX_BATCH_DAYS) current.push(member);
      else {
        flush();
        current.push(member);
      }
    }
    flush();
  }

  // A deterministic order: by when the window opens, then by action.
  return tasks.sort((a, b) => a.window_start.localeCompare(b.window_start) || a.action.localeCompare(b.action));
}

/** One batch: split the quantity by where each consumer's part is kept. */
function finishBatch(members: Expanded[], batchDay: number | null, groupKey: string): PrepTask[] {
  const first = members[0]!;
  const step = first.step;
  const dueBy = members.reduce((earliest, m) => (m.due_by < earliest ? m.due_by : earliest), members[0]!.due_by);
  // A batch day may move the work later, but never past the first meal it
  // serves: the Sunday session cannot soak Wednesday's chana.
  const firstUse = first.consumes.slice(0, 10);
  const date = batchDate(first.window_start, firstUse, dueBy, batchDay);
  const start = date === first.window_start.slice(0, 10) ? first.window_start : at(date, "10:00");
  const knownKeeps = members.flatMap((m) => (m.step.keeps_days === null ? [] : [m.step.keeps_days]));
  // Blank is never zero: an unrecorded shelf life does not claim "keeps 0
  // days" and freeze everything; it simply does not split.
  const keeps = knownKeeps.length === 0 ? Number.POSITIVE_INFINITY : Math.max(...knownKeeps);
  const freezerOk = members.some((m) => m.step.freezer_ok);
  const batchId = `batch:${groupKey}:${date}`;

  const parts: PrepPart[] = [];
  const thawTasks: Omit<PrepTask, "task_key">[] = [];
  const allFor: PrepFor[] = [];
  const allQuantity: PrepQuantity[] = [];
  const eaters: string[] = [];
  for (const member of members) {
    addFor(allFor, member.for);
    mergeQuantities(allQuantity, member.quantity);
    for (const eater of member.eaters) if (!eaters.includes(eater)) eaters.push(eater);
    const span = daysBetween(date, member.consumes.slice(0, 10));
    // Only a freezable batch splits: a soak for Sunday is done on Wednesday
    // with the rest and cooked straight away, not frozen as soaked beans.
    const storage: PrepStorage = freezerOk && span > keeps ? "freezer" : (step.storage ?? "fridge");
    let part = parts.find((p) => p.storage === storage);
    if (!part) {
      part = { storage, quantity: [], for: [] };
      parts.push(part);
    }
    mergeQuantities(part.quantity, member.quantity);
    addFor(part.for, member.for);
    if (storage === "freezer") {
      const forItem = member.for[0]!;
      const window = prepWindow({ ...step, lead: "evening_before" }, forItem.date, forItem.meal_slot);
      const frozen = member.quantity.map((q) => q.food ?? "batch").join(" and ");
      const task: Omit<PrepTask, "task_key"> = {
        due_by: window.end,
        window_start: window.start,
        window_end: window.end,
        action: `Move the frozen ${frozen} to the fridge`,
        who: "eater",
        assignees: [...new Set(member.eaters)],
        quantity: member.quantity.map((q) => ({ ...q })),
        for: member.for.map((f) => ({ ...f })),
        parts: [],
        batch_id: batchId,
        storage: "fridge",
        note: "Thaw overnight before use.",
      };
      thawTasks.push(task);
    }
  }

  const task: Omit<PrepTask, "task_key"> = {
    due_by: dueBy,
    window_start: start,
    window_end: dueBy,
    action: first.action,
    who: first.who,
    assignees: [...new Set(members.flatMap((m) => m.assignees))].sort(),
    quantity: allQuantity,
    for: allFor,
    parts: parts.length > 1 ? parts : [],
    batch_id: batchId,
    storage: parts[0]?.storage ?? step.storage,
    note: step.note,
  };
  const out: PrepTask[] = [{ ...task, task_key: prepTaskKey(task) }];
  for (const thaw of thawTasks) out.push({ ...thaw, task_key: prepTaskKey(thaw) });
  return out;
}
