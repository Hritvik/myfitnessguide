import { describe, expect, it } from "vitest";
import { auditLines, settledHow } from "../src/history";
import type { HistoryVersion } from "../src/types";

const TZ = "Asia/Kolkata";
const v = (over: Partial<HistoryVersion>): HistoryVersion => ({
  version: 1, action: "create", data: {}, created_at: "2026-10-05T07:30:00Z", resolver: "member", origin: "app", tool: "log_intake",
  reason: null, actor: "Kabir", speaker: null, on_behalf_of: "Asha", ...over,
});

describe("auditLines", () => {
  it("words another member's record from what the API sends it, with no reason and no note: who, when and what else changed", () => {
    const lines = auditLines([
      v({ data: { reps: 10, note: null }, tool: "log_set", actor: "Hritvik", on_behalf_of: "Hritvik" }),
      v({ version: 2, action: "amend", data: { reps: 12, note: null }, tool: "amend", actor: "Hritvik", on_behalf_of: "Hritvik", created_at: "2026-10-05T08:30:00Z" }),
    ], TZ);
    expect(lines.map((l) => [l.who, l.what, l.why])).toEqual([["Hritvik", "created it", null], ["Hritvik", "changed reps from 10 to 12", null]]);
  });


  it("says who did what, when and why, for every version", () => {
    const lines = auditLines([
      v({ data: { label: null, state: "draft" } }),
      v({ version: 2, action: "amend", data: { label: "1 katori", state: "draft" }, created_at: "2026-10-05T09:00:00Z", resolver: "claude_code", origin: "live", tool: "amend", reason: "She says it was a katori", actor: null, speaker: "Asha" }),
      v({ version: 3, action: "confirm", data: { label: "1 katori", state: "confirmed" }, created_at: "2026-10-07T09:00:00Z", resolver: "system", origin: "auto_confirm", tool: "auto_confirm", reason: "auto-confirmed after 48 h with no edit or rejection", actor: null }),
      v({ version: 4, action: "retract", data: { label: "1 katori", state: "confirmed" }, created_at: "2026-10-08T03:00:00Z", resolver: "member", origin: "app", tool: "retract", reason: "Logged twice", actor: "Asha" }),
    ], TZ);
    expect(lines).toEqual([
      { when: "Mon 5 Oct 13:00", who: "Kabir", what: "created it", why: null },
      { when: "Mon 5 Oct 14:30", who: "The agent, talking with Asha", what: "changed label from blank to 1 katori", why: "She says it was a katori" },
      { when: "Wed 7 Oct 14:30", who: "Auto-confirm", what: "confirmed it", why: "auto-confirmed after 48 h with no edit or rejection" },
      { when: "Thu 8 Oct 08:30", who: "Asha", what: "retracted it", why: "Logged twice" },
    ]);
  });

  it("says imported from Sheets, and corrected at import with the ruling's reason", () => {
    const lines = auditLines([
      v({ resolver: "importer", origin: "import", tool: "log_intake", actor: null, reason: "import hritvik Nutrition row 412" }),
      v({ version: 1, resolver: "importer", origin: "import", tool: "log_intake", actor: null, reason: "import hritvik Nutrition row 418, as ruled: manual macros" }),
    ], TZ);
    expect(lines.map((l) => [l.who, l.why])).toEqual([["Imported from Sheets", null], ["Imported from Sheets", "corrected at import: manual macros"]]);
  });

  it("leaves out a reason that only repeats the tool, and names the Inbox", () => {
    const [line] = auditLines([v({ resolver: "hosted_model", origin: "inbox", tool: "log_intake", reason: "log_intake (inbox)", actor: null })], TZ);
    expect(line).toMatchObject({ who: "The Inbox", why: null });
  });
});

describe("settledHow: a draft that is no longer one", () => {
  it("says how it settled and when, in History's own time format; null while it is still a draft", () => {
    expect(settledHow([v({}), v({ version: 2, action: "confirm", data: { state: "confirmed" }, created_at: "2026-10-07T08:00:00Z", resolver: "system", origin: "auto_confirm" })], TZ)).toEqual({ how: "by_itself", when: "Wed 7 Oct 13:30" });
    expect(settledHow([v({ version: 2, action: "confirm", data: { state: "confirmed" }, resolver: "member" })], TZ)).toEqual({ how: "confirmed", when: "Mon 5 Oct 13:00" });
    expect(settledHow([v({ version: 2, action: "reject" })], TZ)).toEqual({ how: "removed", when: "Mon 5 Oct 13:00" });
    expect(settledHow([v({ data: { state: "draft" } })], TZ)).toBeNull();
    expect(settledHow([], TZ)).toBeNull();
  });
});
