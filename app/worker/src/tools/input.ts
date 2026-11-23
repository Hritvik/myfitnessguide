/**
 * The app's input tools (spec §3, §7, §8): recents ("my usual"), the
 * free-text router and its one write, and the Inbox.
 */
import type { NutrientTotals } from "@myfitnessguide/domain";
import { z } from "zod";
import { Catalogue, MEAL_SLOTS, PROVENANCE, type AmountIn, type SourceRow } from "../catalogue";
import type { Ctx, Member } from "../context";
import { all, allIn, first, type Row } from "../db";
import { Clarify, ToolError } from "../errors";
import { bestScore, prepareQuery } from "../fuzzy";
import { describeItem, ITEM, loadCooks, planEatenPortion, previewIds, resolveItem, type ItemIn, type LoadedCook } from "../nutrition";
import { RecipeBook, recipeNutrients, type RecipeRow } from "../recipes";
import { MAX_PIECES, parsePiece, singulars, splitOnAnd, splitText, type FoodPiece, type SetPiece, type Span } from "../router";
import { describePlanned, loadSetScope, planSet, runningOrder, sessionFor, SESSION_SET_FIELDS, stageSets, type PlannedSet, type RunningOrder, type SetScope } from "../sets";
import { readTool, writeTool, type Tool } from "../tool";
import { ExerciseIndex, storedPlates, type ExerciseRow } from "../training";
import { closeAnswered } from "../questions";
import { loadWorkouts, type WorkoutOut } from "../workouts";

const GROUP = "input";
const date = z.iso.date();

/** The most frequent key's value, entries newest first; a tie goes to the newest. */
export function usualOf<T>(entries: readonly { key: string; value: T }[]): T | null {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.key, (counts.get(e.key) ?? 0) + 1);
  let best: { key: string; value: T; n: number } | null = null;
  for (const e of entries) {
    const n = counts.get(e.key) as number;
    if (!best || n > best.n) best = { key: e.key, value: e.value, n };
  }
  return best?.value ?? null;
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface RecentFood { kind: "food_source"; name: string; ref: string; state: string; count: number; last_on: string; usual: { food: string; value: number; unit?: string; measure?: string } }
export interface RecentRecipe { kind: "recipe"; name: string; ref: string; count: number; last_on: string; usual: { recipe: string; servings: number } }
type SetLoad = "none" | { value: number; unit: "kg" | "lb"; basis: string; bar?: { value: number; unit: string }; plates?: unknown[] };
export interface RecentExercise { exercise: string; count: number; last_on: string; today: boolean; usual: { load: SetLoad | null; reps: number | null } }
export interface RecentItems { member: string; from: string; to: string; items: (RecentFood | RecentRecipe)[]; exercises: RecentExercise[] }

/** The member's recents over the `days` ending on `to`: three statements (catalogue, intake, sets), two when the catalogue is given. */
export async function recentItems(ctx: Ctx, member: Member, to: string, days: number, given?: Catalogue): Promise<RecentItems> {
  const from = addDays(to, -(days - 1));
  const cat = given ?? (await Catalogue.load(ctx));
  const intake = await all<{ source_kind: string; food_source_id: number | null; recipe_id: number | null; amount_value: number | null; amount_unit: string | null; measure_id: number | null; recipe_servings: number | null; eaten_on: string; recipe_ref: string | null; recipe_name: string | null }>(
    ctx.db,
    `SELECT i.source_kind, i.food_source_id, i.recipe_id, i.amount_value, i.amount_unit, i.measure_id, i.recipe_servings, i.eaten_on, r.ref AS recipe_ref, r.name AS recipe_name
     FROM intake_item i LEFT JOIN recipe r ON r.id = i.recipe_id
     WHERE i.member_id = ? AND i.state = 'confirmed' AND i.eaten_on BETWEEN ? AND ? AND i.source_kind IN ('food_source', 'recipe') ORDER BY i.eaten_on DESC, i.id DESC`,
    member.id, from, to,
  );
  const sets = await all<{ exercise_id: number; name: string; load_status: string; load_value: number | null; load_unit: "kg" | "lb" | null; load_basis: string | null; bar_value: number | null; bar_unit: string | null; plates: string | null; reps: number | null; performed_on: string }>(
    ctx.db,
    `SELECT st.exercise_id, e.name, st.load_status, st.load_value, st.load_unit, st.load_basis, st.bar_value, st.bar_unit, st.plates, st.reps, se.performed_on
     FROM session_set st JOIN session se ON se.id = st.session_id JOIN exercise e ON e.id = st.exercise_id
     WHERE se.member_id = ? AND st.state = 'confirmed' AND se.performed_on BETWEEN ? AND ? AND st.set_type <> 'warm_up' ORDER BY se.performed_on DESC, st.id DESC`,
    member.id, from, to,
  );

  const byId = new Map(cat.rows.map((r) => [r.id, r]));
  const groups = new Map<string, typeof intake>();
  for (const r of intake) {
    let key: string;
    if (r.source_kind === "recipe") key = `recipe:${r.recipe_id}`;
    else {
      const row = byId.get(r.food_source_id as number);
      if (!row) continue; // a food no longer in the catalogue is left out
      key = `food:${row.name.toLowerCase()}`;
    }
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }
  const items: (RecentFood | RecentRecipe)[] = [...groups.values()].map((rows) => {
    const newest = rows[0] as (typeof intake)[number];
    if (newest.source_kind === "recipe") {
      const usual = usualOf(rows.map((r) => ({ key: String(r.recipe_servings), value: r.recipe_servings as number }))) as number;
      return { kind: "recipe", name: newest.recipe_name as string, ref: newest.recipe_ref as string, count: rows.length, last_on: newest.eaten_on, usual: { recipe: newest.recipe_ref as string, servings: usual } };
    }
    const usual = usualOf(rows.map((r) => ({ key: `${r.food_source_id}|${r.amount_value}|${r.amount_unit}|${r.measure_id}`, value: r }))) as (typeof intake)[number];
    const row = byId.get(usual.food_source_id as number) as (typeof cat.rows)[number];
    const amount =
      usual.amount_unit === "measure"
        ? { value: usual.amount_value as number, measure: cat.measures.find((m) => m.id === usual.measure_id)?.name as string }
        : { value: usual.amount_value as number, unit: usual.amount_unit as string };
    return { kind: "food_source", name: row.name, ref: row.ref, state: row.state, count: rows.length, last_on: newest.eaten_on, usual: { food: row.ref, ...amount } };
  });
  items.sort((a, b) => b.count - a.count || b.last_on.localeCompare(a.last_on));

  const byExercise = new Map<number, typeof sets>();
  for (const s of sets) {
    const group = byExercise.get(s.exercise_id);
    if (group) group.push(s);
    else byExercise.set(s.exercise_id, [s]);
  }
  const loadOf = (s: (typeof sets)[number]): SetLoad | null => {
    if (s.load_status === "none") return "none";
    if (s.load_status !== "entered") return null;
    const bar = s.bar_value === null ? {} : { bar: { value: s.bar_value, unit: s.bar_unit as string } };
    const plates = s.plates ? { plates: storedPlates(s.plates) as unknown[] } : {};
    return { value: s.load_value as number, unit: s.load_unit as "kg" | "lb", basis: s.load_basis as string, ...bar, ...plates };
  };
  // Each set's load is built once; a load that is not entered (null) is the usual only when no set has an entered one.
  const usualLoad = (loads: (SetLoad | null)[]): SetLoad | null =>
    usualOf(loads.filter((l) => l !== null).map((l) => ({ key: JSON.stringify(l), value: l as SetLoad }))) ?? null;
  const exercises: RecentExercise[] = [...byExercise.values()].map((rows) => {
    const newest = rows[0] as (typeof sets)[number];
    return {
      exercise: newest.name,
      count: rows.length,
      last_on: newest.performed_on,
      today: newest.performed_on === to,
      usual: {
        load: usualLoad(rows.map(loadOf)),
        reps: usualOf(rows.filter((r) => r.reps !== null).map((r) => ({ key: String(r.reps), value: r.reps as number }))),
      },
    };
  });
  exercises.sort((a, b) => Number(b.today) - Number(a.today) || b.count - a.count || b.last_on.localeCompare(a.last_on));
  return { member: member.name, from, to, items: items.slice(0, 30), exercises: exercises.slice(0, 20) };
}

