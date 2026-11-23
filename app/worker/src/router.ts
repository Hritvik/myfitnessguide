/**
 * The free-text router's grammar (spec §7): pure and deterministic, with
 * no data. It splits a member's text into pieces and reads each piece's
 * amount, unit, state and words, or its set shorthand. Matching the words
 * to the catalogue, aliases, recents, today's cooks, workouts and
 * exercises is route_text's job (tools/input.ts). Nothing here guesses:
 * what it can't read comes back unreadable.
 */
import { STATES } from "./catalogue";

export const MAX_TEXT = 1000;
export const MAX_PIECES = 20;

export interface Span {
  text: string;
  start: number;
  end: number;
}
export type Unit = "g" | "kg" | "mg" | "ml" | "l" | "piece";
export type State = (typeof STATES)[number];
export interface Amount {
  kind: "count" | "fraction";
  value: number;
}
export interface FoodPiece {
  kind: "food";
  span: Span;
  amount: Amount | null;
  unit: Unit | null;
  state: State | null;
  words: string[];
  usual: boolean;
  the: boolean;
  approx: boolean;
}
export interface SetPiece {
  kind: "set";
  span: Span;
  words: string[];
  load: { value: number; unit: "kg" | "lb" | null } | "bodyweight" | null;
  reps: number | null;
  rir: { low: number; high: number } | null;
  sets: number;
}
export interface Unreadable {
  kind: "unreadable";
  span: Span;
  /** "several": a second amount in one piece, i.e. items run together with no separator. */
  why: "amount" | "several" | "reps" | "rir" | "sets" | "load";
}
export type Parsed = FoodPiece | SetPiece | Unreadable;

const UNITS: Record<string, Unit> = {
  g: "g", gm: "g", gms: "g", gram: "g", grams: "g", kg: "kg", kgs: "kg", mg: "mg", ml: "ml",
  l: "l", ltr: "l", litre: "l", litres: "l", liter: "l", liters: "l", pc: "piece", pcs: "piece", piece: "piece", pieces: "piece",
};
const LOAD_UNITS: Record<string, "kg" | "lb"> = { kg: "kg", kgs: "kg", lb: "lb", lbs: "lb" };
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const FRACTION_WORDS: Record<string, number> = { half: 0.5, quarter: 0.25, third: 1 / 3 };
const FILLERS = new Set(["and", "or", "also", "then", "plus", "with", "of", "some", "serving", "servings"]);
const EMPTY_WORDS = new Set([...FILLERS, "the", "a", "an"]);
/** The most of each unit a piece may name; more is a typo, never a guess. */
const MAX_AMOUNT: Record<Unit | "none", number> = { g: 5000, ml: 5000, kg: 5, l: 5, mg: 100000, piece: 50, none: 50 };
const REPS_MARKERS = new Set(["rep", "reps", "x", "sets"]);
const SET_MARKERS = new Set(["x", "rep", "reps", "rir", "@", "bw", "bodyweight", "sets"]);
const NUMERIC_LOOKING = /^[\d.\/-]+$/;
const SEPARATOR = /[,;\n+&]/;

const parseNumber = (t: string | undefined): number | null => (t !== undefined && /^\d+(\.\d+)?$/.test(t) ? Number(t) : null);

function trimSpan(text: string, from: number, to: number): Span | null {
  const raw = text.slice(from, to);
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const start = from + (raw.length - raw.trimStart().length);
  return { text: trimmed, start, end: start + trimmed.length };
}

/** "yes": has a word; "lone": only numbers (kept only beside real pieces, as unreadable); "no": nothing to read. */
function readable(text: string): "yes" | "lone" | "no" {
  if (!/[\p{L}\p{N}]/u.test(text)) return "no";
  const tokens = tokenize(text);
  if (tokens.some((t) => !EMPTY_WORDS.has(t) && /\p{L}/u.test(t))) return "yes";
  return tokens.some((t) => /\p{N}/u.test(t)) ? "lone" : "no";
}

