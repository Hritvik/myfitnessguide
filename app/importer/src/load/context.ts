/**
 * What every load stage shares: the snapshot, the local database, the
 * ruling book, the members, and `write`, which sends one record through the
 * Worker's own validation and turns any refusal into a ruling.
 */
import { importWrite, type ImportResponse } from "@myfitnessguide/worker/importing";
import { colLetter, Row, Sheet } from "../grid";
import type { GapEntry } from "../cadences";
import type { MembersConfig } from "../members";
import { decodeRangeSerial, parseDate, parseNumber, parseTime, ParseError, type Repair } from "../parse";
import { originKey, type Origin, type RulingBook } from "../rulings";
import type { Snapshot } from "../snapshot";
import type { LocalDb } from "../sqlite";

export interface CreatedRecord {
  table: string;
  id: number;
  tool: string;
}

export class Loader {
  readonly at: string;
  /** Records created per origin row, for the parity report. */
  readonly records = new Map<string, CreatedRecord[]>();
  /** Free-form facts stages hand to later stages and to parity (keyed by name). */
  readonly facts = new Map<string, unknown>();
  /** The old gap_registry, seeded as measurement cadences; null = none given. */
  gapRegistry: GapEntry[] | null = null;
  writes = 0;

  constructor(
    readonly db: LocalDb,
    readonly snap: Snapshot,
    readonly book: RulingBook,
    readonly members: MembersConfig,
  ) {
    this.at = snap.captured_at;
  }

  sheet(file: string, tab: string): Sheet | null {
    return Sheet.of(this.snap, file, tab);
  }

  origin(row: Row): Origin {
    return { file: row.tab.file, tab: row.tab.name, row: row.n };
  }

  memberOfFile(file: string): string | null {
    return this.members.members.find((m) => m.file === file)?.name ?? null;
  }

  record(origin: Origin, rec: CreatedRecord): void {
    const key = originKey(origin);
    const list = this.records.get(key) ?? [];
    list.push(rec);
    this.records.set(key, list);
  }

  recordsOf(origin: Origin): CreatedRecord[] {
    return this.records.get(originKey(origin)) ?? [];
  }

  /**
   * One write through the Worker. A refusal (schema, clarification, rule,
   * constraint) becomes a semantic ruling with no proposal, so the row is
   * left out until someone decides it; nothing is dropped silently.
   */
  async write(
    tool: string,
    input: Record<string, unknown>,
    origin: Origin,
    options: { detail?: Record<string, unknown>; reason?: string; evidence?: Row | null; key?: string } = {},
  ): Promise<ImportResponse | null> {
    const res = await importWrite(this.db, tool, input, {
      at: this.at,
      origin,
      ...(options.reason ? { reason: options.reason } : {}),
      ...(options.detail ? { detail: options.detail } : {}),
    });
    if (res.status === "ok") {
      this.writes++;
      return res;
    }
    this.book.raise({
      origin,
      code: "rejected_by_api",
      ...(options.key ? { key: options.key } : { key: tool }),
      kind: "semantic",
      problem: `${tool} refused it: ${describeRefusal(res)}`,
      proposed_fix: "Correct the row (or decide it is left out); the API's validation is the rule imported data must meet.",
      proposal: null,
      row: options.evidence ? options.evidence.cells(evidenceCols(options.evidence)) : {},
    });
    return null;
  }
}

export function describeRefusal(res: ImportResponse): string {
  if (res.status === "needs_clarification") return `${String(res.reason)}: ${String(res.question)}`;
  if (res.status === "invalid") return `invalid input: ${(res.issues as { path: unknown[]; message: string }[]).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`;
  const error = res.error as { code?: string; message?: string } | undefined;
  return `${error?.code ?? res.status}: ${error?.message ?? ""}`.trim();
}

function evidenceCols(row: Row): string[] {
  return Array.from({ length: Math.min(row.tab.data.cols, 40) }, (_, i) => colLetter(i));
}

const REPAIR_TEXT: Record<Repair, string> = {
  text_number: "a number stored as text",
  text_date: "a date stored as text",
  rir_date_serial: "an RIR range Sheets stored as a date serial",
  range_date_serial: "a rep range Sheets stored as a date serial",
};

/**
 * Reads one row's typed cells, noting every repair, then records them as
 * mechanical rulings (one per row for text values; one per cell for date
 * serials, which change the value).
 */
export class RowReader {
  private readonly repairs = new Map<string, Repair>();
  private readonly serials: { col: string; raw: number; low: number; high: number; what: "RIR" | "rep range" }[] = [];

  constructor(
    readonly loader: Loader,
    readonly row: Row,
  ) {}

  get origin(): Origin {
    return this.loader.origin(this.row);
  }

  num(col: string): number | null {
    const p = parseNumber(this.row.raw(col));
    if (p.repair) this.repairs.set(col, p.repair);
    return p.value;
  }

  date(col: string): string | null {
    const p = parseDate(this.row.raw(col));
    if (p.repair) this.repairs.set(col, p.repair);
    return p.value;
  }

  time(col: string): string | null {
    const p = parseTime(this.row.raw(col));
    if (p.repair) this.repairs.set(col, "text_date");
    return p.value;
  }

  note(col: string, repair: Repair): void {
    this.repairs.set(col, repair);
  }

  serial(col: string, raw: number, what: "RIR" | "rep range"): void {
    const decoded = decodeRangeSerial(raw);
    if (decoded) this.serials.push({ col, raw, ...decoded, what });
  }

  /** Record this row's repairs as mechanical rulings. */
  flush(): void {
    const text = [...this.repairs.entries()].filter(([, r]) => r === "text_number" || r === "text_date").map(([c]) => c).sort();
    if (text.length > 0) {
      this.loader.book.raise({
        origin: this.origin,
        code: "stored_as_text",
        kind: "mechanical",
        problem: `${text.map((c) => `${c} is ${REPAIR_TEXT[this.repairs.get(c) as Repair]}`).join("; ")}`,
        proposed_fix: "Read the text as the number or date it spells.",
        proposal: { columns: text },
        row: this.row.cells(text),
      });
    }
    for (const s of this.serials) {
      this.loader.book.raise({
        origin: this.origin,
        code: s.what === "RIR" ? "rir_date_serial" : "range_date_serial",
        key: s.col,
        kind: "mechanical",
        problem: `${s.col} holds ${s.raw}, the date serial Sheets stored when "${s.low}-${s.high}" was typed`,
        proposed_fix: `Decode it back to the ${s.what} ${s.low}-${s.high}.`,
        proposal: { low: s.low, high: s.high },
        row: this.row.cells([s.col]),
      });
    }
  }
}

export { ParseError };