const recentItemsTool = readTool({
  name: "recent_items",
  group: GROUP,
  description:
    "A member's most-logged foods and recipes over the last days (default 30), each with its usual amount: the most frequent amount, measure and state in the window, or the last one logged when none repeats. This is what \"my usual X\" means; nothing is stored as a default. Also their most-logged exercises, those logged on the window's last day first (`today`), with the usual load and reps.",
  input: {
    member: z.string().min(1),
    days: z.number().int().min(1).max(365).optional().describe("Default 30."),
    date: date.optional().describe("The window's last day; today by default."),
  },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    return { ...(await recentItems(ctx, member, input.date ?? ctx.today(), input.days ?? 30)) };
  },
});


// ------------------------------------------------------------- route_text

/** route_text's ceiling on fuzzy name comparisons per call: each takes about 1.4 µs, and Workers Free allows 10 ms of CPU (spec §10). */
export const ROUTE_MAX_COMPARISONS = 3000;
/** Past this many characters or words, an unknown piece gets no suggestions: no name is that long, and each comparison costs more. */
const SUGGEST_MAX_CHARS = 40;
const SUGGEST_MAX_WORDS = 4;

export type SessionSetIn = z.infer<z.ZodObject<typeof SESSION_SET_FIELDS>>;
export type RouteEntry =
  | { kind: "item"; item: ItemIn }
  | { kind: "cook"; component_id: number; fraction?: number; weighed_g?: number; provenance: "estimated" }
  | { kind: "set"; set: SessionSetIn; count: number }
  | { kind: "workout"; workout_id: number; name: string };
export interface RoutePreview {
  name: string;
  detail: string;
  kcal: number | null;
  protein: number | null;
  set?: Record<string, unknown>;
}
export interface RouteOption {
  label: string;
  entry: RouteEntry;
  preview: RoutePreview;
}
export interface Suggestion {
  kind: "food_source" | "recipe" | "exercise" | "workout" | "cook";
  id: number;
  name: string;
}
/**
 * Why a piece is unresolved: no name it knows (`unknown`), no amount it can
 * read (`unreadable`), several items typed in one piece with no separator
 * (`run_together`: put a comma or a new line between them), past the text's caps (`too_long`), no usual for "my
 * usual X" (`no_usual`), or a text naming another member (`other_member`),
 * which the router never routes to the member it was asked about.
 */
export type UnresolvedReason = "unknown" | "unreadable" | "run_together" | "too_long" | "no_usual" | "other_member";
export type RoutedPiece = { span: Span } & (
  | { status: "resolved"; entry: RouteEntry; preview: RoutePreview }
  | { status: "needs_choice"; reason: string; question: string; options: RouteOption[]; partial: RouteEntry | null; field: (string | number)[] }
  /** `words`: the piece's bare words, without amount or unit, and their offsets in the text (as `span`'s), when it has any. */
  | { status: "unresolved"; reason: UnresolvedReason; suggestions: Suggestion[]; words?: Span }
);

interface TodayCook {
  cook_id: number;
  name: string;
  components: { id: number; name: string }[];
}

const nutrient = (n: NutrientTotals | null | undefined, key: string): number | null => n?.[key]?.value ?? null;
const show = (v: number) => String(Math.round(v * 100) / 100);
const ESTIMATED = { provenance: "estimated" as const, confidence: "medium" as const };
/** Implements whose loads are a total: a stack, a machine, a kettlebell, a fixed bar. */
const TOTAL_KINDS = new Set(["cable", "machine", "kettlebell", "fixed_bar", "cardio_machine", "bodyweight"]);
const BASES: Record<string, ("per_side" | "per_hand" | "total")[]> = { dumbbell: ["per_hand", "total"], barbell: ["per_side", "total"], plate_loaded: ["per_side", "total"] };
const KIND_LABEL: Record<RouteEntry["kind"], string> = { item: "", cook: "today's pot: ", set: "a set: ", workout: "the workout " };
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;

function choice(span: Span, reason: string, question: string, options: RouteOption[], partial: RouteEntry | null = null, field: (string | number)[] = []): RoutedPiece {
  return { span, status: "needs_choice", reason, question, options, partial, field };
}

/**
 * Where a piece's bare words sit in the text: from the first word to the
 * last, as typed (case and script kept), with offsets as the span's. The
 * grammar's words are the piece's tokens in order, lowercased, so each is
 * found after the one before it, standing alone (not inside a longer word).
 * Undefined when the piece has no words, one can't be found as typed, or
 * anything but whitespace (an amount, a unit, a filler) sits between
 * two of them: taught as an alias, that span could never match.
 */
export function wordsSpan(span: Span, words: readonly string[]): Span | undefined {
  if (words.length === 0) return undefined;
  const hay = span.text.toLowerCase();
  if (hay.length !== span.text.length) return undefined;
  let from = 0;
  let start = -1;
  for (const w of words) {
    let at = hay.indexOf(w, from);
    while (at >= 0 && (WORD_CHAR.test(hay[at - 1] ?? "") || WORD_CHAR.test(hay[at + w.length] ?? ""))) at = hay.indexOf(w, at + 1);
    if (at < 0) return undefined;
    // Words split by anything but whitespace ("paneer 200 g bhurji", "pb with ghee") are not a word
    // the router could ever read back as typed: no words, so nothing unmatchable is taught.
    if (start >= 0 && !/^\s+$/.test(hay.slice(from, at))) return undefined;
    if (start < 0) start = at;
    from = at + w.length;
  }
  return { text: span.text.slice(start, from), start: span.start + start, end: span.start + from };
}

/** The words of a parsed piece, or none for an unreadable one. */
const wordsOf = (span: Span): string[] => {
  const p = parsePiece(span);
  return p.kind === "unreadable" ? [] : p.words;
};

/** One call's router: every table loaded once, then each piece resolved in memory (spec §7). */
class Router {
  comparisons = 0;
  setNames: string[] = [];
  private recents: RecentItems | null = null;
  private pots: Map<number, LoadedCook> | null = null;
  /** The set scope, or the question finding the session asked, worked out once per call. */
  private scope: { scope: SetScope; running: RunningOrder } | Clarify | null = null;
  /** Unknown pieces' searches, run only for the pieces the call keeps (suggestFor), never for a whole its parts replaced. */
  private readonly pending = new WeakMap<RoutedPiece, { query: string; kinds: Suggestion["kind"][] | undefined }>();