export function splitText(text: string): { spans: Span[]; overflow: Span | null } {
  const spans: Span[] = [];
  let start = 0;
  const lone = new Set<Span>();
  let overflowAt: number | null = null;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && !SEPARATOR.test(text[i] as string)) continue;
    if (i > MAX_TEXT) {
      overflowAt = start;
      break;
    }
    const s = trimSpan(text, start, i);
    const r = s ? readable((s as Span).text) : "no";
    if (s && r !== "no") {
      spans.push(s);
      if (r === "lone") lone.add(s);
    }
    start = i + 1;
  }
  if (spans.every((s) => lone.has(s))) spans.length = 0;
  if (spans.length > MAX_PIECES) overflowAt = Math.min(overflowAt ?? Number.MAX_SAFE_INTEGER, (spans[MAX_PIECES] as Span).start);
  const kept = overflowAt === null ? spans : spans.filter((s) => s.start < (overflowAt as number));
  return { spans: kept.slice(0, MAX_PIECES), overflow: overflowAt === null ? null : trimSpan(text, overflowAt, text.length) };
}

/** A part that is only an amount ("1", "about two"): with a fraction after " and ", one amount. */
const BARE_AMOUNT = /^\s*(?:(?:about|around|approx|approximately)\s+|~\s*)?(?:\p{Nd}+(?:\.\p{Nd}+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s*$/iu;
const FRACTION_START = /^(?:an?\s+)?(?:half|quarter|third)\b/i;

export function splitOnAnd(span: Span): Span[] {
  const out: Span[] = [];
  const re = /\s+and\s+/gi;
  let from = 0;
  for (const m of span.text.matchAll(re)) {
    // "1 and a half roti" is one amount, never "1" and "a half roti"; "eggs 2 and half the dal" is two pieces.
    const before = span.text.slice(from, m.index as number);
    const after = span.text.slice((m.index as number) + m[0].length);
    if (BARE_AMOUNT.test(before) && FRACTION_START.test(after)) continue;
    const s = trimSpan(span.text, from, m.index as number);
    if (s) out.push({ text: s.text, start: span.start + s.start, end: span.start + s.end });
    from = (m.index as number) + m[0].length;
  }
  if (out.length === 0) return [span];
  const last = trimSpan(span.text, from, span.text.length);
  if (last) out.push({ text: last.text, start: span.start + last.start, end: span.start + last.end });
  return out;
}

const ND = /^\p{Nd}$/u;
/** Other scripts' decimal digits (Devanagari "२") read as ASCII digits; each digit run is ten code points from its zero. */
function asciiDigits(s: string): string {
  return s.replace(/\p{Nd}/gu, (c) => {
    if (c >= "0" && c <= "9") return c;
    let cp = c.codePointAt(0) as number;
    let k = 0;
    while (ND.test(String.fromCodePoint(cp - 1))) {
      cp--;
      k++;
    }
    return String(k % 10);
  });
}

function tokenize(s: string): string[] {
  return asciiDigits(s)
    .toLowerCase()
    .replace(/(\d)\s*(kgs?|lbs?|gms?|grams?|g|mg|ml|ltr|litres?|liters?|l|pcs?|pieces?|reps?|rir|x)\b/g, "$1 $2")
    .replace(/(\d)x(\d)/g, "$1 x $2")
    .replace(/\bx(\d)/g, "x $1")
    .replace(/\brir(\d)/g, "rir $1")
    .replace(/@/g, " @ ")
    .replace(/~/g, " ~ ")
    .replace(/%/g, " % ")
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{M}\p{N}@~%./-]+|[^\p{L}\p{M}\p{N}@~%./-]+$/gu, ""))
    .filter(Boolean);
}

function stateAt(tokens: string[], i: number): { state: State; next: number } | null {
  const t = tokens[i] as string;
  if (t === "as" && tokens[i + 1] === "sold") return { state: "as_sold", next: i + 2 };
  if (t === "in" && tokens[i + 1] === "shell") return { state: "in_shell", next: i + 2 };
  return (STATES as readonly string[]).includes(t) && t !== "as_sold" && t !== "in_shell" ? { state: t as State, next: i + 1 } : null;
}

/** A word after a percent that makes it a nutrient content ("10 % protein"), not a share. */
const NUTRIENT_WORDS = new Set(["protein", "fat", "carb", "carbs", "fibre", "fiber", "kcal", "calories"]);

