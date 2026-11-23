import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowed, FOLD_FROM, foldFlag, pickRecords } from "../scripts/sweep-lib";

describe("the records a pane is swept on (wide-layout spec §7)", () => {
  const link = (href: string, text: string) => ({ href, text });

  it("takes the first, the longest name and the last, each once", () => {
    const links = [
      link("/catalogue/food/fs1", "Oats"),
      link("/catalogue/food/fs2", "Rolled oats, old-fashioned, the large blue pack"),
      link("/catalogue/recipe/r1", "Upma"),
      link("/catalogue/food/fs3", "Ragi"),
    ];
    expect(pickRecords(links)).toEqual(["/catalogue/food/fs1", "/catalogue/food/fs2", "/catalogue/food/fs3"]);
  });

  it("leaves out links that aren't records, and names a short list's records once", () => {
    expect(pickRecords([link("/catalogue/new/food", "New food"), link("/catalogue/gyms/1", "Ox")])).toEqual(["/catalogue/gyms/1"]);
    expect(pickRecords([])).toEqual([]);
  });
});

describe("the fold (wide-layout spec §1, §7)", () => {
  it("is checked from 1,920 px: a primary object below 400 px, or missing, is flagged", () => {
    expect(FOLD_FROM).toBe(1920);
    expect(foldFlag("#meals", 120)).toBeNull();
    expect(foldFlag("#meals", 400)).toBeNull();
    expect(foldFlag("#meals", 455.4)).toEqual({ kind: "fold", where: "#meals", text: "starts 455 px down", by: 55 });
    expect(foldFlag("#meals", null)).toEqual({ kind: "fold", where: "#meals", text: "the primary object is not on the page", by: 0 });
  });
});

describe("the phone check's allow-list (wide-layout spec §7)", () => {
  it("allows the named state, its variants and the sheets over it, and nothing else", () => {
    const allow = ["progress", "health"];
    for (const s of ["progress", "progress-all", "progress-as-Kabir", "sheet-food-progress", "health"]) expect(allowed(s, allow), s).toBe(true);
    for (const s of ["today", "week", "train-progress-x", "healthy"]) expect(allowed(s, allow), s).toBe(false);
    expect(allowed("progress", [])).toBe(false);
  });
});

describe("the sweep's lifecycle (final review M-2; e2e spec §8)", () => {
  // Since the byte freeze retired (web decision 119), the script starts no browser and no wrangler of its own:
  // the layout, phone and phone-base projects own both, so nothing here can leave a port taken.
  it("delegates every run to e2e/run.ts: no browser, no Worker, no HTML comparison of its own", () => {
    const script = readFileSync(join(import.meta.dirname, "..", "scripts", "sweep-layout.ts"), "utf8");
    for (const gone of ["launch(", "serve(", "chromium", "outerHTML", "htmlDiff", "waitForTimeout", "--pixels"]) expect(script, gone).not.toContain(gone);
    expect(script).toContain('"e2e/run.ts", "--projects", "phone-base"');
    expect(script.trimEnd().endsWith("process.exit(PHONE_CHECK ? phoneBase() : sweep());")).toBe(true);
  });
});
