/**
 * The old `gap_registry` (shared/config.yml) -> measurement cadences, through
 * set_measurement_cadence. The registry is configuration, not a sheet, so
 * its origin is `config/gap_registry!<n>` (n is the entry's 1-based
 * position). It was Hritvik's: its sources point at his person file's tabs,
 * whose headers say what each column holds.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { SHARED_CONFIG } from "./layout";
import { bodyColumnSpec } from "./load/body";
import type { Loader } from "./load/context";
import type { Origin } from "./rulings";

const ENTRY = z
  .object({
    name: z.string().min(1),
    every_days: z.number().int().positive(),
    source: z
      .object({ tab: z.string().min(1), column: z.string().optional(), match: z.object({ exercise: z.string().min(1) }).optional() })
      .loose(),
    message: z.string().min(1),
  })
  .loose();

export type GapEntry = z.infer<typeof ENTRY>;

/** The registry's entries, from the text of a config file. Empty when it has none. */
export function parseGapRegistry(yamlText: string): GapEntry[] {
  const config = parse(yamlText) as { gap_registry?: unknown } | null;
  return z.array(ENTRY).parse(config?.gap_registry ?? []);
}

export function readGapRegistry(path = SHARED_CONFIG): GapEntry[] {
  return parseGapRegistry(readFileSync(path, "utf8"));
}

/** The file whose tabs the registry's sources name. */
const REGISTRY_FILE = "hritvik";

type Source =
  | { kind: "reading"; metric: string; body_state?: "fasted" }
  | { kind: "cardio_hr" }
  | { kind: "exercise"; exercise: string }
  | { kind: "manual" };

/** Where the app keeps what a registry source pointed at; null when it can't tell. */
function mapSource(ld: Loader, entry: GapEntry): Source | null {
  const { tab, column, match } = entry.source;
  if (tab.toLowerCase() === "log" && match?.exercise) return { kind: "exercise", exercise: match.exercise };
  if (!column) return null;
  const header = (tabName: string) => ld.sheet(REGISTRY_FILE, tabName)?.row(1).text(column) ?? "";
  if (tab.toLowerCase() === "body") {
    const title = header("Body");
    if (/^photos/i.test(title)) return { kind: "manual" };
    const spec = bodyColumnSpec(title);
    if (!spec?.metric) return null;
    return spec.fasted ? { kind: "reading", metric: spec.metric, body_state: "fasted" } : { kind: "reading", metric: spec.metric };
  }
  if (tab.toLowerCase() === "cardio" && /\bhr\b/i.test(header("Cardio"))) return { kind: "cardio_hr" };
  return null;
}

export async function loadCadences(ld: Loader): Promise<void> {
  const member = ld.memberOfFile(REGISTRY_FILE);
  if (!ld.gapRegistry || !member) return;
  for (const [i, entry] of ld.gapRegistry.entries()) {
    const origin: Origin = { file: "config", tab: "gap_registry", row: i + 1 };
    const source = mapSource(ld, entry);
    if (!source) {
      ld.book.raise({
        origin, code: "unmapped_cadence", kind: "semantic",
        problem: `The gap "${entry.name}" points at ${JSON.stringify(entry.source)}, which has no counterpart in the app.`,
        proposed_fix: "Set its cadence by hand with set_measurement_cadence (a manual source if nothing records it), or leave it out.",
        proposal: null,
      });
      continue;
    }
    const res = await ld.write("set_measurement_cadence", { member, name: entry.name, every_days: entry.every_days, source, message: entry.message }, origin);
    if (res) ld.record(origin, { table: "measurement_cadence", id: (res.cadence as { id: number }).id, tool: "set_measurement_cadence" });
  }
}
