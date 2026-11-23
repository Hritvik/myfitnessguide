/**
 * The snapshot: a read-only, timestamped copy of every tab of the four
 * Sheets files, with both grids per tab.
 *
 * - `formulas`: what `sheets_values_batch_get` returns with `formulas: true`
 *   (the formula text where a cell has one, otherwise the unformatted raw
 *   value: numbers as numbers, date serials as numbers, text as text).
 * - `values`: the same range read plainly (the rendered, formatted strings).
 *
 * Both grids are padded to one rectangle per tab. The snapshot is household
 * health data: it lives outside the repo and is never committed.
 */
export const SNAPSHOT_FORMAT = "myfitnessguide-sheets-snapshot";
const LEGACY_SNAPSHOT_FORMAT = "gym-tracker-sheets-snapshot";

export type Cell = string | number | boolean | null;

export interface SnapshotTab {
  /** The A1 range that was read. */
  range: string;
  rows: number;
  cols: number;
  values: string[][];
  formulas: Cell[][];
}

export interface SnapshotFile {
  spreadsheet_id: string;
  name: string;
  modified_time: string | null;
  revision: string | null;
  tabs: Record<string, SnapshotTab>;
}

export interface Snapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: 1;
  captured_at: string;
  source: { tool: string; auth_profile: string };
  files: Record<string, SnapshotFile>;
}

/** One `sheets_values_batch_get` response as the google-workspace MCP returned it, and the mode it was read in. */
export interface RawCapture {
  mode: "values" | "formulas";
  response: {
    target: { file_id: string; name: string; modified_time?: string; revision?: string };
    result: { valueRanges: { range: string; values?: unknown[][] }[] };
  };
}

export interface AssembleOptions {
  capturedAt: string;
  /** File key (base, hritvik, ...) -> spreadsheet id. */
  files: Record<string, string>;
  authProfile: string;
}

export function tabName(range: string): string {
  const sheet = range.slice(0, range.lastIndexOf("!"));
  return sheet.startsWith("'") ? sheet.slice(1, -1).replace(/''/g, "'") : sheet;
}

function toCell(v: unknown): Cell {
  if (v === undefined || v === null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return JSON.stringify(v);
}

function pad<T>(grid: T[][], rows: number, cols: number, blank: T): T[][] {
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => grid[r]?.[c] ?? blank));
}

export function assembleSnapshot(captures: readonly RawCapture[], options: AssembleOptions): Snapshot {
  const byId = new Map(Object.entries(options.files).map(([key, id]) => [id, key]));
  const grids = new Map<string, { file: string; tab: string; range: string; values?: unknown[][]; formulas?: unknown[][] }>();
  const files: Record<string, SnapshotFile> = {};
  for (const c of captures) {
    const key = byId.get(c.response.target.file_id);
    if (!key) throw new Error(`capture from unknown spreadsheet ${c.response.target.file_id}`);
    files[key] ??= {
      spreadsheet_id: c.response.target.file_id,
      name: c.response.target.name,
      modified_time: c.response.target.modified_time ?? null,
      revision: c.response.target.revision ?? null,
      tabs: {},
    };
    for (const vr of c.response.result.valueRanges) {
      const tab = tabName(vr.range);
      const id = `${key}\u0000${tab}`;
      const entry = grids.get(id) ?? { file: key, tab, range: vr.range };
      entry[c.mode] = vr.values ?? [];
      grids.set(id, entry);
    }
  }
  for (const g of grids.values()) {
    const values = (g.values ?? []).map((row) => row.map((v) => (v === null || v === undefined ? "" : String(v))));
    const formulas = (g.formulas ?? []).map((row) => row.map(toCell));
    const rows = Math.max(values.length, formulas.length);
    const cols = Math.max(0, ...values.map((r) => r.length), ...formulas.map((r) => r.length));
    (files[g.file] as SnapshotFile).tabs[g.tab] = {
      range: g.range,
      rows,
      cols,
      values: pad(values, rows, cols, ""),
      formulas: pad<Cell>(formulas, rows, cols, ""),
    };
  }
  const sortedFiles: Record<string, SnapshotFile> = {};
  for (const key of Object.keys(files).sort()) {
    const f = files[key] as SnapshotFile;
    const tabs: Record<string, SnapshotTab> = {};
    for (const t of Object.keys(f.tabs).sort()) tabs[t] = f.tabs[t] as SnapshotTab;
    sortedFiles[key] = { ...f, tabs };
  }
  return {
    format: SNAPSHOT_FORMAT,
    version: 1,
    captured_at: options.capturedAt,
    source: { tool: "google-workspace sheets_values_batch_get", auth_profile: options.authProfile },
    files: sortedFiles,
  };
}

export interface ValidationReport {
  ok: boolean;
  problems: string[];
  tabs: { file: string; tab: string; rows: number; data_rows: number; cols: number }[];
}

const isBlank = (row: readonly Cell[]) => row.every((c) => c === "" || c === null);

/** Every expected tab present, both grids rectangular and the same shape; row counts per tab. */
export function validateSnapshot(snap: Snapshot, expected: Record<string, readonly string[]>): ValidationReport {
  const problems: string[] = [];
  const tabs: ValidationReport["tabs"] = [];
  if (![SNAPSHOT_FORMAT, LEGACY_SNAPSHOT_FORMAT].includes(snap.format) || snap.version !== 1) problems.push(`unknown snapshot format ${String(snap.format)} v${String(snap.version)}`);
  for (const [fileKey, file] of Object.entries(snap.files).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [name, tab] of Object.entries(file.tabs).sort(([a], [b]) => a.localeCompare(b))) {
      for (const grid of ["values", "formulas"] as const) {
        if (tab[grid].length !== tab.rows) problems.push(`${fileKey}/${name}: ${grid} has ${tab[grid].length} rows, expected ${tab.rows}`);
        tab[grid].forEach((row, i) => {
          if (row.length !== tab.cols) problems.push(`${fileKey}/${name}: ${grid} row ${i + 1} has ${row.length} cells, expected ${tab.cols}`);
        });
      }
      const dataRows = tab.formulas.slice(1).filter((row, i) => !isBlank(row) || !isBlank(tab.values[i + 1] ?? [])).length;
      tabs.push({ file: fileKey, tab: name, rows: tab.rows, data_rows: dataRows, cols: tab.cols });
    }
  }
  for (const [fileKey, names] of Object.entries(expected).sort(([a], [b]) => a.localeCompare(b))) {
    const file = snap.files[fileKey];
    if (!file) {
      problems.push(`${fileKey}: file missing`);
      continue;
    }
    for (const name of [...names].sort()) if (!file.tabs[name]) problems.push(`${fileKey}/${name}: tab missing`);
  }
  return { ok: problems.length === 0, problems: problems.sort(), tabs };
}