  private constructor(
    readonly ctx: Ctx,
    readonly member: Member,
    readonly date: string,
    /** The meal the text is for, when given; a previewed share's item carries it. */
    readonly slot: string | null,
    readonly cat: Catalogue,
    readonly book: RecipeBook,
    readonly exercises: ExerciseIndex,
    readonly workouts: WorkoutOut[],
    readonly cooks: TodayCook[],
  ) {}

  /** Five statements: the catalogue, the recipe book, the exercises, the workouts and today's cooks. */
  static async load(ctx: Ctx, member: Member, date: string, slot: string | null): Promise<Router> {
    const cat = await Catalogue.load(ctx);
    const book = await RecipeBook.load(ctx);
    const exercises = await ExerciseIndex.load(ctx);
    const workouts = await loadWorkouts(ctx, member.id);
    // Today's cooks, chosen as day_cooks chooses them: the household's meals eaten on the date.
    const cooks = (
      await all<{ cook_id: number; name: string; components: string }>(
        ctx.db,
        `SELECT k.id AS cook_id, k.name,
           (SELECT json_group_array(json_object('id', c.id, 'name', c.name)) FROM component c WHERE c.cook_id = k.id) AS components
         FROM household_meal m JOIN household_meal_cook hc ON hc.household_meal_id = m.id JOIN cook k ON k.id = hc.cook_id
         WHERE m.household_id = ? AND m.eaten_on = ? ORDER BY m.id, k.id`,
        ctx.householdId,
        date,
      )
    ).map((c) => ({ cook_id: c.cook_id, name: c.name, components: JSON.parse(c.components) as { id: number; name: string }[] }));
    return new Router(ctx, member, date, slot, cat, book, exercises, workouts, cooks);
  }

  async route(span: Span): Promise<RoutedPiece> {
    const parsed = parsePiece(span);
    if (parsed.kind === "unreadable") {
      return { span, status: "unresolved", reason: parsed.why === "several" ? "run_together" : "unreadable", suggestions: [] };
    }
    if (parsed.kind === "set") return this.routeSet(span, parsed);
    return this.routeFood(parsed);
  }

  // ---------------------------------------------------------------- names

  /** The food sources a word names: by name, or the one its ref or learned word pins. */
  private foodRows(v: string): SourceRow[] {
    const pinned = this.cat.pinned(v);
    if (pinned) return [pinned];
    return this.cat.rows.filter((r) => r.name.toLowerCase() === v);
  }

  /** The food the words name, or, for "katori dal", a measure word and the food it measures. */
  private foodNamed(words: string[]): { food: string; measure: string | null } | null {
    for (const v of singulars(words.join(" "))) if (this.foodRows(v).length > 0) return { food: v, measure: null };
    const [first, ...rest] = words;
    if (first === undefined || rest.length === 0) return null;
    for (const v of singulars(rest.join(" "))) {
      const ids = new Set(this.foodRows(v).map((r) => r.id));
      const measure = this.cat.measures.find((m) => ids.has(m.food_source_id) && singulars(first).includes(m.name.toLowerCase()));
      if (measure) return { food: v, measure: measure.name };
    }
    return null;
  }

  private recipeNamed(name: string): RecipeRow | null {
    for (const v of singulars(name)) {
      const r = this.book.find(v);
      if (r && r.kind === "dish") return r;
    }
    return null;
  }

  private cookNamed(name: string): TodayCook | null {
    for (const v of singulars(name)) {
      const c = this.cooks.find((k) => k.name.toLowerCase() === v);
      if (c) return c;
    }
    return null;
  }

  private workoutNamed(name: string): WorkoutOut | null {
    for (const v of singulars(name)) {
      const w = this.workouts.find((x) => x.name.toLowerCase() === v || x.aliases.some((a) => a.toLowerCase() === v));
      if (w) return w;
    }
    return null;
  }

  exerciseNamed(name: string): ExerciseRow | null {
    for (const v of singulars(name)) {
      const e = this.exercises.lookup(v);
      if (e) return e;
    }
    return null;
  }

  /**
   * Up to five names close to the query, within the call's comparison
   * ceiling: the query is normalised once, a candidate's names are built
   * only when they fit, and the search stops at the first that doesn't.
   */
  private suggest(query: string, kinds?: Suggestion["kind"][]): Suggestion[] {
    const q = query.trim();
    if (!q || q.length > SUGGEST_MAX_CHARS || q.split(/\s+/).length > SUGGEST_MAX_WORDS) return [];
    const pq = prepareQuery(q);
    const scored: { score: number; s: Suggestion }[] = [];
    const want = (kind: Suggestion["kind"]) => !kinds || kinds.includes(kind);
    function* candidates(this: Router): Generator<[Suggestion, () => string[]]> {
      if (want("food_source")) for (const r of this.cat.rows) yield [{ kind: "food_source", id: r.id, name: `${r.name} (${r.state})` }, () => [r.name, r.ref, ...this.cat.aliasesOf(r.id)]];
      if (want("recipe")) for (const r of this.book.recipes) if (r.kind === "dish") yield [{ kind: "recipe", id: r.id, name: r.name }, () => [r.name, r.ref, ...r.aliases]];
      if (want("exercise")) for (const e of this.exercises.entries) yield [{ kind: "exercise", id: e.id, name: e.name }, () => [e.name, ...e.aliases]];
      if (want("workout")) for (const w of this.workouts) yield [{ kind: "workout", id: w.id, name: w.name }, () => [w.name, ...w.aliases]];
      if (want("cook")) for (const c of this.cooks) yield [{ kind: "cook", id: c.cook_id, name: c.name }, () => [c.name]];
    }
    for (const [s, namesOf] of candidates.call(this)) {
      if (this.comparisons >= ROUTE_MAX_COMPARISONS) break;
      const names = namesOf();
      if (this.comparisons + names.length > ROUTE_MAX_COMPARISONS) break;
      this.comparisons += names.length;
      const score = bestScore(pq, names);
      if (score > 0) scored.push({ score, s });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 5).map((x) => x.s);
  }

  private unresolved(span: Span, reason: "unknown" | "no_usual", words: string[], kinds?: Suggestion["kind"][]): RoutedPiece {
    const at = wordsSpan(span, words);
    const piece: RoutedPiece = { span, status: "unresolved", reason, suggestions: [], ...(at ? { words: at } : {}) };
    if (reason === "unknown") this.pending.set(piece, { query: words.join(" "), kinds });
    return piece;
  }

  /** A kept piece with its suggestions, searched now, in the text's order, within the call's ceiling. */
  suggestFor(piece: RoutedPiece): RoutedPiece {
    const p = this.pending.get(piece);
    return p && piece.status === "unresolved" ? { ...piece, suggestions: this.suggest(p.query, p.kinds) } : piece;
  }

  private async recent(): Promise<RecentItems> {
    this.recents ??= await recentItems(this.ctx, this.member, this.date, 30, this.cat);
    return this.recents;
  }

  // ----------------------------------------------------------------- food

