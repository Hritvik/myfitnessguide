import { describe, expect, it } from "vitest";
import { afterFailure, forKey, trackInFlight } from "../src/hooks";

const ready = { kind: "ready" as const, data: { n: 1 }, loadedAt: new Date("2026-10-06T10:00:00Z") };

describe("afterFailure", () => {
  it("keeps a view that is already loaded through an error or an offline read", () => {
    expect(afterFailure(ready, { kind: "error", message: "boom" } as never)).toBe(ready);
    expect(afterFailure(ready, { kind: "offline" } as never)).toBe(ready);
  });

  it("shows the error or the offline state when nothing is loaded yet", () => {
    expect(afterFailure({ kind: "loading" }, { kind: "error", message: "boom" } as never)).toEqual({ kind: "error", message: "boom" });
    expect(afterFailure({ kind: "loading" }, { kind: "offline" } as never)).toEqual({ kind: "offline" });
  });
});

describe("forKey", () => {
  it("shows the new key's cached answer, else loading, while the state still belongs to the old key", () => {
    expect(forKey("a", "b", ready, () => null)).toEqual({ kind: "loading" });
    const hit = { ...ready, data: { n: 2 } };
    expect(forKey("a", "b", ready, () => hit)).toBe(hit);
  });

  it("returns the state unchanged for the same key, so a ready re-read stays ready", () => {
    expect(forKey("a", "a", ready, () => null)).toBe(ready);
  });
});

describe("trackInFlight (the sheet's count of writes going through)", () => {
  it("counts a write from start to finish, landed, failed or thrown, so a pending save keeps the sheet busy after its tab is left", async () => {
    let n = 0;
    const seen: number[] = [];
    const report = (d: 1 | -1) => {
      n += d;
      seen.push(n);
    };
    let land!: (v: string) => void;
    const first = trackInFlight(report, () => new Promise<string>((r) => (land = r)));
    const second = trackInFlight(report, () => Promise.reject(new Error("offline")));
    expect(n).toBe(2);
    await expect(second).rejects.toThrow("offline");
    expect(n).toBe(1);
    land("saved");
    await expect(first).resolves.toBe("saved");
    expect(n).toBe(0);
    expect(seen).toEqual([1, 2, 1, 0]);
  });
});
