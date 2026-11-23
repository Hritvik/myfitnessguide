/**
 * One rehearsal: snapshot in -> a local database loaded through the
 * Worker, rulings, parity report and final-load SQL out. Deterministic: the
 * same snapshot, members and prior rulings give byte-identical output.
 */
import type { GapEntry } from "./cadences";
import type { MembersConfig } from "./members";
import { Loader } from "./load/context";
import { parity, parityMarkdown, type ParityReport } from "./parity";
import { STAGES } from "./load";
import { loadedCounts, sqlDump, type SqlChunk } from "./dump";
import { RulingBook, writeRulings, type Ruling } from "./rulings";
import type { Snapshot } from "./snapshot";
import { LocalDb } from "./sqlite";

export interface RehearseInput {
  snapshot: Snapshot;
  members: MembersConfig;
  previousRulings?: readonly Ruling[];
  /** Database file; default in memory. */
  dbPath?: string;
  /** The old gap_registry to seed as measurement cadences (rehearse-cli reads shared/config.yml). */
  gapRegistry?: GapEntry[];
  /** The snapshot's file name, written into the outputs. */
  snapshotName?: string;
}

export interface Rehearsal {
  db: LocalDb;
  loader: Loader;
  rulings: Ruling[];
  rulingsYaml: string;
  parity: ParityReport;
  parityJson: string;
  parityMd: string;
  sql: SqlChunk[];
  /** Rows loaded per table. */
  counts: Record<string, number>;
}

export async function rehearse(input: RehearseInput): Promise<Rehearsal> {
  const db = new LocalDb(input.dbPath ?? ":memory:");
  const book = new RulingBook(input.previousRulings ?? []);
  const loader = new Loader(db, input.snapshot, book, input.members);
  loader.gapRegistry = input.gapRegistry ?? null;
  for (const stage of STAGES) await stage(loader);
  const name = input.snapshotName ?? input.snapshot.captured_at;
  const counts = loadedCounts(db);
  const report = await parity(loader, name, counts);
  const rulings = book.all();
  return {
    db, loader, rulings, rulingsYaml: writeRulings(name, rulings),
    parity: report, parityJson: `${JSON.stringify(report, null, 2)}\n`, parityMd: parityMarkdown(report),
    sql: sqlDump(db),
    counts,
  };
}
