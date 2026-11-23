#!/usr/bin/env -S npx tsx
/**
 * gym-import: the one-time Sheets -> D1 import, run on the work Mac.
 *
 *   assemble --raw <dir> [--captured-at <iso>] [--out <file>]
 *       Build a snapshot from saved sheets_values_batch_get responses
 *       (<file>-<values|formulas>-*.json) and validate it.
 *   validate <snapshot>
 *   rehearse <snapshot> [--db <file>] [--rulings <file>] [--members <file>]
 *       Transform and load into a local SQLite database through the Worker,
 *       then write rulings.yaml, parity.md, parity.json and the final-load
 *       SQL next to the snapshot. Never touches D1.
 *
 * Every output is household data and is written outside the repo.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { basicTimestamp, EXPECTED_TABS, SNAPSHOT_DIR, spreadsheetIds } from "./layout";
import { writePrivate } from "./write-private";
import { assembleSnapshot, validateSnapshot, type RawCapture, type Snapshot } from "./snapshot";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function printValidation(snap: Snapshot): boolean {
  const report = validateSnapshot(snap, EXPECTED_TABS);
  for (const t of report.tabs) console.log(`${t.file.padEnd(8)} ${t.tab.padEnd(20)} ${String(t.data_rows).padStart(4)} data rows  (${t.rows} x ${t.cols})`);
  for (const p of report.problems) console.log(`PROBLEM ${p}`);
  console.log(report.ok ? "snapshot valid" : `snapshot INVALID: ${report.problems.length} problems`);
  return report.ok;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === "assemble") {
    const raw = arg(args, "--raw");
    if (!raw) throw new Error("--raw <dir> is required");
    const capturedAt = arg(args, "--captured-at") ?? basename(raw).replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})Z$/, "$1:$2:$3Z");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(capturedAt)) throw new Error(`capture time ${capturedAt} is not an ISO UTC timestamp; pass --captured-at`);
    const captures: RawCapture[] = readdirSync(raw)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => {
        const mode = f.includes("-formulas-") ? "formulas" : f.includes("-values-") ? "values" : null;
        if (!mode) throw new Error(`${f}: name must contain -values- or -formulas-`);
        return { mode, response: JSON.parse(readFileSync(join(raw, f), "utf8")) } as RawCapture;
      });
    const snap = assembleSnapshot(captures, { capturedAt, files: spreadsheetIds(), authProfile: "user-primary" });
    const out = arg(args, "--out") ?? join(SNAPSHOT_DIR, `${basicTimestamp(capturedAt)}.json`);
    writePrivate(out, `${JSON.stringify(snap)}\n`);
    console.log(`wrote ${out}`);
    return printValidation(snap) ? 0 : 1;
  }
  if (command === "validate") {
    const path = args[0];
    if (!path) throw new Error("validate <snapshot>");
    return printValidation(JSON.parse(readFileSync(path, "utf8")) as Snapshot) ? 0 : 1;
  }
  if (command === "rehearse") {
    const { rehearseCommand } = await import("./rehearse-cli");
    return rehearseCommand(args);
  }
  console.error("usage: gym-import assemble|validate|rehearse ...");
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
