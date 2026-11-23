/**
 * Hand-offs (redesign-a spec §2, §5): the drafts about a member, grouped as a
 * person sees them. A hand-off is one logger's food drafts for one date and
 * meal (however many sittings wrote them), or one reading, blood draw or
 * session with its sets. One logger's food hand-offs whose first writes chain
 * at most 2 hours apart, over two or more dates, are one batch with a row per
 * day. The logger is the first write's member; with none, the Inbox or Claude.
 * Pure: the one tested function that owns the grouping (spec §10), the cap
 * (cut between hand-offs, the first always kept) and the badge's count.
 */
import type { DraftInfo } from "./drafts";

export const BATCH_WINDOW_MS = 2 * 3_600_000;
export const WAITING_CAP = 100;

export type HandoffType = "food" | "session" | "reading" | "blood_draw";

const TYPE: Readonly<Record<string, HandoffType>> = {
  intake_item: "food", portion: "food", leftover_serving: "food", session: "session", session_set: "session", reading: "reading", blood_draw: "blood_draw",
};

/** Who handed it over: a member (in the app or through chat), or with none the Inbox or Claude. */
export interface Logger {
  member: number | null;
  origin: string | null;
}

export type Waits = "question" | "rir_needed" | "end_of_session" | null;

export interface Handoff {
  kind: "handoff";
  key: string;
  type: HandoffType;
  logger: Logger;
  /** Its first write. */
  loggedAt: string;
  /** The earliest deadline among its drafts; null while any of them waits (then `waits` says why). */
  deadline: string | null;
  waits: Waits;
  on: string | null;
  slot: string | null;
  drafts: DraftInfo[];
}

export interface BatchDay {
  on: string;
  handoffs: Handoff[];
}

export interface Batch {
  kind: "batch";
  key: string;
  logger: Logger;
  loggedAt: string;
  deadline: string | null;
  days: BatchDay[];
}

export type Unit = Handoff | Batch;

const loggerKey = (l: Logger): string => (l.member !== null ? `m${l.member}` : l.origin === "inbox" ? "inbox" : "claude");
const WAIT_ORDER = ["question", "rir_needed", "end_of_session"] as const;
const byTime = (a: { loggedAt: string; key: string }, b: { loggedAt: string; key: string }) => a.loggedAt.localeCompare(b.loggedAt) || a.key.localeCompare(b.key);
// ISO timestamps compare lexically; drafts.ts emits one format.
const earliest = (xs: readonly (string | null)[]): string | null => xs.filter((x): x is string => x !== null).sort()[0] ?? null;

function handoffOf(key: string, type: HandoffType, drafts: DraftInfo[]): Handoff {
  const first = drafts[0] as DraftInfo;
  const waits = WAIT_ORDER.find((w) => drafts.some((d) => d.waits === w)) ?? null;
  return {
    kind: "handoff", key, type, logger: { member: first.loggedBy, origin: first.origin },
    loggedAt: [...drafts.map((d) => d.createdAt)].sort()[0] ?? "",
    deadline: waits ? null : earliest(drafts.map((d) => d.deadline)),
    waits, on: first.on, slot: type === "food" ? first.slot : null, drafts,
  };
}

function batchOf(chain: Handoff[]): Batch {
  const first = chain[0] as Handoff;
  const dates = [...new Set(chain.map((h) => h.on ?? ""))].sort();
  return {
    kind: "batch", key: `${loggerKey(first.logger)}|batch|${first.loggedAt}`, logger: first.logger, loggedAt: first.loggedAt,
    deadline: earliest(chain.map((h) => h.deadline)),
    days: dates.map((on) => ({ on, handoffs: chain.filter((h) => (h.on ?? "") === on) })),
  };
}

/** The drafts about one member (drafts.ts's snapshot, visibility already applied), as hand-offs and batches, oldest first. */
export function groupHandoffs(drafts: readonly DraftInfo[]): Unit[] {
  const groups = new Map<string, { type: HandoffType; drafts: DraftInfo[] }>();
  for (const d of drafts) {
    const type = TYPE[d.table];
    if (!type) continue;
    const tail = type === "food" ? `${d.on}|${d.slot}` : type === "session" ? `${d.parent ?? d.id}` : `${d.id}`;
    const key = `${loggerKey({ member: d.loggedBy, origin: d.origin })}|${type}|${tail}`;
    const g = groups.get(key);
    if (g) g.drafts.push(d);
    else groups.set(key, { type, drafts: [d] });
  }
  const handoffs = [...groups].map(([key, g]) => handoffOf(key, g.type, g.drafts)).sort(byTime);
  const units: Unit[] = handoffs.filter((h) => h.type !== "food");
  const food = new Map<string, Handoff[]>();
  for (const h of handoffs.filter((x) => x.type === "food")) food.set(loggerKey(h.logger), [...(food.get(loggerKey(h.logger)) ?? []), h]);
  for (const list of food.values()) {
    let chain: Handoff[] = [];
    const flush = () => {
      if (new Set(chain.map((h) => h.on)).size >= 2) units.push(batchOf(chain));
      else units.push(...chain);
      chain = [];
    };
    for (const h of list) {
      const prev = chain[chain.length - 1];
      if (prev && Date.parse(h.loggedAt) - Date.parse(prev.loggedAt) > BATCH_WINDOW_MS) flush();
      chain.push(h);
    }
    flush();
  }
  return units.sort(byTime);
}

export const unitDrafts = (u: Unit): DraftInfo[] => (u.kind === "batch" ? u.days.flatMap((d) => d.handoffs.flatMap((h) => h.drafts)) : u.drafts);

/** Whole units, in order, while the drafts kept stay at or under `cap`; the first unit always (ruling 3). */
export function capHandoffs(units: readonly Unit[], cap = WAITING_CAP): { kept: Unit[]; truncated: boolean } {
  const kept: Unit[] = [];
  let n = 0;
  for (const u of units) {
    const size = unitDrafts(u).length;
    if (kept.length > 0 && n + size > cap) return { kept, truncated: true };
    kept.push(u);
    n += size;
  }
  return { kept, truncated: false };
}

/** Rows the badge counts for these units: a batch counts its days. */
export const unitsCount = (units: readonly Unit[]): number => units.reduce((n, u) => n + (u.kind === "batch" ? u.days.length : 1), 0);

/** The badge (spec §2): open asks, hand-offs (a batch its days) and settle rows, over everything, kept or not. */
export const waitingCount = (p: { asks: number; units: readonly Unit[]; settle: number }): number => p.asks + unitsCount(p.units) + p.settle;
