/**
 * Rulings: every row that fails validation or mapping, with its origin, the
 * problem, a proposed fix, its kind and a decision. Nothing is dropped
 * silently.
 *
 * - Mechanical rulings (ticket *Import design*) are decided by the importer:
 *   numbers and dates stored as text, RIR stored as date serials, legacy
 *   DAY TOTAL rows, superseded Guide facts as older note versions. Parity
 *   differences whose cause *Parity gate* already names (a listed sheet bug,
 *   a missing formula, display rounding of a load) are mechanical too.
 * - Semantic rulings stay `pending` until Hritvik decides them.
 *
 * Decisions in an existing rulings.yaml are re-applied on every run (keyed
 * by ruling id), so a run is deterministic, but only to the row they were
 * decided on: each decided ruling carries `decided_on`, a hash of the cells
 * it records. When the row has changed since, the ruling is raised again as
 * `pending`, with the old decision (and the row it was made on) kept in
 * `previous_decision` until it is decided again. A decision without a hash
 * takes it from the row stored beside it; one that recorded no row at all
 * (a parity ruling written by hand) cannot be compared and is kept.
 *
 * Resolution: `accepted` applies the proposal (or `override` when given),
 * `rejected` leaves the row out of the load. While a semantic ruling is
 * `pending` its proposal is applied provisionally, so the rehearsal shows
 * the fullest picture; a pending ruling with no proposal leaves the row out.
 * Either way the gate cannot pass while anything is pending.
 */
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import type { Cell } from "./snapshot";

export type Kind = "mechanical" | "semantic";
export type Decision = "pending" | "accepted" | "rejected";
export type Cause = "sheet-bug" | "missing-formula" | "rounding" | "typed-error" | "manual-macros";
export const CAUSES: readonly Cause[] = ["sheet-bug", "missing-formula", "rounding", "typed-error", "manual-macros"];

export interface Origin {
  file: string;
  tab: string;
  row: number;
}

export interface Ruling {
  id: string;
  origin: Origin;
  code: string;
  kind: Kind;
  cause: Cause | null;
  problem: string;
  proposed_fix: string;
  proposal: unknown;
  decision: Decision;
  decided_by: string | null;
  /** Hash of `row` when the decision was made (or confirmed); null while pending. */
  decided_on?: string | null;
  override: unknown;
  /** Day affected (missing-formula rulings list it, since that day's Sheets totals were under-reported). */
  day: string | null;
  /** The cells of the row the ruling is about. */
  row: Record<string, Cell>;
  note: string | null;
  /** The decision this ruling had before its row changed, until it is decided again. */
  previous_decision?: PreviousDecision | null;
}

export interface PreviousDecision {
  decision: Decision;
  decided_by: string | null;
  override: unknown;
  note: string | null;
  /** The row the decision was made on. */
  row: Record<string, Cell>;
}

