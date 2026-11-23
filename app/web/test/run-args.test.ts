import { describe, expect, it } from "vitest";
import { MODES, parseRunArgs } from "../e2e/support/args";

describe("run.ts's command line (e2e spec §9; task 9 review)", () => {
  it("takes one mode, and passes what follows -- to Playwright", () => {
    expect(parseRunArgs(["--full"])).toEqual({ mode: "full", projects: MODES.full, extra: [] });
    expect(parseRunArgs(["--fast", "--", "--workers", "2"])).toEqual({ mode: "fast", projects: MODES.fast, extra: ["--workers", "2"] });
    expect(parseRunArgs(["--projects", "support,phone"])).toEqual({ mode: "projects", projects: ["support", "phone"], extra: [] });
    expect(MODES.full).toEqual(["support", "journeys", "privacy", "failure", "forms", "layout", "phone"]);
  });

  it("refuses an unknown flag, a second mode or an empty project list, never dropping them silently", () => {
    expect(parseRunArgs(["--full", "--grep", "x"])).toEqual({ error: "unknown argument --grep (Playwright's go after --)" });
    expect(parseRunArgs(["--full", "--fast"])).toEqual({ error: "one mode only: --full, --fast, --layout or --projects" });
    expect(parseRunArgs(["--projects"])).toEqual({ error: "--projects needs a list, as --projects <a,b>" });
    expect(parseRunArgs([])).toEqual({ error: "one mode is needed: --full, --fast, --layout or --projects" });
  });
});
