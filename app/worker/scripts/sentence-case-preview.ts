/**
 * `node app/worker/scripts/sentence-case-preview.ts [--names A,B] [--md] < rows.json`
 *
 * Click test P2-19 (Hritvik, 8 Oct 2026): coach notes, cues and flags were
 * stored as all-caps essays. This proposes a sentence-case rewrite of each
 * row and writes nothing: the rewrite itself goes through `amend` / the note
 * tools (so every original stays in history), and only after Hritvik has
 * seen the before and after.
 *
 * stdin: a JSON array of `{id, table, field, text}`. stdout: a JSON array of
 * `{id, table, field, before, after, changed, review}`, or with `--md` a
 * before/after list to read. `review` names the short all-caps words that
 * were lowercased, aren't common words and read like an acronym, in case
 * one is an acronym the list below doesn't know. `--names` adds names to keep capitalised (the
 * household's are known).
 *
 * The rules:
 * - A known acronym or unit keeps its own form (RIR, BMR, e1RM, kg, SS-A…),
 *   as does a number with a unit ("20KG" → "20kg").
 * - Dates keep their form; a month or weekday name is capitalised ("OCT" →
 *   "Oct"). Names, "I" and "Zone 2" / "Upper A" are capitalised.
 * - Quoted text ("…", “…”, '…') is kept exactly.
 * - In shouted text (half or more of the letters outside quotes are
 *   capitals) every other all-caps word is lowercased; in ordinary text
 *   only an emphasised common word or one of five letters or more is
 *   ("NOT", "ALWAYS"), so an unknown acronym there ("XYZ") stays.
 * - The first letter of each sentence, line and bullet is a capital.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Acronyms and units, in the form they keep (matched ignoring case). */
const ACRONYMS = [
  "RIR", "RPE", "BMR", "BIA", "TSH", "e1RM", "1RM", "BP", "HR", "HRV", "DB", "EZ", "SS-A", "SS-B", "SS-C", "RDL", "OHP", "AMRAP", "EMOM", "ROM",
  "PR", "PRs", "BMI", "TDEE", "LDL", "HDL", "HbA1c", "CBC", "ECG", "ALT", "AST", "SGOT", "SGPT", "T3", "T4", "FT3", "FT4", "B12", "D3", "VO2",
  "IU", "PT", "ID", "INR", "OK", "PDF", "CGM", "DEXA", "SMR", "kg", "g", "mg", "lb", "lbs", "km", "m", "cm", "mm", "ml", "l", "kcal", "bpm", "mmHg", "min", "mins", "s", "sec", "secs", "h",
];
const UNITS = new Set(["kg", "g", "mg", "lb", "lbs", "km", "m", "cm", "mm", "ml", "l", "kcal", "bpm", "min", "mins", "s", "sec", "secs", "h", "hr", "hrs", "x"]);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DATE_WORDS = [...MONTHS, ...DAYS, ...MONTHS.map((m) => m.slice(0, 3)), "Sept", ...DAYS.map((d) => d.slice(0, 3)), "Tues", "Thur", "Thurs"];
const HOUSEHOLD = ["Hritvik", "Asha", "Kabir"];
/** Common short words: lowercasing one of these needs no second look. */
const COMMON = new Set(
  ("a an the and or but nor so yet if as at by in on of to up off out for from with into onto over than then that this these those " +
    "is am are was were be been has had have do does did done not no yes all any each both few more most less some such only own same too very " +
    "can will just don't won't can't isn't i'm it's its it he she we they you me him her us our my your his them their what when why how who " +
    "go goes went keep hold set sets rep reps add drop stop use used new old next last week day days time low high left right top good bad easy hard " +
    "slow fast full half back arms legs leg arm core form pain sore done ok also again must ask take eat ate log one two six ten per via").split(" "),
);

const acronymFor = new Map(ACRONYMS.map((a) => [a.toLowerCase(), a]));
const dateWordFor = new Map(DATE_WORDS.map((d) => [d.toLowerCase(), d]));

export interface Options {
  /** Names kept capitalised, beside the household's. */
  names?: readonly string[];
}

