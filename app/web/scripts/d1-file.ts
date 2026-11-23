/**
 * A Worker's local D1 as a file, read-only (e2e spec §3): Miniflare keeps it
 * as one SQLite file under the persist directory. Reading the file needs no
 * wrangler (`d1 export --local` takes no --persist-to in 4.147.0) and can't
 * write to the copy. The seed's checks and the suite's d1.ts both read
 * through it.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openD1(persist: string): DatabaseSync {
  const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (files.length !== 1) throw new Error(`Expected one D1 database in ${dir}, found ${files.length}`);
  return new DatabaseSync(join(dir, files[0]!), { readOnly: true });
}