  private async routeFood(p: FoodPiece): Promise<RoutedPiece> {
    const span = p.span;
    const name = p.words.join(" ");
    if (!name) return { span, status: "unresolved", reason: "unknown", suggestions: [] };
    if (p.usual) return this.routeUsual(p, name);
    const cook = this.cookNamed(name);
    if (p.the) return cook ? this.routeCook(p, cook) : this.unresolved(span, "unknown", p.words, ["cook"]);
    const meanings: RoutedPiece[] = [];
    const food = this.foodNamed(p.words);
    if (food) meanings.push(await this.routeFoodSource(p, food.food, food.measure));
    const recipe = this.recipeNamed(name);
    if (recipe) meanings.push(await this.routeRecipe(p, recipe));
    if (cook) meanings.push(await this.routeCook(p, cook));
    const workout = this.workoutNamed(name);
    if (workout && p.amount === null) meanings.push(this.routeWorkout(span, workout));
    if (this.exerciseNamed(name)) {
      const load = p.amount && p.unit === "kg" ? { value: p.amount.value, unit: "kg" as const } : null;
      meanings.push(await this.routeSet(span, { kind: "set", span, words: p.words, load, reps: null, rir: null, sets: 1 }));
    }
    if (meanings.length === 0) return this.unresolved(span, "unknown", p.words);
    if (meanings.length === 1) return meanings[0] as RoutedPiece;
    // Several things go by this name: never pick one (spec §1).
    const options = meanings.flatMap((m) =>
      m.status === "resolved" ? [{ label: `${KIND_LABEL[m.entry.kind]}${m.preview.name} (${m.preview.detail})`, entry: m.entry, preview: m.preview }] : m.status === "needs_choice" ? m.options : [],
    );
    return choice(span, "which_meaning", `"${span.text}" could mean ${meanings.length} things. Which is it?`, options);
  }

  private foodOption(span: Span, input: AmountIn): RouteOption {
    const r = this.cat.resolve(input, ["item"]);
    const item = { source: "food" as const, ...input, ...ESTIMATED, label: span.text } as ItemIn;
    const detail = `${show(input.value)} ${input.measure ?? input.unit}`;
    const preview = { name: `${r.row.name} (${r.row.state})`, detail, kcal: nutrient(r.nutrients, "kcal"), protein: nutrient(r.nutrients, "protein") };
    return { label: `${preview.name}, ${detail}`, entry: { kind: "item", item }, preview };
  }

  /** Each amount tried through the catalogue: a state or measure question expands into its options; any other question is kept. */
  private tryAmounts(span: Span, tries: AmountIn[]): { options: RouteOption[]; ask: Clarify | null } {
    const options: RouteOption[] = [];
    let ask: Clarify | null = null;
    const attempt = (input: AmountIn, expand: boolean) => {
      try {
        options.push(this.foodOption(span, input));
      } catch (error) {
        if (!(error instanceof Clarify)) throw error;
        if (expand && (error.reason === "ambiguous_state" || error.reason === "unknown_state")) {
          // In the catalogue's order (Rice dry, then cooked), not the domain's.
          const at = (s: unknown) => this.cat.rows.findIndex((r) => r.name.toLowerCase() === input.food.trim().toLowerCase() && r.state === s);
          const states = [...error.options].sort((a, b) => at(a) - at(b));
          for (const s of states) attempt({ ...input, state: s as AmountIn["state"] }, false);
        } else if (expand && error.reason === "unknown_measure") {
          for (const m of error.options) attempt({ ...input, measure: String(m) }, false);
        } else ask ??= error;
      }
    };
    for (const t of tries) attempt(t, true);
    return { options, ask };
  }

  private async routeFoodSource(p: FoodPiece, food: string, measure: string | null): Promise<RoutedPiece> {
    const span = p.span;
    const base = { food, ...(p.state ? { state: p.state } : {}) };
    const rows = this.foodRows(food);
    const ids = new Set(rows.map((r) => r.id));
    const measures = [...new Map(this.cat.measures.filter((m) => ids.has(m.food_source_id)).map((m) => [m.name.toLowerCase(), m.name])).values()];
    const value = p.amount?.value ?? null;
    const tries: AmountIn[] = [];
    let certain = false;
    if (value === null) {
      // No amount: the member's usual and one of each measure. Never a made-up weight.
      const usual = (await this.recent()).items.find((i) => i.kind === "food_source" && rows.some((r) => r.name.toLowerCase() === i.name.toLowerCase()));
      if (usual && usual.kind === "food_source") tries.push({ ...usual.usual, ...(p.state ? { state: p.state } : {}) } as AmountIn);
      for (const m of measure ? [measure] : measures) tries.push({ ...base, value: 1, measure: m });
    } else if (measure !== null) {
      tries.push({ ...base, value, measure });
      certain = true;
    } else if (p.unit !== null) {
      tries.push({ ...base, value, unit: p.unit });
      certain = true;
    } else {
      const named = measures.find((m) => singulars(p.words.at(-1) ?? "").includes(m.toLowerCase()));
      if (named) {
        tries.push({ ...base, value, measure: named });
        certain = true;
      } else if (rows.length > 0 && rows.every((r) => r.reference_unit === "piece")) {
        tries.push({ ...base, value, unit: "piece" });
        certain = true;
      } else {
        for (const m of measures) tries.push({ ...base, value, measure: m });
        tries.push({ ...base, value, unit: rows.every((r) => r.reference_unit === "ml") ? "ml" : "g" });
      }
    }
    const { options, ask } = this.tryAmounts(span, tries);
    if (certain && tries.length === 1 && options.length === 1) {
      const only = options[0] as RouteOption;
      return { span, status: "resolved", entry: only.entry, preview: only.preview };
    }
    // Certain of the amount but not the state (or measure): ask which; unsure of the amount: ask how much.
    if (options.length > 0) return certain ? choice(span, "ambiguous_state", `Which ${food}?`, options) : choice(span, "amount", `How much ${food}?`, options);
    const partial: RouteEntry = { kind: "item", item: { source: "food", ...base, value: value ?? 1, ...ESTIMATED, label: span.text } as ItemIn };
    if (ask) return choice(span, ask.reason, ask.question, [], partial, ask.path);
    return choice(span, "amount", `How much ${food}?`, [], partial, ["item", "value"]);
  }

  private async routeRecipe(p: FoodPiece, recipe: RecipeRow): Promise<RoutedPiece> {
    const span = p.span;
    const option = (servings: number): RouteOption => {
      const n = recipeNutrients(this.cat, recipe, this.book.lines(recipe.id), servings);
      const preview = { name: recipe.name, detail: `${show(servings)} serving${servings === 1 ? "" : "s"}`, kcal: nutrient(n, "kcal"), protein: nutrient(n, "protein") };
      return { label: `${recipe.name}, ${preview.detail}`, entry: { kind: "item", item: { source: "recipe", recipe: recipe.ref, servings, ...ESTIMATED, label: span.text } as ItemIn }, preview };
    };
    if (p.unit !== null) {
      return choice(span, "servings", `How many servings of ${recipe.name}?`, [], { kind: "item", item: { source: "recipe", recipe: recipe.ref, servings: 1, ...ESTIMATED, label: span.text } as ItemIn }, ["item", "servings"]);
    }
    if (p.amount) {
      const only = option(p.amount.value);
      return { span, status: "resolved", entry: only.entry, preview: only.preview };
    }
    const usual = (await this.recent()).items.find((i) => i.kind === "recipe" && i.ref === recipe.ref);
    const servings = [...new Set([...(usual && usual.kind === "recipe" ? [usual.usual.servings] : []), 1])];
    return choice(span, "amount", `How much ${recipe.name}?`, servings.map(option));
  }

