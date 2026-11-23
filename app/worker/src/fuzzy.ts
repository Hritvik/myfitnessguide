/**
 * Fuzzy name matching for catalogue_search and for the options a
 * clarification offers. Case-insensitive; scores an exact name highest, then
 * a prefix, the query at a word start, the query with its spacing ignored,
 * every query word a word start (any order), all but one query word found
 * (some may be near-spellings), the query inside a word, and finally every
 * query word within a small edit distance of some word (typos). Ticket 75.
 */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] as number;
      prev[j] = Math.min(up + 1, (prev[j - 1] as number) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length] as number;
}

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** A query normalised once, for scoring against many names. */
export interface PreparedQuery {
  q: string;
  compact: string;
  words: string[];
}

const compactOf = (s: string) => s.replace(/[^a-z0-9]+/g, "");

export function prepareQuery(query: string): PreparedQuery {
  const q = query.trim().toLowerCase();
  return { q, compact: compactOf(q), words: words(q) };
}

/**
 * The best score of a match by near-spelling only (every query word within a
 * small edit distance): one letter off. Each further letter off scores one
 * less, so near-spellings rank by closeness (ticket 68); every one is at or
 * below this, and above 0.
 */
export const NEAR_SPELLING = 20;

/** Every query word a word start in the name, in any order ("atta wheat" in "Whole-wheat atta"). */
export const EVERY_WORD = 40;

/**
 * The query found only inside a word ("oil" in "boiled"): below every match at a
 * word start, and above every near-spelling (ticket 75). A query word matched
 * by a word start but with one word missing scores between this and EVERY_WORD.
 */
export const INSIDE_A_WORD = 21;

const isWordChar = (c: string | undefined) => c !== undefined && /[a-z0-9]/.test(c);

/** Whether the query occurs in the name at the start of a word, not only inside one. */
function atWordStart(n: string, q: string): boolean {
  if (!isWordChar(q[0])) return n.includes(q);
  for (let i = n.indexOf(q); i >= 0; i = n.indexOf(q, i + 1)) if (!isWordChar(n[i - 1])) return true;
  return false;
}

const tolerance = (w: string) => (w.length <= 4 ? 1 : 2);

export function matchPrepared(pq: PreparedQuery, name: string): number {
  const { q } = pq;
  const n = name.trim().toLowerCase();
  if (!q) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  const inside = n.includes(q);
  if (inside && atWordStart(n, q)) return 60;
  // Spacing differences: "benchpress" in "barbell bench press" (never a query already found inside a word).
  if (!inside && pq.compact.length >= 3 && compactOf(n).includes(pq.compact)) return 50;
  const floor = inside ? INSIDE_A_WORD : 0;
  const qw = pq.words;
  if (qw.length === 0) return floor;
  const nw = words(n);
  // Each query word: a word start in the name, a near-spelling of a word, or missing.
  let starts = 0;
  let strong = 0;
  let near = 0;
  let off = 0;
  let missing = 0;
  for (const w of qw) {
    const exact = nw.some((x) => x === w);
    if (exact || nw.some((x) => x.startsWith(w))) {
      starts++;
      // A word start of one or two letters ("a", "of") is too common to carry a partial match alone.
      if (exact || w.length >= 3) strong++;
      continue;
    }
    const tol = tolerance(w);
    let d = Infinity;
    // Lengths further apart than the tolerance can't be within it: skip the edit distance.
    for (const x of nw) if (Math.abs(x.length - w.length) <= tol) d = Math.min(d, editDistance(w, x));
    if (d <= tol) {
      near++;
      off += d;
    } else if (++missing > 1) return floor; // Two words missing: nothing below can match.
  }
  if (starts === qw.length) return EVERY_WORD;
  // Some words whole, the rest near-spelt or one missing ("wheat flour atta" in "Whole-wheat atta"):
  // ranked by how much of the query was found, a near-spelt word counting half.
  if (strong > 0 && missing <= 1) {
    const partial = Math.floor(NEAR_SPELLING + (NEAR_SPELLING * (starts + near / 2)) / qw.length);
    return Math.max(floor, Math.min(EVERY_WORD - 1, Math.max(INSIDE_A_WORD + 1, partial)));
  }
  if (missing > 0) return floor;
  return Math.max(floor, Math.max(1, NEAR_SPELLING - Math.max(0, off - 1)));
}

/** How far a name is from the whole query: the tie-break between near-spellings equally off by their words ("beat": Beet before Bean sprouts). */
export function nameDistance(query: string | PreparedQuery, names: readonly string[]): number {
  const pq = typeof query === "string" ? prepareQuery(query) : query;
  return Math.min(...names.map((n) => editDistance(pq.q, n.trim().toLowerCase())));
}

export function matchScore(query: string, name: string): number {
  return matchPrepared(prepareQuery(query), name);
}

/** Items ranked by their best-matching name; non-matches dropped. Ties keep input order. */
export function fuzzyRank<T>(query: string, items: readonly { item: T; names: readonly string[] }[]): T[] {
  const pq = prepareQuery(query);
  return items
    .map((x, i) => ({ x, i, score: bestScore(pq, x.names) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.x.item);
}

export function bestScore(query: string | PreparedQuery, names: readonly string[]): number {
  const pq = typeof query === "string" ? prepareQuery(query) : query;
  let best = 0;
  for (const n of names) best = Math.max(best, matchPrepared(pq, n));
  return best;
}
