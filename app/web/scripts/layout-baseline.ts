/**
 * `node scripts/layout-baseline.ts [--init]`: writes test/layout-baseline.json,
 * the layout lints' counts per file (wide-layout spec §3). It only ever lowers
 * a count: if any rose, it prints them and writes nothing (wrap the text in
 * <Text>, or move the structure into a primitive). --init writes the first one.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countViolations, WEB, type Counts } from "../test/layout-lint.ts";

const path = join(WEB, "test", "layout-baseline.json");
const now = countViolations();
if (!process.argv.includes("--init") && existsSync(path)) {
  const old = JSON.parse(readFileSync(path, "utf8")) as Counts;
  const rose = (["text", "structure"] as const).flatMap((k) =>
    Object.entries(now[k])
      .filter(([f, n]) => n > (old[k][f] ?? 0))
      .map(([f, n]) => `${k} ${f}: ${old[k][f] ?? 0} -> ${n}`),
  );
  if (rose.length > 0) {
    console.error(`Not written: a count rose.\n${rose.join("\n")}`);
    process.exit(1);
  }
}
writeFileSync(path, `${JSON.stringify(now, null, 2)}\n`);
const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
console.log(`Wrote ${path}: text ${sum(now.text)} in ${Object.keys(now.text).length} files, structure ${sum(now.structure)}.`);