  private async routeCook(p: FoodPiece, cook: TodayCook): Promise<RoutedPiece> {
    const span = p.span;
    const ask = (question: string, field: (string | number)[], reason = "amount", component = cook.components[0]) =>
      choice(span, reason, question, [], component ? { kind: "cook", component_id: component.id, provenance: "estimated" } : null, field);
    if (cook.components.length !== 1) return ask(`Which part of ${cook.name}?`, ["component_id"], "component_needed");
    const component = cook.components[0] as { id: number; name: string };
    let amount: { fraction?: number; weighed_g?: number };
    if (p.amount && p.unit === null && (p.amount.kind === "fraction" || p.amount.value <= 1)) amount = { fraction: p.amount.value };
    else if (p.amount && (p.unit === "g" || p.unit === "kg")) amount = { weighed_g: p.unit === "kg" ? p.amount.value * 1000 : p.amount.value };
    else return ask(`How much of the ${cook.name}: a share or grams?`, ["fraction"]);
    this.pots ??= await loadCooks(this.ctx, this.cat, this.cooks.map((c) => c.cook_id));
    const loaded = this.pots.get(cook.cook_id) as LoadedCook;
    const entry: RouteEntry = { kind: "cook", component_id: component.id, ...amount, provenance: "estimated" };
    // The share rule is mark_remainder's and commit_route's own (planEatenPortion), with preview ids
    // and a copy of the pot's portions: each piece is previewed alone, and nothing is staged.
    let planned: Awaited<ReturnType<typeof planEatenPortion>>;
    try {
      planned = await planEatenPortion(
        this.ctx, this.cat, { ...loaded, portions: [...loaded.portions] }, component, this.member,
        { fraction: amount.fraction ?? null, weighed_g: amount.weighed_g ?? null },
        { eaten_on: this.date, meal_slot: this.slot, household_meal_id: null },
        "estimated", [], previewIds(),
      );
    } catch (error) {
      if (error instanceof Clarify) return choice(span, error.reason, error.question, [], entry, error.path);
      throw error;
    }
    const n = planned.nutrients;
    const detail = amount.fraction !== undefined ? `${Math.round(amount.fraction * 100)}% of the pot` : `${show(amount.weighed_g as number)} g`;
    return { span, status: "resolved", entry, preview: { name: cook.name, detail, kcal: nutrient(n, "kcal"), protein: nutrient(n, "protein") } };
  }

  private async routeUsual(p: FoodPiece, name: string): Promise<RoutedPiece> {
    const span = p.span;
    const foodNames = new Set(singulars(name).flatMap((v) => this.foodRows(v).map((r) => r.name.toLowerCase())));
    const recipeRef = this.recipeNamed(name)?.ref;
    const hit = (await this.recent()).items.find((i) => (i.kind === "food_source" ? foodNames.has(i.name.toLowerCase()) : i.ref === recipeRef));
    if (!hit) return this.unresolved(span, "no_usual", p.words);
    if (hit.kind === "recipe") {
      const recipe = this.book.find(hit.ref) as RecipeRow;
      return this.routeRecipe({ ...p, usual: false, amount: { kind: "count", value: hit.usual.servings }, unit: null }, recipe);
    }
    const { options } = this.tryAmounts(span, [hit.usual as AmountIn]);
    const only = options[0];
    return only ? { span, status: "resolved", entry: only.entry, preview: only.preview } : this.unresolved(span, "no_usual", p.words);
  }

  private routeWorkout(span: Span, w: WorkoutOut): RoutedPiece {
    return { span, status: "resolved", entry: { kind: "workout", workout_id: w.id, name: w.name }, preview: { name: w.name, detail: `${w.lines.length} exercise${w.lines.length === 1 ? "" : "s"}`, kcal: null, protein: null } };
  }

  // ------------------------------------------------------------------ sets

  /** The member's session that day and the set scope, once per call; a question it asks (two sessions) is asked of every set without asking the database again. */
  private async setScope(): Promise<{ scope: SetScope; running: RunningOrder }> {
    if (!this.scope) {
      try {
        const target = await sessionFor(this.ctx, { member: this.member.name, date: this.date }, { template: "next", workout: null }, false);
        const scope = await loadSetScope(this.ctx, target.session, { fresh: target.fresh, names: this.setNames, ...(target.prescriptions ? { prescriptions: target.prescriptions } : {}) });
        this.scope = { scope, running: runningOrder(scope.existing) };
      } catch (error) {
        if (!(error instanceof Clarify)) throw error;
        this.scope = error;
      }
    }
    if (this.scope instanceof Clarify) throw this.scope;
    return this.scope;
  }

  private async routeSet(span: Span, s: SetPiece): Promise<RoutedPiece> {
    const name = s.words.join(" ");
    const exercise = this.exerciseNamed(name);
    if (!exercise) return this.unresolved(span, "unknown", s.words, ["exercise"]);
    const base = { exercise: exercise.name, set_type: "working" as const, ...(s.reps !== null ? { reps: s.reps } : {}), ...(s.rir ? { rir: s.rir } : {}) };
    const bases = (kind: string) => (TOTAL_KINDS.has(kind) ? ["total" as const] : (BASES[kind] ?? ["total", "per_side", "per_hand"]));
    let loads: SessionSetIn["load"][] = [];
    if (s.load === "bodyweight") loads = ["none"];
    else if (s.load === null) loads = exercise.implement_kind === "bodyweight" ? ["none"] : [];
    else {
      const value = s.load.value;
      for (const unit of s.load.unit ? [s.load.unit] : (["kg", "lb"] as const)) for (const basis of bases(exercise.implement_kind)) loads.push({ value, unit, basis });
    }
    const partial = (set: SessionSetIn): RouteEntry => ({ kind: "set", set, count: s.sets });
    if (loads.length === 0) return choice(span, "load_needed", `What load was the ${exercise.name} done with?`, [], partial(base as SessionSetIn), ["set", "load"]);
    if (s.reps === null) return choice(span, "reps_needed", `How many reps of ${exercise.name}?`, [], partial({ ...base, load: loads[0] } as SessionSetIn), ["set", "reps"]);
    let scoped: { scope: SetScope; running: RunningOrder };
    try {
      scoped = await this.setScope();
    } catch (error) {
      if (error instanceof Clarify) return choice(span, error.reason, error.question, [], partial({ ...base, load: loads[0] } as SessionSetIn), error.path);
      throw error;
    }
    const options: RouteOption[] = [];
    let ask: Clarify | null = null;
    for (const load of loads) {
      const set = { ...base, load } as SessionSetIn;
      try {
        const running = { end: scoped.running.end, setNumbers: new Map(scoped.running.setNumbers) };
        const planned = await planSet(this.ctx, scoped.scope, set, running, ["set"]);
        const d = describePlanned(planned, null);
        const loadText = load === "none" ? "bodyweight" : load && typeof load === "object" ? `${show(load.value as number)} ${load.unit} ${String(load.basis).replace("_", " ")}` : "";
        const detail = `${s.sets > 1 ? `${s.sets} × ` : ""}${s.reps} reps, ${loadText}`;
        options.push({ label: `${exercise.name}, ${detail}`, entry: { kind: "set", set, count: s.sets }, preview: { name: exercise.name, detail, kcal: null, protein: null, set: { ...d, state: planned.row.state } } });
      } catch (error) {
        if (!(error instanceof Clarify)) throw error;
        ask ??= error;
      }
    }
    if (options.length === 1 && loads.length === 1) {
      const only = options[0] as RouteOption;
      return { span, status: "resolved", entry: only.entry, preview: only.preview };
    }
    if (options.length > 0) return choice(span, s.load !== null && s.load !== "bodyweight" && s.load.unit === null ? "load_unit" : "load_basis", `Which load was the ${exercise.name}?`, options);
    const first = ask as Clarify;
    return choice(span, first.reason, first.question, [], partial({ ...base, load: loads[0] } as SessionSetIn), first.path);
  }
}

