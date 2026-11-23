/** `gym-import rehearse`: see cli.ts. */
import { readGapRegistry } from "./cadences";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MEMBERS_FILE } from "./layout";
import { isPlaceholder, loadMembers } from "./members";
import { rehearse } from "./rehearse";
import { readRulings } from "./rulings";
import type { Snapshot } from "./snapshot";
import { writePrivate } from "./write-private";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function rehearseCommand(args: string[]): Promise<number> {
  const snapshotPath = args[0];
  if (!snapshotPath || snapshotPath.startsWith("--")) throw new Error("rehearse <snapshot> [--db <file>] [--rulings <file>] [--members <file>]");
  const dir = dirname(snapshotPath);
  const stem = basename(snapshotPath, ".json");
  const outDir = join(dir, stem);
  const rulingsPath = arg(args, "--rulings") ?? join(outDir, "rulings.yaml");
  const membersPath = arg(args, "--members") ?? MEMBERS_FILE;
  const { config, created } = loadMembers(membersPath);
  if (created) {
    writePrivate(membersPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`created ${membersPath} with PLACEHOLDER emails; fill in the real ones before the final load`);
  } else if (isPlaceholder(config)) {
    console.log(`${membersPath} still has placeholder emails`);
  }
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;
  const previous = existsSync(rulingsPath) ? readRulings(readFileSync(rulingsPath, "utf8")) : [];
  const r = await rehearse({ snapshot, members: config, previousRulings: previous, gapRegistry: readGapRegistry(), dbPath: arg(args, "--db") ?? join(outDir, "rehearsal.sqlite"), snapshotName: basename(snapshotPath) });
  writePrivate(rulingsPath, r.rulingsYaml);
  writePrivate(join(outDir, "parity.json"), r.parityJson);
  writePrivate(join(outDir, "parity.md"), r.parityMd);
  console.log(`wrote ${rulingsPath}, parity.md and parity.json in ${outDir}`);
  const sqlDir = join(outDir, "final-load");
  rmSync(sqlDir, { recursive: true, force: true });
  for (const chunk of r.sql) writePrivate(join(sqlDir, chunk.name), chunk.sql);
  console.log(`wrote ${r.sql.length} final-load SQL files (${r.sql.reduce((n, c) => n + c.rows, 0)} rows) in ${sqlDir}; NOT executed`);
  const composed = r.db.get<{ n: number }>("SELECT count(*) AS n FROM session_set WHERE plates IS NOT NULL")?.n ?? 0;
  console.log(`sets imported as compositions: ${composed}`);
  console.log(`parity gate: ${r.parity.gate} (${r.parity.summary.unexplained} unexplained, ${r.parity.summary.pending_rulings} pending rulings)`);
  r.db.close();
  return 0;
}
