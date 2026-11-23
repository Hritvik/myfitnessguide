// The snapshot: per file, per tab, the rendered values grid and the
// formulas grid, plus capture time and source ids. Synthetic data only.
import { describe, expect, it } from "vitest";
import { assembleSnapshot, SNAPSHOT_FORMAT, validateSnapshot, type RawCapture } from "../src/snapshot";

const IDS = { base: "BASE_ID", hritvik: "H_ID" };

function capture(file: string, mode: "values" | "formulas", ranges: { range: string; values?: unknown[][] }[]): RawCapture {
  return {
    mode,
    response: {
      target: { file_id: IDS[file as keyof typeof IDS], name: `Gym · ${file}`, modified_time: "2026-10-05T06:00:00Z", revision: "7" },
      result: { valueRanges: ranges.map((r) => ({ range: r.range, majorDimension: "ROWS", values: r.values })) },
    },
  };
}

const captures: RawCapture[] = [
  capture("base", "formulas", [{ range: "'Food Sources'!A1:C10", values: [["Source", "Calories", "Per g"], ["Oats", 379, "=B2/10"], ["Milk"]] }]),
  capture("base", "values", [{ range: "'Food Sources'!A1:C10", values: [["Source", "Calories", "Per g"], ["Oats", "379", "37.9"], ["Milk"]] }]),
  capture("hritvik", "formulas", [{ range: "Log!A1:B5", values: [["Date", "Reps"]] }, { range: "Charts!A1:B5" }]),
  capture("hritvik", "values", [{ range: "Log!A1:B5", values: [["Date", "Reps"]] }, { range: "Charts!A1:B5" }]),
];

describe("assembleSnapshot", () => {
  it("builds a versioned snapshot with rectangular values and formulas grids per tab", () => {
    const snap = assembleSnapshot(captures, { capturedAt: "2026-10-05T19:07:21Z", files: IDS, authProfile: "user-primary" });
    expect(snap.format).toBe(SNAPSHOT_FORMAT);
    expect(snap.version).toBe(1);
    expect(snap.captured_at).toBe("2026-10-05T19:07:21Z");
    expect(snap.files.base?.spreadsheet_id).toBe("BASE_ID");
    const tab = snap.files.base?.tabs["Food Sources"];
    expect(tab).toMatchObject({ range: "'Food Sources'!A1:C10", rows: 3, cols: 3 });
    expect(tab?.values).toEqual([["Source", "Calories", "Per g"], ["Oats", "379", "37.9"], ["Milk", "", ""]]);
    expect(tab?.formulas).toEqual([["Source", "Calories", "Per g"], ["Oats", 379, "=B2/10"], ["Milk", "", ""]]);
    expect(snap.files.hritvik?.tabs.Charts).toMatchObject({ rows: 0, cols: 0, values: [], formulas: [] });
  });

  it("refuses a capture from a file it does not know", () => {
    const stray = capture("base", "values", [{ range: "X!A1:A1", values: [["x"]] }]);
    stray.response.target.file_id = "OTHER";
    expect(() => assembleSnapshot([stray], { capturedAt: "2026-10-05T19:07:21Z", files: IDS, authProfile: "p" })).toThrow(/OTHER/);
  });
});

describe("validateSnapshot", () => {
  const snap = assembleSnapshot(captures, { capturedAt: "2026-10-05T19:07:21Z", files: IDS, authProfile: "user-primary" });

  it("passes when every expected tab is present, and reports row counts", () => {
    const report = validateSnapshot(snap, { base: ["Food Sources"], hritvik: ["Log", "Charts"] });
    expect(report.ok).toBe(true);
    expect(report.tabs).toEqual([
      { file: "base", tab: "Food Sources", rows: 3, data_rows: 2, cols: 3 },
      { file: "hritvik", tab: "Charts", rows: 0, data_rows: 0, cols: 0 },
      { file: "hritvik", tab: "Log", rows: 1, data_rows: 0, cols: 2 },
    ]);
  });

  it("continues to validate legacy Gym Tracker snapshots", () => {
    const legacy = { ...snap, format: "gym-tracker-sheets-snapshot" } as unknown as typeof snap;
    expect(validateSnapshot(legacy, { base: ["Food Sources"], hritvik: ["Log", "Charts"] }).ok).toBe(true);
  });

  it("fails on a missing tab, a missing file and a ragged grid", () => {
    const ragged = structuredClone(snap);
    ragged.files.base!.tabs["Food Sources"]!.values[1] = ["Oats"];
    const report = validateSnapshot(ragged, { base: ["Food Sources", "Recipes"], asha: ["Log"] });
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      "asha: file missing",
      "base/Food Sources: values row 2 has 1 cells, expected 3",
      "base/Recipes: tab missing",
    ]);
  });
});