/** The household's other members whose names the text uses, as a whole word, ignoring case. */
function otherMembersNamed(text: string, members: readonly Member[], member: Member): string[] {
  const lower = text.toLowerCase();
  return members
    .filter((m) => m.id !== member.id)
    .filter((m) => {
      const name = m.name.trim().toLowerCase();
      if (!name) return false;
      for (let at = lower.indexOf(name); at >= 0; at = lower.indexOf(name, at + 1)) {
        if (!WORD_CHAR.test(lower[at - 1] ?? "") && !WORD_CHAR.test(lower[at + name.length] ?? "")) return true;
      }
      return false;
    })
    .map((m) => m.name);
}

const routeText = readTool({
  name: "route_text",
  group: GROUP,
  description:
    "Turn a member's free text into pieces without writing anything: each is resolved (with its preview from the API), needs a choice (with every option complete; nothing is guessed), or unresolved (the span, with close names, and the bare words without the amount). Reads amounts, fractions, units, measures, states, names and learned words, \"my usual X\" (recent_items), \"the X\" (today's pot), workout names (to pre-fill the workout) and set shorthand (\"bench 40kg x 8 rir 2\"). Every piece is for the member given: a text that names another member of the household comes back unresolved (other_member), never routed to the wrong member. Several items typed with no separator (\"2 eggs 1 tomato 10 g peas\") come back as one unresolved piece (run_together): a comma or a new line between them reads each. Past 1,000 characters or 20 pieces, the rest is one unresolved span. Save the pieces with commit_route; send the rest to the Inbox with submit_to_inbox.",
  input: {
    member: z.string().min(1),
    text: z.string().max(5000),
    date,
    meal_slot: z.enum(MEAL_SLOTS).optional(),
  },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    await ctx.previewWrite();
    const { spans, overflow } = splitText(input.text);
    const tooLong = (tail: Span | null): RoutedPiece[] => (tail ? [{ span: tail, status: "unresolved", reason: "too_long", suggestions: [] }] : []);
    const out = (pieces: RoutedPiece[], comparisons: number) => ({ member: member.name, date: input.date, meal_slot: input.meal_slot ?? null, pieces, comparisons });
    // A text about someone else is never routed to this member, not even the pieces that don't name them
    // ("Asha, half the dal"): every piece goes back unresolved, for the "for" chip or Claude.
    if (otherMembersNamed(input.text, await ctx.members(), member).length > 0) {
      const pieces = spans.map((span): RoutedPiece => {
        const at = wordsSpan(span, wordsOf(span));
        return { span, status: "unresolved", reason: "other_member", suggestions: [], ...(at ? { words: at } : {}) };
      });
      return out([...pieces, ...tooLong(overflow)], 0);
    }
    const router = await Router.load(ctx, member, input.date, input.meal_slot ?? null);
    // The exercises the text names, so the set scope reads their history once.
    // (and of each piece's " and " parts, which may be routed instead of the whole).
    const names = new Set<string>();
    for (const sp of spans) {
      for (const part of /\sand\s/i.test(sp.text) ? [sp, ...splitOnAnd(sp)] : [sp]) {
        const p = parsePiece(part);
        const name = p.kind === "unreadable" ? "" : p.words.join(" ");
        if (name && (p.kind === "set" || router.exerciseNamed(name))) names.add(name);
      }
    }
    router.setNames = [...names];
    const pieces: RoutedPiece[] = [];
    // The work is bounded by the pieces kept: once past twenty, the rest is the too_long span, unrouted.
    const unrouted = (span: Span): RoutedPiece => ({ span, status: "unresolved", reason: "too_long", suggestions: [] });
    for (const span of spans) {
      if (pieces.length > MAX_PIECES) break;
      const whole = await router.route(span);
      // Names nothing as a whole, or reads two amounts ("2 eggs and 100 g curd"): tried as its parts.
      if (/\sand\s/i.test(span.text) && whole.status === "unresolved" && (whole.reason === "unknown" || whole.reason === "unreadable" || whole.reason === "run_together")) {
        const parts: RoutedPiece[] = [];
        for (const part of splitOnAnd(span)) parts.push(pieces.length + parts.length > MAX_PIECES ? unrouted(part) : await router.route(part));
        if (parts.length > 1 && parts.some((r) => r.status !== "unresolved")) {
          pieces.push(...parts);
          continue;
        }
      }
      pieces.push(whole);
    }
    const kept = pieces.slice(0, MAX_PIECES).map((p) => router.suggestFor(p));
    const cut = pieces[MAX_PIECES];
    // Pieces past twenty after a split on " and ": the rest of the text, from the first of them, is one span.
    const rest = cut ? input.text.slice(cut.span.start).trim() : "";
    const tail = cut ? { text: rest, start: cut.span.start, end: cut.span.start + rest.length } : overflow;
    return out([...kept, ...tooLong(tail)], router.comparisons);
  },
});

// ----------------------------------------------------------- commit_route

const COMMIT_ENTRY = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("item"), item: ITEM }).strict(),
  z
    .object({
      kind: z.literal("cook"),
      component_id: z.number().int().positive(),
      fraction: z.number().gt(0).max(1).optional(),
      weighed_g: z.number().positive().optional(),
      provenance: z.enum(PROVENANCE),
    })
    .strict(),
  z.object({ kind: z.literal("set"), set: z.object(SESSION_SET_FIELDS).strict(), count: z.number().int().min(1).max(10) }).strict(),
]);

/**
 * Rows given every column any of them has, the missing ones null, so
 * createMany inserts them in one statement (it groups rows by key set).
 * Only for a table whose columns a row may leave out all default to NULL,
 * as intake_item's do (its state is always given): a food item, a recipe,
 * a manual item and a portion's item are then one statement, not four.
 */
function sameShape(rows: readonly Row[]): Row[] {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k] ?? null])));
}