function readAmount(tokens: string[], i: number, lead = false): { amount: Amount; unit: Unit | null; next: number } | "bad" | null {
  const t = tokens[i];
  if (t === undefined) return null;
  let amount: Amount;
  let next = i + 1;
  const n = parseNumber(t);
  if (n !== null) amount = { kind: "count", value: n };
  else if (/^\d+\/\d+$/.test(t)) {
    const [a, b] = t.split("/").map(Number) as [number, number];
    if (b === 0) return "bad";
    amount = { kind: "fraction", value: a / b };
  } else if (t in NUMBER_WORDS) amount = { kind: "count", value: NUMBER_WORDS[t] as number };
  else if (t in FRACTION_WORDS) amount = { kind: "fraction", value: FRACTION_WORDS[t] as number };
  else if (NUMERIC_LOOKING.test(t)) return "bad";
  else return null;
  const after = tokens[next];
  // "10% of the dal", "10 % dal": a percent is a share, 0.1 of the pot; over 100 is a typo, never a guess.
  if (after === "%") {
    if (n === null || !(n > 0) || n > 100) return "bad";
    // "curd 10 % protein" is a nutrient content, not a share: unreadable, so it asks.
    if (NUTRIENT_WORDS.has(tokens[next + 1] ?? "")) return "bad";
    return { amount: { kind: "fraction", value: n / 100 }, unit: null, next: next + 1 };
  }
  if (after !== undefined && amount.kind === "count") {
    if (/^\d+\/\d+$/.test(after) && n !== null) {
      const [a, b] = after.split("/").map(Number) as [number, number];
      if (b === 0) return "bad";
      amount = { kind: "count", value: amount.value + a / b };
      next++;
    } else if (after in FRACTION_WORDS && (t === "a" || t === "an" || t === "one")) {
      amount = { kind: "fraction", value: FRACTION_WORDS[after] as number };
      next++;
    } else if (after === "and" && lead) {
      // "1 and a half roti", "2 and half": a piece's leading number and a fraction word are one amount
      // (splitOnAnd keeps them together only there, too).
      const article = tokens[next + 1] === "a" || tokens[next + 1] === "an" ? 1 : 0;
      const frac = tokens[next + 1 + article] ?? "";
      if (frac in FRACTION_WORDS) {
        amount = { kind: "count", value: amount.value + (FRACTION_WORDS[frac] as number) };
        next += 2 + article;
      }
    }
  }
  const unit = UNITS[tokens[next] ?? ""] ?? null;
  if (unit) next++;
  if (!Number.isFinite(amount.value) || !(amount.value > 0) || amount.value > MAX_AMOUNT[unit ?? "none"]) return "bad";
  return { amount, unit, next };
}

function parseFood(span: Span, tokens: string[]): Parsed {
  const out: FoodPiece = { kind: "food", span, amount: null, unit: null, state: null, words: [], usual: false, the: false, approx: false };
  const unreadable = (): Unreadable => ({ kind: "unreadable", span, why: "amount" });
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (t === "my" && tokens[i + 1] === "usual") {
      out.usual = true;
      i++;
    } else if (t === "usual") out.usual = true;
    else if (t === "about" || t === "around" || t === "approx" || t === "approximately" || t === "~") out.approx = true;
    else break;
  }
  const lead = readAmount(tokens, i, true);
  if (lead === "bad") return unreadable();
  if (lead) {
    out.amount = lead.amount;
    out.unit = lead.unit;
    i = lead.next;
  }
  for (; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (t === "the") {
      out.the = true;
      continue;
    }
    if (FILLERS.has(t) || ((t === "a" || t === "an") && out.amount !== null)) continue;
    const state = stateAt(tokens, i);
    if (state) {
      out.state = state.state;
      i = state.next - 1;
      continue;
    }
    if (t === "%") return unreadable();
    if (NUMERIC_LOOKING.test(t)) {
      // A second amount AFTER a name is several items typed with no separator
      // ("2 eggs 1 tomato 10 g peas"): say so, rather than "change the words". With no
      // name between them ("2 2 eggs") it is one malformed amount, which stays "amount".
      if (out.amount !== null) return { kind: "unreadable", span, why: out.words.length > 0 ? "several" : "amount" };
      const tail = readAmount(tokens, i);
      if (tail === "bad" || tail === null) return unreadable();
      out.amount = tail.amount;
      out.unit = tail.unit;
      i = tail.next - 1;
      continue;
    }
    out.words.push(t);
  }
  return out;
}

function rirOf(t: string | undefined): { low: number; high: number } | null {
  const m = t === undefined ? null : /^(\d+)(?:-(\d+))?$/.exec(t);
  if (!m) return null;
  const low = Number(m[1]);
  return { low, high: m[2] === undefined ? low : Number(m[2]) };
}

