/**
 * run.ts's command line (e2e spec §9): exactly one mode, and Playwright's own
 * arguments after `--`. Anything else before `--` is an error, never dropped
 * (task 9 review): `npm run test:e2e -- --grep x` must not quietly run everything.
 */
export const MODES = {
  full: ["support", "journeys", "privacy", "failure", "forms", "layout", "phone"],
  fast: ["support", "journeys", "privacy", "failure", "phone"],
  layout: ["layout", "phone"],
} as const;

export type Mode = keyof typeof MODES | "projects";

export function parseRunArgs(argv: readonly string[]): { mode: Mode; projects: readonly string[]; extra: string[] } | { error: string } {
  const dash = argv.indexOf("--");
  const own = dash >= 0 ? argv.slice(0, dash) : [...argv];
  const extra = dash >= 0 ? argv.slice(dash + 1) : [];
  const modes: Mode[] = [];
  let projects: string[] = [];
  for (let i = 0; i < own.length; i++) {
    const a = own[i]!;
    if (a === "--full" || a === "--fast" || a === "--layout") modes.push(a.slice(2) as Mode);
    else if (a === "--projects") {
      modes.push("projects");
      const list = own[i + 1];
      if (list === undefined || list.startsWith("--")) return { error: "--projects needs a list, as --projects <a,b>" };
      projects = list.split(",").filter(Boolean);
      if (projects.length === 0) return { error: "--projects needs a list, as --projects <a,b>" };
      i++;
    } else return { error: `unknown argument ${a} (Playwright's go after --)` };
  }
  if (modes.length === 0) return { error: "one mode is needed: --full, --fast, --layout or --projects" };
  if (modes.length > 1) return { error: "one mode only: --full, --fast, --layout or --projects" };
  const mode = modes[0]!;
  return { mode, projects: mode === "projects" ? projects : MODES[mode], extra };
}