const commitRoute = writeTool({
  name: "commit_route",
  group: GROUP,
  description:
    "Save routed free text in one write: every piece (intake items, shares of today's pot, sets into the member's strength session that day, found or created) lands together or not at all; any question (it says which piece) writes nothing. Every piece is for the member given (drafts when that is not the caller). Each piece says whether the member edited it (false only when it was saved exactly as route_text resolved it); a member's app call records how many were saved unedited and edited (the router's measure), an agent's call records nothing.",
  input: {
    member: z.string().min(1),
    date,
    meal_slot: z.enum(MEAL_SLOTS).optional().describe("Required when a piece is food or a share of a pot."),
    session_id: z.number().int().positive().optional().describe("For sets, when the member has several sessions that day."),
    pieces: z.array(z.object({ entry: COMMIT_ENTRY, edited: z.boolean() }).strict()).min(1).max(MAX_PIECES),
  },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    ctx.onBehalfOf(member.id);
    const tx = ctx.txOrThrow;
    type Entry = z.infer<typeof COMMIT_ENTRY>;
    const pick = <K extends Entry["kind"]>(kind: K) =>
      input.pieces.flatMap((p, i) => (p.entry.kind === kind ? [{ i, entry: p.entry as Extract<Entry, { kind: K }> }] : []));
    const items = pick("item");
    const shares = pick("cook");
    const sets = pick("set");
    const slot = input.meal_slot;
    if ((items.length > 0 || shares.length > 0) && slot === undefined) throw new Clarify("meal_slot_needed", "Which meal was it?", [...MEAL_SLOTS], ["meal_slot"]);
    // Every table's next id in one statement (decision 97), so planning and staging allocate without reading.
    await tx.reserve(["intake_item", ...(shares.length > 0 ? ["portion"] : []), ...(sets.length > 0 ? ["session", "session_set"] : [])]);

    // 1. Plan every piece before staging anything: any question writes nothing.
    const cat = items.length > 0 || shares.length > 0 ? await Catalogue.load(ctx) : null;
    const book = await RecipeBook.forItems(ctx, items.map((x) => x.entry.item));
    const resolved: Awaited<ReturnType<typeof resolveItem>>[] = [];
    for (const { i, entry } of items) resolved.push(await resolveItem(ctx, cat as Catalogue, entry.item, ["pieces", i, "entry", "item"], book));

    const portions: Awaited<ReturnType<typeof planEatenPortion>>[] = [];
    const componentNames = new Map<number, string>();
    if (shares.length > 0) {
      // Each component's cook, and the household meal its item belongs to: only a meal of this cook on the
      // piece's date and slot (a dinner share of lunch's pot is no part of lunch), else none. One statement.
      const owners = await allIn<{ component_id: number; component: string; cook_id: number; meal_id: number | null }>(
        ctx.db,
        (ph) =>
          `SELECT c.id AS component_id, c.name AS component, c.cook_id,
             (SELECT m.id FROM household_meal_cook hc JOIN household_meal m ON m.id = hc.household_meal_id
               WHERE hc.cook_id = c.cook_id AND m.eaten_on = ? AND m.meal_slot = ? ORDER BY m.id DESC LIMIT 1) AS meal_id
           FROM component c JOIN cook k ON k.id = c.cook_id WHERE k.household_id = ? AND c.id IN (${ph})`,
        shares.map((s) => s.entry.component_id),
        input.date,
        slot as string,
        ctx.householdId,
      );
      for (const o of owners) componentNames.set(o.component_id, o.component);
      const pots = await loadCooks(ctx, cat as Catalogue, [...new Set(owners.map((o) => o.cook_id))]);
      for (const { i, entry } of shares) {
        const owner = owners.find((o) => o.component_id === entry.component_id);
        if (!owner) throw new ToolError("not_found", `no component ${entry.component_id}`, 404, { index: i });
        if ((entry.fraction === undefined) === (entry.weighed_g === undefined)) {
          throw new Clarify("share_needed", "Give the share as a fraction or a weighed amount.", [], ["pieces", i, "entry"]);
        }
        // The one rule for a later share of a pot (decision 103), with this write's ids:
        // a second portion of a component asks, and so do shares past the whole.
        portions.push(
          await planEatenPortion(
            ctx, cat as Catalogue, pots.get(owner.cook_id) as LoadedCook, { id: owner.component_id, name: owner.component }, member,
            { fraction: entry.fraction ?? null, weighed_g: entry.weighed_g ?? null },
            { eaten_on: input.date, meal_slot: slot as string, household_meal_id: owner.meal_id },
            entry.provenance, ["pieces", i, "entry"], tx,
          ),
        );
      }
    }

    let setsOut: Record<string, unknown> | null = null;
    if (sets.length > 0) {
      const target = await sessionFor(
        ctx,
        input.session_id !== undefined ? { session_id: input.session_id } : { member: member.name, date: input.date },
        { template: "next", workout: null },
        true,
      );
      // Never a piece for anyone but the member given.
      if (target.session.member_id !== member.id) throw new ToolError("not_this_member", `session ${input.session_id} is not ${member.name}'s`, 400);
      const scope = await loadSetScope(ctx, target.session, {
        fresh: target.fresh,
        names: sets.map((s) => s.entry.set.exercise),
        ...(target.prescriptions ? { prescriptions: target.prescriptions } : {}),
      });
      const running = runningOrder(scope.existing);
      const planned: PlannedSet[] = [];
      for (const { i, entry } of sets) for (let n = 0; n < entry.count; n++) planned.push(await planSet(ctx, scope, entry.set, running, ["pieces", i, "entry", "set"]));
      const staged = await stageSets(ctx, scope, planned);
      setsOut = { session: { id: target.session.id, created: target.created, template: target.template, workout: target.workout }, sets: staged.sets };
    }

    // 2. Stage: the portions, then every intake item (direct and the portions') with createMany:
    // one statement per row shape, however many pieces (decisions 97, 103).
    const stamp = ctx.stamp(ctx.stateFor(member.id));
    await tx.createMany("portion", portions.map((p) => p.portion));
    const rows: Row[] = [
      ...resolved.map((r) => ({ member_id: member.id, eaten_on: input.date, meal_slot: slot, ...r.columns, ...stamp })),
      ...portions.map((p) => p.item),
    ];
    const ids = await tx.createMany("intake_item", sameShape(rows));

    // 3. The router's measure: a member's app write only; agent calls are excluded (spec §7).
    let stats: { unedited: number; edited: number } | null = null;
    if (ctx.caller.kind === "member") {
      const unedited = input.pieces.filter((p) => !p.edited).length;
      stats = { unedited, edited: input.pieces.length - unedited };
      tx.raw("route_stat", { member_id: ctx.caller.memberId, write_id: tx.writeId, recorded_on: ctx.today(), unedited: stats.unedited, edited: stats.edited, inbox: 0 });
    }

    return {
      items: resolved.map((r, k) =>
        describeItem(
          cat as Catalogue,
          { id: ids[k], member_id: member.id, eaten_on: input.date, meal_slot: slot, ...r.columns, ...stamp, recipe_ref: r.display.ref, recipe_name: r.display.name },
          r.nutrients,
          member.name,
        ),
      ),
      portions: portions.map((p, k) => ({
        id: p.portion.id, component_id: p.portion.component_id, component: componentNames.get(p.portion.component_id) ?? null,
        fraction: p.portion.fraction, weighed_g: p.portion.weighed_g, state: p.portion.state, intake_item_id: ids[resolved.length + k], nutrients: p.nutrients,
      })),
      sets: setsOut,
      stats,
    };
  },
});


// ------------------------------------------------------------------ inbox

const SPAN = z.object({ text: z.string().min(1), start: z.number().int().min(0), end: z.number().int().min(1) }).strict();

interface InboxRow {
  id: number;
  member: string;
  entry_on: string;
  meal_slot: string | null;
  text: string;
  spans: string;
  status: string;
  resolution_note: string | null;
  records: string | null;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  resolved_at: string | null;
  member_id: number;
}

/** Tables an Inbox resolution (or a routed write) can create rows in. */
const RESOLUTION_TABLES = ["intake_item", "portion", "session", "session_set", "cardio_block", "reading", "blood_draw", "lab_result", "food_source", "recipe", "measure", "yield", "leftover_serving", "recipe_line", "remainder_disposition", "alias", "workout", "household_meal", "cook", "component", "cook_line", "workout_line"] as const;
const INBOX_CAP = 100;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
/** An offset between the halves of a surrogate pair. */
const splitsPair = (text: string, at: number) => at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at));