function parseSet(span: Span, tokens: string[]): Parsed {
  const out: SetPiece = { kind: "set", span, words: [], load: null, reps: null, rir: null, sets: 1 };
  const loose: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    const next = tokens[i + 1];
    const n = parseNumber(t);
    if (t === "set" && parseNumber(next) !== null) {
      i++;
      continue;
    }
    if (t === "bw" || t === "bodyweight") {
      out.load = "bodyweight";
      continue;
    }
    if (t === "rir" || t === "@") {
      const r = rirOf(next);
      if (!r || REPS_MARKERS.has(tokens[i + 2] ?? "")) return { kind: "unreadable", span, why: "rir" };
      out.rir = r;
      i++;
      continue;
    }
    if (next === "rir" && rirOf(t)) {
      const after = parseNumber(tokens[i + 2]);
      if (after !== null) {
        // "N rir M": a reps marker after M makes M the reps and N the RIR; with none, N is
        // the reps and M the RIR, unless reps or RIR are already set, which leaves it open.
        if (REPS_MARKERS.has(tokens[i + 3] ?? "")) {
          if (out.rir !== null) return { kind: "unreadable", span, why: "rir" };
          out.rir = rirOf(t);
          i++;
          continue;
        }
        if (out.reps !== null || out.rir !== null) return { kind: "unreadable", span, why: "rir" };
      } else {
        out.rir = rirOf(t);
        i++;
        continue;
      }
    }
    if (n !== null && next !== undefined && next in LOAD_UNITS) {
      out.load = { value: n, unit: LOAD_UNITS[next] as "kg" | "lb" };
      i++;
      continue;
    }
    const third = parseNumber(tokens[i + 2]);
    if (n !== null && next === "x" && third !== null) {
      if (out.load === null && out.reps === null && Number.isInteger(n) && n <= 10) {
        out.sets = n;
        out.reps = third;
      } else if (out.load === null) {
        out.load = { value: n, unit: null };
        out.reps = third;
      } else out.reps = third;
      i += 2;
      continue;
    }
    if (t === "x" && parseNumber(next) !== null) {
      out.reps = parseNumber(next);
      i++;
      continue;
    }
    if (n !== null && (next === "reps" || next === "rep")) {
      out.reps = n;
      i++;
      continue;
    }
    if (n !== null && next === "sets") {
      out.sets = n;
      i++;
      if (tokens[i + 1] === "of" && parseNumber(tokens[i + 2]) !== null) {
        out.reps = parseNumber(tokens[i + 2]);
        i += 2;
      }
      continue;
    }
    if (SET_MARKERS.has(t) || t === "of") continue;
    if (n !== null) {
      loose.push(n);
      continue;
    }
    if (NUMERIC_LOOKING.test(t)) return { kind: "unreadable", span, why: "reps" };
    // A percent in a set ("80% of 1RM") isn't a load the router reads.
    if (t === "%") return { kind: "unreadable", span, why: "load" };
    if (!FILLERS.has(t)) out.words.push(t);
  }
  for (const n of loose) {
    if (out.load === null) out.load = { value: n, unit: null };
    else if (out.reps === null) out.reps = n;
    else return { kind: "unreadable", span, why: "reps" };
  }
  if (out.reps !== null && (!Number.isInteger(out.reps) || out.reps > 200)) return { kind: "unreadable", span, why: "reps" };
  if (out.rir !== null && (out.rir.low > 10 || out.rir.high > 10 || out.rir.low > out.rir.high)) return { kind: "unreadable", span, why: "rir" };
  if (!Number.isInteger(out.sets) || out.sets < 1 || out.sets > 10) return { kind: "unreadable", span, why: "sets" };
  if (out.load !== null && out.load !== "bodyweight" && !(out.load.value > 0 && out.load.value < 1000)) return { kind: "unreadable", span, why: "load" };
  return out;
}

export function parsePiece(span: Span): Parsed {
  const tokens = tokenize(span.text);
  if (!tokens.some((t) => /\p{L}/u.test(t) || SET_MARKERS.has(t))) return { kind: "unreadable", span, why: "amount" };
  return tokens.some((t) => SET_MARKERS.has(t)) ? parseSet(span, tokens) : parseFood(span, tokens);
}

/** The name, then its plural-stripped forms, for matching "eggs" to "Egg". */
export function singulars(name: string): string[] {
  const out = [name];
  if (/ies$/.test(name)) out.push(name.replace(/ies$/, "y"));
  if (/es$/.test(name)) out.push(name.replace(/es$/, ""));
  if (/s$/.test(name) && !/ss$/.test(name)) out.push(name.replace(/s$/, ""));
  return [...new Set(out)];
}
