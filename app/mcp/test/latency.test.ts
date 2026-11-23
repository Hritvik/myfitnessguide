import { describe, expect, it } from "vitest";
import { MAX_WRITE_RUNS, parseLatencyArgs, refuseCookPieces, percentiles, READS, WRITES } from "../src/latency.ts";

describe("percentiles", () => {
  it("gives the nearest-rank p50 and p95", () => {
    const ms = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentiles(ms)).toEqual({ p50: 10, p95: 19, n: 20 });
    expect(percentiles([42])).toEqual({ p50: 42, p95: 42, n: 1 });
  });

  it("gives nulls for no runs, never a NaN or a crash", () => {
    expect(percentiles([])).toEqual({ p50: null, p95: null, n: 0 });
  });

  it("does not depend on the order the runs came in", () => {
    expect(percentiles([30, 10, 20, 50, 40])).toEqual({ p50: 30, p95: 50, n: 5 });
  });
});

describe("what it measures", () => {
  it("times the router beside the previews, and keeps the write apart", () => {
    expect(READS).toEqual(["what_if", "preview_set", "preview_meal", "route_text"]);
    expect(WRITES).toEqual(["commit_route"]);
  });
});

describe("the write guard", () => {
  const TODAY = "2026-10-07";
  const args = (...a: string[]) => parseLatencyArgs(a, TODAY);

  it("measures reads without a date, 30 runs by default", () => {
    expect(args("inputs.json")).toEqual({ file: "inputs.json", runs: 30, writes: false, date: null });
    expect(args("inputs.json", "12")).toEqual({ file: "inputs.json", runs: 12, writes: false, date: null });
  });

  it("refuses runs that are not a positive whole number", () => {
    for (const runs of ["0", "abc", "-3", "2.5", ""]) expect(args("inputs.json", runs)).toHaveProperty("error");
  });

  it("refuses --writes without an explicit --date, and a date within 30 days of today either way", () => {
    expect(args("inputs.json", "--writes")).toEqual({ error: expect.stringContaining("--date") });
    expect(args("inputs.json", "--writes", "--date", "2026-10-20")).toEqual({ error: expect.stringContaining("within 30 days") });
    expect(args("inputs.json", "--writes", "--date", "2026-09-10")).toEqual({ error: expect.stringContaining("within 30 days") });
    expect(args("inputs.json", "--writes", "--date", TODAY)).toHaveProperty("error");
    expect(args("inputs.json", "--writes", "--date", "2026-13-01")).toHaveProperty("error");
    expect(args("inputs.json", "--date", "2026-12-01")).toEqual({ error: "--date is only for --writes" });
  });

  it("takes a date at least 30 days away, past or future, and caps write runs at 5", () => {
    expect(args("inputs.json", "--writes", "--date", "2026-11-06")).toEqual({ file: "inputs.json", runs: MAX_WRITE_RUNS, writes: true, date: "2026-11-06" });
    expect(args("inputs.json", "3", "--writes", "--date", "2026-09-07")).toEqual({ file: "inputs.json", runs: 3, writes: true, date: "2026-09-07" });
    expect(args("inputs.json", "6", "--writes", "--date", "2027-01-01")).toEqual({ error: expect.stringContaining("at most 5") });
    expect(MAX_WRITE_RUNS).toBe(5);
  });
});


describe("cook pieces in --writes inputs", () => {
  const item = { entry: { kind: "item", item: { name: "Test dal" } }, edited: false };
  const cook = { entry: { kind: "cook", component_id: 3, fraction: 0.5, provenance: "estimated" }, edited: false };

  it("refuses a cook piece, naming it, since it would add a portion to a real pot", () => {
    expect(refuseCookPieces({ member: "Asha", pieces: [item, cook] })).toMatch(/piece 2 is a cook piece/);
  });

  it("lets items and sets through, and an input without pieces", () => {
    expect(refuseCookPieces({ pieces: [item, { entry: { kind: "set" }, edited: false }] })).toBeNull();
    expect(refuseCookPieces({})).toBeNull();
    expect(refuseCookPieces(undefined)).toBeNull();
  });
});
