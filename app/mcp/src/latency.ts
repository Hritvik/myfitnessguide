// After a deploy: p50/p95 of the calls the app makes while a member types or
// saves (spec §10), against the deployed API with the service token.
// Inputs come from a JSON file Hritvik writes with real refs:
//   { "what_if": {...}, "preview_set": {...}, "preview_meal": {...},
//     "route_text": {...}, "commit_route": {...} }
//   npm run latency -w @myfitnessguide/mcp -- inputs.json [runs] [--writes --date YYYY-MM-DD]
// The reads (what_if, preview_set, preview_meal, route_text) write nothing.
// commit_route is a write: it runs only with --writes, which also needs an
// explicit --date at least 30 days from today (past or future), so no run
// lands on a real day, and at most 5 write runs. Each run has a fresh
// idempotency key, so every run saves its pieces again on that date; remove
// what it wrote afterwards. Cook pieces are refused in these inputs: they add
// a portion to a real pot whatever the date. The first run of each tool is printed apart
// (route_text's cold CPU against the Free plan's 10 ms is the open question),
// and it still counts in the percentiles.
import { readFileSync } from "node:fs";
import { ApiClient } from "./api.ts";
import { loadConfig } from "./config.ts";

export const READS = ["what_if", "preview_set", "preview_meal", "route_text"] as const;
export const WRITES = ["commit_route"] as const;
type Measured = (typeof READS)[number] | (typeof WRITES)[number];

/** The most write runs one invocation may make. */
export const MAX_WRITE_RUNS = 5;
/** How far from today a write run's date must be, in days. */
export const WRITE_DATE_MARGIN_DAYS = 30;

/** Nearest-rank percentiles of a list of durations; null when there are none. */
export function percentiles(ms: readonly number[]): { p50: number | null; p95: number | null; n: number } {
  if (ms.length === 0) return { p50: null, p95: null, n: 0 };
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] as number;
  return { p50: at(50), p95: at(95), n: sorted.length };
}

export interface LatencyArgs {
  file: string;
  runs: number;
  writes: boolean;
  /** The date commit_route writes on; null without --writes. */
  date: string | null;
}

const DAY_MS = 86_400_000;
const isoDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/**
 * The command line, checked before anything is called: runs a positive whole number, and
 * --writes only with an explicit --date at least 30 days from `today` and at most 5 runs.
 * Returns the arguments, or the reason it refuses.
 */
export function parseLatencyArgs(argv: readonly string[], today: string): LatencyArgs | { error: string } {
  const rest: string[] = [];
  let writes = false;
  let date: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--writes") writes = true;
    else if (a === "--date") {
      const v = argv[i + 1];
      if (v === undefined || !isoDay(v)) return { error: "--date needs a date as YYYY-MM-DD" };
      date = v;
      i++;
    } else rest.push(a);
  }
  const [file, runsArg, extra] = rest;
  if (!file || extra !== undefined) return { error: "usage: latency.ts inputs.json [runs] [--writes --date YYYY-MM-DD]" };
  const runs = runsArg === undefined ? (writes ? MAX_WRITE_RUNS : 30) : /^\d+$/.test(runsArg) ? Number(runsArg) : Number.NaN;
  if (!Number.isInteger(runs) || runs < 1) return { error: `runs must be a whole number of at least 1, not "${runsArg}"` };
  if (!writes) {
    if (date !== null) return { error: "--date is only for --writes" };
    return { file, runs, writes, date: null };
  }
  if (date === null) return { error: "--writes needs an explicit --date YYYY-MM-DD, at least 30 days from today" };
  const away = Math.abs(Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS;
  if (away < WRITE_DATE_MARGIN_DAYS) return { error: `--date ${date} is within ${WRITE_DATE_MARGIN_DAYS} days of today (${today}); pick a date at least that far away` };
  if (runs > MAX_WRITE_RUNS) return { error: `--writes runs at most ${MAX_WRITE_RUNS} times, not ${runs}` };
  return { file, runs, writes, date };
}

/**
 * A `cook` piece in a write input adds a portion to a real pot whatever the date, so --writes refuses it.
 * Returns the reason, or null when the input is fine.
 */
export function refuseCookPieces(input: Record<string, unknown> | undefined): string | null {
  const pieces = input?.pieces;
  if (!Array.isArray(pieces)) return null;
  const at = pieces.findIndex((p) => (p as { entry?: { kind?: unknown } } | null)?.entry?.kind === "cook");
  return at < 0 ? null : `commit_route piece ${at + 1} is a cook piece: it adds a portion to a real pot whatever --date says; remove it from the --writes input (items and sets only)`;
}

const ms0 = (v: number | null) => (v === null ? "-" : `${Math.round(v)} ms`);

if (process.argv[1]?.endsWith("latency.ts")) {
  const parsed = parseLatencyArgs(process.argv.slice(2), new Date().toISOString().slice(0, 10));
  if ("error" in parsed) {
    process.stderr.write(`[latency] ${parsed.error}\n`);
    process.exit(2);
  }
  const { file, runs, writes, date } = parsed;
  const inputs = JSON.parse(readFileSync(file, "utf8")) as Partial<Record<Measured, Record<string, unknown>>>;
  const config = loadConfig();
  const api = new ApiClient({ baseUrl: config.baseUrl, tokenFile: config.tokenFile, log: (l) => process.stderr.write(`[latency] ${l}\n`) });
  if (!writes && inputs.commit_route) process.stderr.write("[latency] commit_route skipped: it writes; pass --writes --date YYYY-MM-DD to measure it.\n");
  // A write invocation measures only the write, so its few runs go to it alone.
  if (writes) {
    const refusal = refuseCookPieces(inputs.commit_route);
    if (refusal) {
      process.stderr.write(`[latency] ${refusal}\n`);
      process.exit(2);
    }
  }
  const tools: Measured[] = writes ? [...WRITES] : [...READS];
  for (const tool of tools) {
    const input = inputs[tool];
    if (!input) continue;
    const ms: number[] = [];
    for (let i = 0; i < runs; i++) {
      const body = (WRITES as readonly string[]).includes(tool) ? { ...input, date, idempotency_key: `latency-${Date.now()}-${i}` } : input;
      const t = performance.now();
      const reply = await api.request("POST", `/tools/${tool}`, body);
      ms.push(performance.now() - t);
      if (reply.kind !== "json" || reply.body.status !== "ok") throw new Error(`${tool}: ${JSON.stringify(reply)}`);
    }
    const p = percentiles(ms);
    process.stdout.write(`${tool}: first ${ms0(ms[0] ?? null)}, p50 ${ms0(p.p50)}, p95 ${ms0(p.p95)} (${p.n} runs)\n`);
  }
}