const isCaps = (w: string) => /[A-Z]/.test(w) && !/[a-z]/.test(w);
const capitalise = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** One word (no spaces, hyphens inside): its proposed form, and whether a short unknown caps word was lowercased. */
function word(w: string, shouted: boolean, names: Map<string, string>): { out: string; lowered: boolean } {
  const key = w.toLowerCase();
  const known = acronymFor.get(key) ?? dateWordFor.get(key) ?? names.get(key);
  if (known) return { out: known, lowered: false };
  if (key === "i" || /^i['’](m|ll|ve|d)$/.test(key)) return { out: "I" + key.slice(1), lowered: false };
  // A number with a unit or a count: "20KG", "3X12".
  const unit = /^(\d+(?:[.,]\d+)?)([a-z]+)(\d*)$/i.exec(w);
  if (unit && (UNITS.has(unit[2]!.toLowerCase()) || unit[3])) return { out: `${unit[1]}${unit[2]!.toLowerCase()}${unit[3]}`, lowered: false };
  if (w.includes("-")) {
    const parts = w.split("-").map((p) => word(p, shouted, names));
    return { out: parts.map((p) => p.out).join("-"), lowered: parts.some((p) => p.lowered) };
  }
  if (!isCaps(w)) return { out: w, lowered: false };
  const letters = w.replace(/[^A-Za-z]/g, "").length;
  if (!shouted && letters < 5 && !COMMON.has(key)) return { out: w, lowered: false };
  if (letters === 0) return { out: w, lowered: false };
  // Worth a second look: a short word that isn't common and reads like an acronym (no vowel, or three letters or fewer).
  const odd = letters >= 2 && letters <= 4 && !COMMON.has(key.replace(/’/g, "'")) && (letters <= 3 || !/[aeiouy]/.test(key));
  return { out: key, lowered: odd };
}

/** Quoted spans, kept exactly: "…", “…”, and '…' opened after a space or bracket and closed before one. */
const QUOTED = /"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<=^|[\s(\[])'[^'\n]+'(?=$|[\s).,;:!?\]])/g;

/** The proposal for one text, and the short unknown caps words it lowercased. */
export function sentenceCaseWithReview(text: string, opts: Options = {}): { after: string; review: string[] } {
  const names = new Map([...HOUSEHOLD, ...(opts.names ?? [])].map((n) => [n.toLowerCase(), n]));
  // Split into quoted spans (kept) and the rest.
  const pieces: { text: string; quoted: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(QUOTED)) {
    if (m.index > at) pieces.push({ text: text.slice(at, m.index), quoted: false });
    pieces.push({ text: m[0], quoted: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) pieces.push({ text: text.slice(at), quoted: false });

  const outside = pieces.filter((p) => !p.quoted).map((p) => p.text).join(" ");
  const upper = (outside.match(/[A-Z]/g) ?? []).length;
  const lower = (outside.match(/[a-z]/g) ?? []).length;
  const shouted = upper > 0 && upper >= lower;

  const review: string[] = [];
  // At the start of the text, a sentence, a line or a bullet.
  let start = true;
  const out = pieces.map((p) => {
    if (p.quoted) {
      start = false;
      return p.text;
    }
    // Words (letters, digits, apostrophes, hyphens inside) and everything between them.
    return p.text.replace(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[^A-Za-z0-9]+/g, (tok) => {
      if (!/[A-Za-z0-9]/.test(tok)) {
        if (/[.!?]\s|[.!?]$|\n/.test(tok) || (start && /^\s*([-*•]|\d+[.)])?\s*$/.test(tok))) start = true;
        return tok;
      }
      const w = word(tok, shouted, names);
      if (w.lowered) review.push(tok);
      let result = w.out;
      // A sentence starts with a capital, unless its first word keeps its own form (an acronym or unit).
      if (start && /^[a-z]/.test(result) && !acronymFor.has(result.toLowerCase())) result = capitalise(result);
      start = false;
      return result;
    });
  });
  let after = out.join("");
  // Phrases: "Zone 2", "Upper A", "Lower B", "Full body A".
  after = after.replace(/\bzone(\s+\d)\b/gi, "Zone$1").replace(/\b(upper|lower|push|pull|legs|full body)(\s+)([a-d])\b/gi, (_m, w: string, sp: string, l: string) => `${capitalise(w.toLowerCase())}${sp}${l.toUpperCase()}`);
  return { after, review: [...new Set(review)] };
}

export const sentenceCase = (text: string, opts: Options = {}): string => sentenceCaseWithReview(text, opts).after;

export interface Row {
  id: number;
  table: string;
  field: string;
  text: string;
}

export interface Proposal {
  id: number;
  table: string;
  field: string;
  before: string;
  after: string;
  changed: boolean;
  review: string[];
}

export function preview(rows: readonly Row[], opts: Options = {}): Proposal[] {
  return rows.map((r, i) => {
    if (typeof r !== "object" || r === null || typeof r.id !== "number" || typeof r.table !== "string" || typeof r.field !== "string" || typeof r.text !== "string") {
      throw new Error(`row ${i} is not {id, table, field, text}`);
    }
    const { after, review } = sentenceCaseWithReview(r.text, opts);
    return { id: r.id, table: r.table, field: r.field, before: r.text, after, changed: after !== r.text, review };
  });
}

function markdown(proposals: readonly Proposal[]): string {
  return proposals
    .filter((p) => p.changed)
    .map((p) => `### ${p.table} ${p.id}, ${p.field}${p.review.length ? ` (check: ${p.review.join(", ")})` : ""}\n\nBefore:\n\n> ${p.before.replace(/\n/g, "\n> ")}\n\nAfter:\n\n> ${p.after.replace(/\n/g, "\n> ")}\n`)
    .join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--names");
  const names = i >= 0 && process.argv[i + 1] ? process.argv[i + 1]!.split(",").map((n) => n.trim()).filter(Boolean) : [];
  const rows = JSON.parse(readFileSync(0, "utf8")) as Row[];
  const proposals = preview(rows, { names });
  process.stdout.write(process.argv.includes("--md") ? markdown(proposals) : `${JSON.stringify(proposals, null, 2)}\n`);
}
