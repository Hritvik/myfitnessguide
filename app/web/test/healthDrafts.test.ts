import { describe, expect, it } from "vitest";
import { draftRows, rejectHealthPlan, settledNote } from "../src/healthDrafts";
import type { HealthDrafts, HistoryVersion } from "../src/types";

const TZ = "Asia/Kolkata";
const drafts: HealthDrafts = {
  member: "Asha",
  readings: [
    { id: 4, metric: "weight", label: "Body weight", date: "2026-10-04", value: 66.8, unit: "kg", side: null, body_state: "fasted", logged_by: "Kabir", deadline: "2026-10-07T07:30:00Z" },
    { id: 5, metric: "arm", label: "Arm", date: "2026-10-04", value: 31.5, unit: "cm", side: "left", body_state: "not_recorded", logged_by: null, deadline: null },
  ],
  draws: [{ id: 3, drawn_on: "2026-10-01", lab: "Orange", fasting: 1, results: 12, logged_by: "Kabir", deadline: "2026-10-07T07:30:00Z" }],
};

describe("draftRows", () => {
  it("words each draft reading with who logged it and when it confirms by itself, in the strip's words", () => {
    expect(draftRows(drafts, "reading", TZ)).toEqual([
      { key: "reading:4", ref: { table: "reading", id: 4 }, text: "Body weight 66.8 kg, fasted, Sun 4 Oct", note: "Logged by Kabir; confirms by itself Wed 13:00." },
      { key: "reading:5", ref: { table: "reading", id: 5 }, text: "Arm 31.5 cm, left, Sun 4 Oct", note: "Logged by the agent; waits for you." },
    ]);
  });

  it("words a draft blood draw by its lab, date and number of results", () => {
    expect(draftRows(drafts, "blood_draw", TZ)).toEqual([
      { key: "blood_draw:3", ref: { table: "blood_draw", id: 3 }, text: "Orange, 1 Oct 2026, 12 results", note: "Logged by Kabir; confirms by itself Wed 13:00." },
    ]);
  });

  it("is empty when there is nothing to check", () => {
    expect(draftRows({ member: "Asha", readings: [], draws: [] }, "reading", TZ)).toEqual([]);
  });
});

describe("rejectHealthPlan", () => {
  it("rejects one draft with a reason that names what it was", () => {
    expect(rejectHealthPlan({ table: "blood_draw", id: 3 })).toEqual({
      steps: [{ tool: "reject", input: { records: [{ table: "blood_draw", id: 3 }], reason: "Rejected in the app: not my blood draw", idempotency_key: expect.any(String) } }],
      done: "Removed.",
    });
    expect(rejectHealthPlan({ table: "reading", id: 4 }).steps[0]?.input.reason).toBe("Rejected in the app: not my reading");
  });
});

describe("settledNote: a draft settled while it was shown", () => {
  const v = (over: Partial<HistoryVersion>): HistoryVersion => ({
    version: 1, action: "create", data: { state: "draft" }, created_at: "2026-10-05T07:30:00Z",
    resolver: "claude_code", origin: "live", tool: "log_reading", reason: null, actor: null, speaker: "Kabir", on_behalf_of: "Asha", ...over,
  });
  const created = v({});
  const auto = v({ version: 2, action: "confirm", data: { state: "confirmed" }, created_at: "2026-10-07T08:00:00Z", resolver: "system", origin: "auto_confirm", tool: "auto_confirm", speaker: null });

  it("says it confirmed itself, when, and the way to change it now; nothing to retry", () => {
    expect(settledNote("reading", [created, auto], TZ)).toBe("This confirmed itself on Wed 7 Oct 13:30. To remove it now, ask Claude in chat to retract it.");
    expect(settledNote("blood_draw", [created, auto], TZ)).toBe("This confirmed itself on Wed 7 Oct 13:30. A confirmed blood draw can't be removed; to correct it, ask Claude in chat.");
  });

  it("says it was confirmed, or already removed, elsewhere", () => {
    const byChat = v({ version: 2, action: "confirm", data: { state: "confirmed" }, created_at: "2026-10-07T08:00:00Z", speaker: "Asha" });
    expect(settledNote("reading", [created, byChat], TZ)).toBe("This was confirmed on Wed 7 Oct 13:30. To remove it now, ask Claude in chat to retract it.");
    const removed = v({ version: 2, action: "reject", data: { state: "draft" }, created_at: "2026-10-07T08:00:00Z", speaker: "Asha" });
    expect(settledNote("reading", [created, removed], TZ)).toBe("Already removed, on Wed 7 Oct 13:30.");
  });

  it("is null while it is still a draft, so a real failure keeps Try again", () => {
    expect(settledNote("reading", [created], TZ)).toBeNull();
    expect(settledNote("reading", [], TZ)).toBeNull();
  });
});
