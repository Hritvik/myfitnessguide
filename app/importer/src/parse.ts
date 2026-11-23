/**
 * Parsing typed Sheets cells. Each parser says whether it had to repair the
 * cell (a number or date stored as text, an RIR range Sheets turned into a
 * date serial), so the caller can record the mechanical ruling.
 */
import { parseRir } from "@myfitnessguide/domain";
import type { Cell } from "./snapshot";

/** Sheets day 0 is 1899-12-30. */
const EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

export function serialToIso(serial: number): string {
  return new Date(EPOCH_MS + Math.floor(serial) * DAY_MS).toISOString().slice(0, 10);
}

export function isoToSerial(iso: string): number {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - EPOCH_MS) / DAY_MS);
}

export type Repair = "text_number" | "text_date" | "rir_date_serial" | "range_date_serial";

export interface Parsed<T> {
  value: T;
  repair: Repair | null;
}

const NUMERIC = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?$/;

/** A number, a number stored as text ("35", "1,488"), or null when blank. Throws on anything else. */
export function parseNumber(cell: Cell): Parsed<number | null> {
  if (cell === null || cell === "") return { value: null, repair: null };
  if (typeof cell === "number") return { value: cell, repair: null };
  if (typeof cell === "boolean") throw new ParseError(`expected a number, got ${String(cell)}`);
  const text = cell.trim();
  if (text === "") return { value: null, repair: null };
  if (NUMERIC.test(text) && /\d/.test(text)) return { value: Number(text.replace(/,/g, "")), repair: "text_number" };
  throw new ParseError(`expected a number, got "${text}"`);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function validIso(y: number, m: number, d: number): string | null {
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
}

/** A date: a Sheets serial, or text (2026-09-28, 08-Apr-2026, 28 Sep 2026). Null when blank. Throws on anything else. */
export function parseDate(cell: Cell): Parsed<string | null> {
  if (cell === null || cell === "") return { value: null, repair: null };
  if (typeof cell === "number") {
    if (cell < 20_000 || cell > 80_000) throw new ParseError(`${cell} is not a plausible date serial`);
    return { value: serialToIso(cell), repair: null };
  }
  if (typeof cell === "boolean") throw new ParseError(`expected a date, got ${String(cell)}`);
  const text = cell.trim();
  if (text === "") return { value: null, repair: null };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (m) {
    const iso = validIso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (iso) return { value: iso, repair: "text_date" };
  }
  m = /^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{4})$/.exec(text);
  if (m) {
    const month = MONTHS.indexOf((m[2] as string).toLowerCase()) + 1;
    const iso = month > 0 ? validIso(Number(m[3]), month, Number(m[1])) : null;
    if (iso) return { value: iso, repair: "text_date" };
  }
  throw new ParseError(`expected a date, got "${text}"`);
}

/** A time of day: a Sheets day fraction (0.625), or text ("14:05", "9:04am"). Null when blank. */
export function parseTime(cell: Cell): Parsed<string | null> {
  if (cell === null || cell === "") return { value: null, repair: null };
  if (typeof cell === "number") {
    if (cell < 0 || cell >= 1) throw new ParseError(`${cell} is not a time of day`);
    const minutes = Math.round(cell * 24 * 60);
    return { value: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`, repair: null };
  }
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i.exec(String(cell).trim());
  if (!m) throw new ParseError(`expected a time, got "${String(cell)}"`);
  let h = Number(m[1]);
  const ampm = m[4]?.toLowerCase();
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  if (h > 23 || Number(m[2]) > 59) throw new ParseError(`expected a time, got "${String(cell)}"`);
  return { value: `${String(h).padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}`, repair: "text_date" };
}

export interface Range {
  low: number;
  high: number;
}

/**
 * A range Sheets turned into a date: typing "1-2" stores 2 Jan of the
 * current year (serial 46024 in 2026), so month-day decodes back to low-high.
 */
export function decodeRangeSerial(serial: number): Range | null {
  if (!Number.isInteger(serial) || serial < 20_000 || serial > 80_000) return null;
  const iso = serialToIso(serial);
  const low = Number(iso.slice(5, 7));
  const high = Number(iso.slice(8, 10));
  return low <= high ? { low, high } : null;
}

export type RirParse =
  | { kind: "range"; low: number; high: number; repair: Repair | null; note: string | null }
  | { kind: "blank" }
  | { kind: "unreadable"; text: string };

/** RIR as typed: a number, a range ("1-2", "4+"), a range stored as a date serial, or blank. */
export function parseRirCell(cell: Cell): RirParse {
  if (cell === null || cell === "") return { kind: "blank" };
  if (typeof cell === "number") {
    if (cell >= 0 && cell <= 10 && Number.isInteger(cell)) return { kind: "range", low: cell, high: cell, repair: null, note: null };
    const decoded = decodeRangeSerial(cell);
    if (decoded && decoded.high <= 10) return { kind: "range", ...decoded, repair: "rir_date_serial", note: null };
    return { kind: "unreadable", text: String(cell) };
  }
  const text = String(cell).trim();
  if (text === "") return { kind: "blank" };
  const bare = text.replace(/\s*\(.*\)\s*$/, "");
  const rir = parseRir(bare);
  if (rir && typeof rir === "object" && Number.isInteger(rir.low) && Number.isInteger(rir.high)) {
    return { kind: "range", low: rir.low, high: rir.high, repair: /^\d+$/.test(bare) ? "text_number" : null, note: bare === text ? null : text };
  }
  return { kind: "unreadable", text };
}

/** A rep range as typed in Program: "6-8", "10-12 per leg", 12, or a date serial. */
export function parseRepRange(cell: Cell): (Range & { repair: Repair | null; note: string | null }) | null {
  if (typeof cell === "number") {
    if (Number.isInteger(cell) && cell > 0 && cell <= 100) return { low: cell, high: cell, repair: null, note: null };
    const decoded = decodeRangeSerial(cell);
    return decoded ? { ...decoded, repair: "range_date_serial", note: null } : null;
  }
  const text = String(cell ?? "").trim();
  const m = /^(\d+)\s*(?:-\s*(\d+))?(.*)$/.exec(text);
  if (!m) return null;
  const low = Number(m[1]);
  const high = m[2] === undefined ? low : Number(m[2]);
  const rest = (m[3] as string).trim();
  if (rest !== "" && !/^per (leg|side|arm|hand)$/i.test(rest)) return null;
  return low <= high ? { low, high, repair: null, note: rest === "" ? null : text } : null;
}

export class ParseError extends Error {}
