/**
 * Reading a snapshot tab by column letter. A cell has three faces:
 * - raw: the typed input (the formulas grid where the cell holds no formula);
 *   for a formula cell, its rendered value instead, since that is all a
 *   formula's input row can offer;
 * - rendered: what Sheets displayed (the values grid, a formatted string);
 * - formula: the formula text, or null.
 */
import type { Cell, Snapshot, SnapshotTab } from "./snapshot";

export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function colLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export class Row {
  constructor(
    readonly tab: Sheet,
    /** 1-based sheet row number. */
    readonly n: number,
  ) {}

  private f(col: string): Cell {
    return this.tab.data.formulas[this.n - 1]?.[colIndex(col)] ?? "";
  }

  formula(col: string): string | null {
    const f = this.f(col);
    return typeof f === "string" && f.startsWith("=") ? f : null;
  }

  rendered(col: string): string {
    return this.tab.data.values[this.n - 1]?.[colIndex(col)] ?? "";
  }

  raw(col: string): Cell {
    return this.formula(col) !== null ? this.rendered(col) : this.f(col);
  }

  /** Raw value as trimmed text ("" when blank). */
  text(col: string): string {
    const v = this.raw(col);
    return v === null ? "" : String(v).trim();
  }

  blank(col: string): boolean {
    return this.text(col) === "";
  }

  /** The cells named, for a ruling's evidence. */
  cells(cols: readonly string[]): Record<string, Cell> {
    const out: Record<string, Cell> = {};
    for (const c of cols) {
      const v = this.raw(c);
      if (v !== "" && v !== null) out[c] = v;
    }
    return out;
  }
}

export class Sheet {
  constructor(
    readonly file: string,
    readonly name: string,
    readonly data: SnapshotTab,
  ) {}

  static of(snap: Snapshot, file: string, name: string): Sheet | null {
    const tab = snap.files[file]?.tabs[name];
    return tab ? new Sheet(file, name, tab) : null;
  }

  row(n: number): Row {
    return new Row(this, n);
  }

  /** Rows (from row 2) that rendered anything: for tabs a formula spills into (Daily Nutrition, Chart Data). */
  renderedRows(from = 2): Row[] {
    const out: Row[] = [];
    for (let n = from; n <= this.data.rows; n++) if ((this.data.values[n - 1] ?? []).some((c) => c.trim() !== "")) out.push(new Row(this, n));
    return out;
  }

  /** Data rows (from row 2) whose typed input is not entirely blank; formula-only rows are skipped. */
  rows(from = 2): Row[] {
    const out: Row[] = [];
    for (let n = from; n <= this.data.rows; n++) {
      const formulas = this.data.formulas[n - 1] ?? [];
      const hasInput = formulas.some((c) => c !== "" && c !== null && !(typeof c === "string" && c.startsWith("=")));
      if (hasInput) out.push(new Row(this, n));
    }
    return out;
  }
}
