import { describe, expect, it } from "vitest";
import * as exported from "../src/owner-only";
import * as records from "../src/tools/records";

describe("the owner-only lists, importable on their own (e2e spec §3)", () => {
  it("records.ts re-exports the same objects", () => {
    expect(records.OWNER_ONLY).toBe(exported.OWNER_ONLY);
    expect(records.OWNER_TEXT).toBe(exported.OWNER_TEXT);
  });

  it("src/records.ts reads owners through the same OWNER_VIA", async () => {
    const source = (await import("node:fs")).readFileSync(new URL("../src/records.ts", import.meta.url), "utf8");
    expect(source).toMatch(/import \{[^}]*OWNER_VIA[^}]*\} from "\.\/owner-only"/);
    expect(source).not.toMatch(/const OWNER_VIA = /);
  });

  it("lists the sixteen owner-only tables and the one owner-text field", () => {
    expect(Object.keys(exported.OWNER_ONLY).length).toBe(16);
    expect(exported.OWNER_ONLY.question).toBe("question");
    // Decision 167: only a schedule swap's reason is still its member's alone; training's
    // session, set, cardio and load-change text is household data now.
    expect(exported.OWNER_TEXT).toEqual({ schedule_swap: ["reason"] });
  });
});
