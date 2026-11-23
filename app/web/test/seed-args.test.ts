import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { argValue, checkPersist, parsePort } from "../scripts/seed-args";

describe("the seed's arguments", () => {
  it("a flag's value is the next argument, never another flag", () => {
    expect(argValue(["--persist", "/tmp/x"], "persist")).toBe("/tmp/x");
    expect(argValue(["--long"], "persist")).toBeNull();
    expect(() => argValue(["--persist", "--long"], "persist")).toThrow(/--persist needs a value/);
    expect(() => argValue(["--persist"], "persist")).toThrow(/--persist needs a value/);
  });

  it("a port is a whole number from 1 to 65535", () => {
    expect(parsePort(null)).toBeUndefined();
    expect(parsePort("8790")).toBe(8790);
    for (const bad of ["abc", "0", "65536", "87.5", "-1", "1e3", " 80"]) expect(() => parsePort(bad)).toThrow(/--port/);
  });
});

describe("where the seed may write (it deletes the directory first)", () => {
  const worker = mkdtempSync(join(tmpdir(), "gym-worker-"));
  const tmp = realpathSync(tmpdir());

  it("takes a sample directory under app/worker/.wrangler, or one under the temp directory", () => {
    expect(checkPersist(join(worker, ".wrangler", "sample"), { worker })).toBe(join(worker, ".wrangler", "sample"));
    expect(checkPersist(join(tmp, "gym-e2e-1", "d1"), { worker })).toBe(join(tmp, "gym-e2e-1", "d1"));
  });

  it("never the real local data, .wrangler itself or the temp directory itself", () => {
    for (const dir of [join(worker, ".wrangler", "state"), join(worker, ".wrangler", "state", "v3"), join(worker, ".wrangler"), tmp, join(worker, ".wrangler", "sample", "..", "state")]) {
      expect(() => checkPersist(dir, { worker, anywhere: true })).toThrow(/refuses/);
    }
  });

  it("anywhere else only when asked", () => {
    expect(() => checkPersist("/Users/someone/data", { worker })).toThrow(/--persist-anywhere/);
    expect(checkPersist("/Users/someone/data", { worker, anywhere: true })).toBe("/Users/someone/data");
  });
});