const INBOX_SELECT = `SELECT e.*, m.name AS member, c.name AS created_by_name FROM inbox_entry e JOIN member m ON m.id = e.member_id LEFT JOIN member c ON c.id = e.created_by`;

function inboxOut(r: InboxRow) {
  return {
    id: r.id, member: r.member, date: r.entry_on, meal_slot: r.meal_slot, text: r.text, spans: JSON.parse(r.spans) as z.infer<typeof SPAN>[],
    status: r.status, note: r.resolution_note, records: r.records ? (JSON.parse(r.records) as { table: string; id: number }[]) : [],
    created_by: r.created_by_name, created_at: r.created_at, resolved_at: r.resolved_at,
  };
}

const submitToInbox = writeTool({
  name: "submit_to_inbox",
  group: GROUP,
  description:
    "Send the free text the router couldn't resolve to the Inbox for the gym-inbox skill: the whole text and its unresolved spans (each the exact text at its offsets), with the meal when known. Pending until resolved or rejected. A member's app call counts the spans in the router's measure as sent to the Inbox.",
  input: { member: z.string().min(1), date, text: z.string().min(1).max(5000), spans: z.array(SPAN).min(1).max(MAX_PIECES + 1), meal_slot: z.enum(MEAL_SLOTS).optional() },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    ctx.onBehalfOf(member.id);
    if (input.text.trim() === "") throw new ToolError("text_blank", "the text is blank", 400);
    for (const [i, s] of input.spans.entries()) {
      if (s.end <= s.start || s.end > input.text.length || input.text.slice(s.start, s.end) !== s.text || splitsPair(input.text, s.start) || splitsPair(input.text, s.end)) {
        throw new ToolError("span_mismatch", `span ${i} is not the text at ${s.start}-${s.end}`, 400, { index: i });
      }
    }
    const byStart = input.spans.map((s, i) => ({ ...s, i })).sort((a, b) => a.start - b.start);
    for (let k = 1; k < byStart.length; k++) {
      const prev = byStart[k - 1] as (typeof byStart)[number];
      const cur = byStart[k] as (typeof byStart)[number];
      if (cur.start < prev.end) throw new ToolError("span_overlap", `span ${cur.i} overlaps span ${prev.i}`, 400, { index: cur.i });
    }
    const tx = ctx.txOrThrow;
    const createdBy = ctx.caller.kind === "member" ? ctx.caller.memberId : (ctx.writeInfo.speaker?.id ?? null);
    const row = {
      member_id: member.id, entry_on: input.date, meal_slot: input.meal_slot ?? null, text: input.text, spans: JSON.stringify(input.spans),
      status: "pending", resolution_note: null, records: null, created_by: createdBy, created_at: ctx.nowIso(), resolved_at: null,
    };
    const id = await tx.create("inbox_entry", row);
    let stats: { inbox: number } | null = null;
    if (ctx.caller.kind === "member") {
      stats = { inbox: input.spans.length };
      tx.raw("route_stat", { member_id: ctx.caller.memberId, write_id: tx.writeId, recorded_on: ctx.today(), unedited: 0, edited: 0, inbox: stats.inbox });
    }
    const creator = createdBy === null ? null : (await ctx.memberById(createdBy)).name;
    return { entry: inboxOut({ id, ...row, member: member.name, created_by_name: creator } as InboxRow), stats };
  },
});

const inboxEntries = readTool({
  name: "inbox_entries",
  group: GROUP,
  description: "The Inbox's entries, oldest first: pending by default (or resolved, rejected, all); member narrows to the texts about that member. A member sees only the texts they sent and may name only themselves (another is not_visible); the agent sees everyone's.",
  input: { member: z.string().min(1).optional(), status: z.enum(["pending", "resolved", "rejected", "all"]).optional() },
  async run(ctx, input) {
    const member = input.member !== undefined ? await ctx.member(input.member) : null;
    // A text is its sender's (decision 157): a member reads only what they sent, and names only themselves.
    const sender = ctx.caller.kind === "member" ? ctx.caller.memberId : null;
    // Naming another member asks for texts that member may have sent: the same refusal as one entry.
    if (member !== null) ctx.assertSentInbox(member.id);
    const status = input.status ?? "pending";
    // Pending: the oldest first (the skill works oldest-first). Anything else: the most recent, shown oldest-first.
    const order = status === "pending" ? "e.created_at, e.id" : "e.created_at DESC, e.id DESC";
    const rows = await all<InboxRow>(
      ctx.db,
      `${INBOX_SELECT} WHERE m.household_id = ?1 AND (?2 IS NULL OR e.member_id = ?2) AND (?3 = 'all' OR e.status = ?3) AND (?4 IS NULL OR e.created_by = ?4) ORDER BY ${order} LIMIT ${INBOX_CAP + 1}`,
      ctx.householdId,
      member?.id ?? null,
      status,
      sender,
    );
    const kept = rows.slice(0, INBOX_CAP);
    if (status !== "pending") kept.reverse();
    return { entries: kept.map(inboxOut), truncated: rows.length > INBOX_CAP };
  },
});

const resolveInboxEntry = writeTool({
  name: "resolve_inbox_entry",
  group: GROUP,
  description: "Close an Inbox entry once: resolved (with a note saying what was logged, and the records written) or rejected (with why), and the reason. Only the agent or the member it is about, and a member only a text they sent (another's is not_visible).",
  input: {
    id: z.number().int().positive(),
    status: z.enum(["resolved", "rejected"]),
    note: z.string().min(1),
    records: z.array(z.object({ table: z.enum(RESOLUTION_TABLES), id: z.number().int().positive() }).strict()).optional(),
  },
  async run(ctx, input) {
    const row = await first<InboxRow>(ctx.db, `${INBOX_SELECT} WHERE e.id = ? AND m.household_id = ?`, input.id, ctx.householdId);
    if (!row) throw new ToolError("not_found", `no inbox entry ${input.id}`, 404);
    if (ctx.caller.kind === "member" && ctx.caller.memberId !== row.member_id) throw new ToolError("not_yours", "only the agent or the member an entry is about can close it", 403);
    // Closing returns the text, so a member closes only a text they sent (decision 157).
    ctx.assertSentInbox(row.created_by);
    if (row.status !== "pending") throw new ToolError("not_pending", `inbox entry ${input.id} is already ${row.status}`, 409);
    if (input.status === "rejected" && input.records !== undefined) throw new ToolError("records_on_rejection", "a rejected entry wrote no records", 400);
    if (input.note.trim() === "") throw new ToolError("note_blank", "the note is blank", 400);
    if (!input.reason) throw new Clarify("reason_needed", "Why is the entry closed this way?", [], ["reason"]);
    ctx.onBehalfOf(row.member_id);
    const changes = { status: input.status, resolution_note: input.note, records: input.records ? JSON.stringify(input.records) : null, resolved_at: ctx.nowIso() };
    const { member: _m, created_by_name: _c, ...stored } = row;
    const tx = ctx.txOrThrow;
    // Closed once even against a concurrent close: the inbox_entry_closes_once trigger aborts the batch
    // when the row is no longer pending, and app.ts turns that into 409 not_pending.
    tx.update("inbox_entry", row.id, changes, { ...stored, ...changes });
    await closeAnswered(ctx, row.id);
    return { entry: inboxOut({ ...row, ...changes }) };
  },
});

export const INPUT_TOOLS: Tool[] = [recentItemsTool, routeText, commitRoute, submitToInbox, inboxEntries, resolveInboxEntry];