/** A short, order-independent hash of a ruling's recorded cells. */
export function rowHash(row: Record<string, Cell>): string {
  const canonical = JSON.stringify(Object.keys(row).sort().map((k) => [k, row[k] ?? null]));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

const hasCells = (row: Record<string, Cell> | undefined): row is Record<string, Cell> => !!row && Object.keys(row).length > 0;

export interface RaiseInput {
  origin: Origin;
  code: string;
  /** Distinguishes several rulings of one code on one row (a column, a metric). */
  key?: string;
  kind: Kind;
  cause?: Cause;
  problem: string;
  proposed_fix: string;
  /** What the importer applies when the ruling is accepted (or provisionally while pending). Null = leave the row out. */
  proposal: unknown;
  day?: string;
  row?: Record<string, Cell>;
}

export interface Resolution<T> {
  ruling: Ruling;
  /** False when the row must be left out of the load. */
  apply: boolean;
  value: T;
}

export function originKey(o: Origin): string {
  return `${o.file}/${o.tab}!${o.row}`;
}

export function rulingId(origin: Origin, code: string, key?: string): string {
  return `${originKey(origin)}/${code}${key ? `/${key}` : ""}`;
}

export interface Prior {
  decision: Decision;
  decided_by: string | null;
  override: unknown;
  note: string | null;
  cause: Cause | null;
  /** What the decision was made on: the stored hash, else the stored row's; null = not comparable (kept). */
  hash: string | null;
  row: Record<string, Cell>;
  previous_decision: PreviousDecision | null;
}

export const MECHANICAL_DECIDER = "importer (mechanical, ticket 11 / 09)";

export class RulingBook {
  private readonly prior = new Map<string, Prior>();
  private readonly raised = new Map<string, Ruling>();
  /** Decided rulings from the file that this run no longer raised; kept so no decision is lost. */
  private readonly carried = new Map<string, Ruling>();

  constructor(previous: readonly Ruling[] = []) {
    for (const r of previous) {
      this.prior.set(r.id, {
        decision: r.decision, decided_by: r.decided_by, override: r.override ?? null, note: r.note ?? null, cause: r.cause ?? null,
        hash: r.decided_on ?? (hasCells(r.row) ? rowHash(r.row) : null), row: r.row ?? {}, previous_decision: r.previous_decision ?? null,
      });
      if (r.decision !== "pending") this.carried.set(r.id, r);
    }
  }

  raise<T>(input: RaiseInput): Resolution<T> {
    const id = rulingId(input.origin, input.code, input.key);
    const row = input.row ?? {};
    const hash = rowHash(row);
    let prior = this.prior.get(id);
    let previous: PreviousDecision | null = null;
    if (prior && prior.decision === "pending") previous = prior.previous_decision;
    else if (prior && prior.decided_by !== MECHANICAL_DECIDER && prior.hash !== null && prior.hash !== hash) {
      // Decided on a row that has changed since: ask again, showing what was decided.
      previous = { decision: prior.decision, decided_by: prior.decided_by, override: prior.override, note: prior.note, row: prior.row };
      prior = undefined;
    }
    const mechanical = input.kind === "mechanical";
    const ruling: Ruling = {
      id,
      origin: input.origin,
      code: input.code,
      kind: input.kind,
      cause: prior?.cause ?? input.cause ?? null,
      problem: input.problem,
      proposed_fix: input.proposed_fix,
      proposal: input.proposal ?? null,
      decision: prior?.decision ?? (mechanical ? "accepted" : "pending"),
      decided_by: prior?.decided_by ?? (mechanical ? MECHANICAL_DECIDER : null),
      decided_on: null,
      override: prior?.override ?? null,
      day: input.day ?? null,
      row,
      note: prior?.note ?? null,
      previous_decision: null,
    };
    if (ruling.decision === "pending") ruling.previous_decision = previous;
    else ruling.decided_on = hash;
    this.raised.set(id, ruling);
    this.carried.delete(id);
    const value = (ruling.override ?? ruling.proposal) as T;
    const apply = ruling.decision !== "rejected" && value !== null && value !== undefined;
    return { ruling, apply, value };
  }

  /** The decision rulings.yaml held for an id before this run. */
  previous(id: string): Prior | undefined {
    return this.prior.get(id);
  }

  /** A ruling raised earlier in this run, by id. */
  get(id: string): Ruling | undefined {
    return this.raised.get(id);
  }

  /** Explicit parity rulings someone added by hand (origin + metric + cause), carried from the file. */
  carriedRulings(): Ruling[] {
    return [...this.carried.values()];
  }

  all(): Ruling[] {
    const carried = [...this.carried.values()].map((r) => ({
      ...r, decided_on: r.decided_on ?? (hasCells(r.row) ? rowHash(r.row) : null), previous_decision: r.previous_decision ?? null,
    }));
    return [...this.raised.values(), ...carried].sort((a, b) => compareIds(a.id, b.id));
  }
}

/** Order ids by file, tab, row number (numerically), then the rest. */
export function compareIds(a: string, b: string): number {
  const pa = /^([^/]+)\/([^!]+)!(\d+)(.*)$/.exec(a);
  const pb = /^([^/]+)\/([^!]+)!(\d+)(.*)$/.exec(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  for (const [x, y] of [[pa[1], pb[1]], [pa[2], pb[2]]] as [string, string][]) if (x !== y) return x < y ? -1 : 1;
  const d = Number(pa[3]) - Number(pb[3]);
  if (d !== 0) return d;
  return (pa[4] as string) < (pb[4] as string) ? -1 : (pa[4] as string) > (pb[4] as string) ? 1 : 0;
}

export interface RulingsFile {
  version: 1;
  snapshot: string;
  summary: Record<string, number>;
  rulings: Ruling[];
}

export function summarise(rulings: readonly Ruling[]): Record<string, number> {
  const s: Record<string, number> = { total: rulings.length, mechanical: 0, semantic: 0, pending: 0, accepted: 0, rejected: 0 };
  for (const r of rulings) {
    s[r.kind] = (s[r.kind] ?? 0) + 1;
    s[r.decision] = (s[r.decision] ?? 0) + 1;
  }
  return s;
}

export function writeRulings(snapshot: string, rulings: readonly Ruling[]): string {
  const doc: RulingsFile = { version: 1, snapshot, summary: summarise(rulings), rulings: [...rulings] };
  const header = [
    "# Import rulings. Decide each semantic ruling: set decision to accepted (apply proposal,",
    "# or `override` when set) or rejected (leave the row out). Mechanical rulings are",
    "# decided by the importer. Decisions are re-applied on every run, keyed by id, while",
    "# the row they were decided on (decided_on) is unchanged; otherwise the ruling is",
    "# pending again, with the old decision under previous_decision.",
    "# Household data: never commit this file.",
  ].join("\n");
  return `${header}\n${stringify(doc, { lineWidth: 0, sortMapEntries: false, aliasDuplicateObjects: false })}`;
}

export function readRulings(text: string): Ruling[] {
  const doc = parse(text) as Partial<RulingsFile> | null;
  return (doc?.rulings ?? []).map((r) => ({
    ...r, override: r.override ?? null, note: r.note ?? null, cause: r.cause ?? null, decided_on: r.decided_on ?? null, previous_decision: r.previous_decision ?? null,
  }));
}
