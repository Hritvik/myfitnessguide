// log_blood_draw writes all of a draw's results in a constant number of
// statements (Hritvik, 7 Oct 2026), so a full panel fits D1's 50. Same
// answers, same drafts rule; amend of a result stays cheap and retract
// has no path over a draw. Invented markers and values only.
import { describe, expect, it } from "vitest";
import { seedGym, toolWithinBudget } from "./budget";
import { setup } from "./harness";

const panel = (n: number, value: (i: number) => number) =>
  Array.from({ length: n }, (_, k) => ({ marker: `Invented marker ${k + 1}`, value: value(k + 1), unit: "mg/dL", ref_low: 5, ref_high: 30 }));

describe("log_blood_draw, batched", () => {
  it("answers as before on a small draw: each result's row, status and change from the previous draw, markers matched without case", async () => {
    const x = setup();
    await x.ok("log_blood_draw", {
      member: "Hritvik", date: "2026-04-01", lab: "Orange",
      results: [{ marker: "Vitamin D", value: 18, unit: "ng/mL", ref_low: 30, ref_high: 100 }, { marker: "CRP", value: 3, unit: "mg/L", ref_high: 5 }],
    }, "hritvik");
    const body = await x.ok("log_blood_draw", {
      member: "Hritvik", date: "2026-10-01", lab: "Orange", fasting: true,
      results: [
        { marker: "vitamin d", value: 34, unit: "ng/mL", ref_low: 30, ref_high: 100 },
        { marker: "CRP", value: 0.5, comparator: "<", unit: "mg/L", ref_high: 5 },
        { marker: "Urine ketones", value_text: "negative", note: "dipstick" },
      ],
    }, "hritvik");
    const draw = body.draw.id;
    const first = body.results[0].id;
    expect(body.draw).toEqual({ id: draw, member: "Hritvik", drawn_on: "2026-10-01", lab: "Orange", state: "confirmed" });
    expect(body.results).toEqual([
      { id: first, draw_id: draw, marker: "vitamin d", value: 34, comparator: null, value_text: null, unit: "ng/mL", ref_low: 30, ref_high: 100, ref_text: null, note: null, status: "within", change: { previous: 18, previous_on: "2026-04-01", delta: 16 } },
      { id: first + 1, draw_id: draw, marker: "CRP", value: 0.5, comparator: "<", value_text: null, unit: "mg/L", ref_low: null, ref_high: 5, ref_text: null, note: null, status: null, change: null },
      { id: first + 2, draw_id: draw, marker: "Urine ketones", value: null, comparator: null, value_text: "negative", unit: null, ref_low: null, ref_high: null, ref_text: null, note: "dipstick", status: null, change: null },
    ]);
    // Stored as answered, each result with its first version.
    expect(x.t.get("SELECT marker, value, comparator, value_text, unit, note FROM lab_result WHERE id = ?", first + 2)).toEqual({ marker: "Urine ketones", value: null, comparator: null, value_text: "negative", unit: null, note: "dipstick" });
    expect(x.t.get("SELECT count(*) AS n FROM record_version WHERE table_name = 'lab_result' AND action = 'create' AND record_id IN (?, ?, ?)", first, first + 1, first + 2)).toEqual({ n: 3 });
  });

  it("keeps the drafts rule, and asks before writing anything", async () => {
    const x = setup();
    // The agent, talking with Hritvik, logs Asha's draw: her draft.
    expect((await x.ok("log_blood_draw", { member: "Asha", date: "2026-10-01", lab: "Orange", results: panel(3, (i) => i) })).draw.state).toBe("draft");
    const asked = await x.call("log_blood_draw", { member: "Hritvik", date: "2026-10-02", lab: "Orange", results: [...panel(2, (i) => i), { marker: "invented marker 1", value: 9, unit: "mg/dL" }] }, "hritvik");
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "duplicate_marker" });
    expect(x.t.get("SELECT count(*) AS n FROM blood_draw WHERE member_id = ?", x.h.hritvik)).toEqual({ n: 0 });
  });

  it("stays within the budget: a 40-result panel, each with a previous result; amending one result; and retract has no path over a draw", async () => {
    const x = setup();
    seedGym(x, 40);
    const before = x.t.insert("blood_draw", { member_id: x.h.hritvik, drawn_on: "2026-04-01", lab: "Orange", state: "confirmed", confirmed_at: "2026-04-02T00:00:00Z" });
    for (let i = 1; i <= 40; i++) x.t.insert("lab_result", { draw_id: before, marker: `Invented marker ${i}`, value: i + 1, unit: "mg/dL" });
    const run = await toolWithinBudget(x, "log_blood_draw", { member: "Hritvik", date: "2026-10-01", lab: "Orange", results: panel(40, (i) => i) }, "hritvik");
    expect(run.body.results).toHaveLength(40);
    expect(run.body.results.every((r: { change: { delta: number } | null }) => r.change?.delta === -1)).toBe(true);
    await toolWithinBudget(x, "amend", { record: { table: "lab_result", id: run.body.results[0].id }, changes: { value: 2 }, reason: "The lab corrected the value" }, "hritvik");
    const retracted = await x.call("retract", { records: [{ table: "blood_draw", id: run.body.draw.id }], reason: "Logged twice" }, "hritvik");
    expect(retracted.body.error.code).toBe("not_retractable");
  });
});
