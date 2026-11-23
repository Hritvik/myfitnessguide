import { describe, expect, it } from "vitest";
import { buildLiftDetail, buildLiftList } from "../src/lifts";
import type { LiftDetail, LiftTrends } from "../src/types";

const list: LiftTrends = {
  member: "Asha",
  lifts: [
    { exercise_id: 1, exercise: "Barbell bench press", slug: "barbell-bench-press", implement_kind: "barbell", bodyweight_dominant: false, last_done: "2026-10-06", sessions: 3, best_e1rm: { kg: 62.5, on: "2026-10-06", session_id: 3, implement: "Barbell", reps: 8, rir_low: 2 }, no_e1rm: null, best_top_set: { kg: 50, on: "2026-10-06", session_id: 3 }, next_goal: { week_of: "2026-10-18", tier: "planned", low: 65, high: 67.5, unit: "kg" } },
    { exercise_id: 2, exercise: "Pull-up", slug: "pull-up", implement_kind: "bodyweight", bodyweight_dominant: true, last_done: "2026-10-04", sessions: 2, best_e1rm: null, no_e1rm: "bodyweight_dominant", best_top_set: null, next_goal: null },
  ],
  weekly_volume: [
    { week_start: "2026-09-27", sessions: 2, working_sets: 8, volume_kg: 3200, sets_without_volume: 1 },
    { week_start: "2026-10-04", sessions: 1, working_sets: 4, volume_kg: null, sets_without_volume: 4 },
  ],
};

const detail: LiftDetail = {
  member: "Asha", exercise_id: 1, exercise: "Barbell bench press", slug: "barbell-bench-press", bodyweight_dominant: false,
  points: [
    { session_id: 1, date: "2026-09-01", state: "confirmed", segment: 0, e1rm: { kg: 55, implement: "Barbell", set_id: 11, reps: 8, rir_low: 2, effective_reps: 10, reps_assumed: false }, top_set: { set_id: 11, total_kg: 44, reps: 8 }, volume_kg: 800, working_sets: 3, sets_without_volume: 0 },
    { session_id: 2, date: "2026-09-20", state: "confirmed", segment: 0, e1rm: { kg: 58, implement: "Barbell", set_id: 21, reps: 8, rir_low: 2, effective_reps: 10, reps_assumed: false }, top_set: { set_id: 21, total_kg: 46, reps: 8 }, volume_kg: 840, working_sets: 3, sets_without_volume: 0 },
    { session_id: 3, date: "2026-10-06", state: "draft", segment: 1, e1rm: { kg: 62.5, implement: "Barbell", set_id: 31, reps: 8, rir_low: 2, effective_reps: 10, reps_assumed: true }, top_set: { set_id: 31, total_kg: 50, reps: 8 }, volume_kg: 900, working_sets: 3, sets_without_volume: 0 },
  ],
  goals: [{ week_of: "2026-10-18", tier: "planned", low: 65, high: 67.5, unit: "kg" }],
  method_changes: [{ date: "2026-10-01", note: "Paused reps from here" }],
  sessions: [],
};

describe("buildLiftList", () => {
  it("makes the latest usable strength signal lead and keeps missing volume honest", () => {
    const view = buildLiftList(list);
    expect(view.lifts[0]).toMatchObject({ id: 1, signal: "Best e1RM 62.5 kg", goal: "Goal 65–67.5 kg · 18 Oct 2026" });
    expect(view.lifts[1]).toMatchObject({ signal: "Track reps and load", note: "Bodyweight-dominant: no comparable e1RM" });
    expect(view.volume.table[1]).toMatchObject({ volume: "—", note: "4 sets without comparable volume" });
    expect(view.volume.summary).toContain("latest week has 1 session and 4 working sets");
  });
});

describe("buildLiftDetail", () => {
  it("cuts the line at method changes and labels draft and inferred points", () => {
    const view = buildLiftDetail(detail);
    expect(view.chart.segments).toHaveLength(2);
    expect(view.chart.summary).toContain("62.5 kg estimated 1RM");
    expect(view.chart.table.at(-1)).toMatchObject({ e1rm: "62.5 kg", topSet: "50 kg × 8", note: "Draft · reps inferred" });
    expect(view.chart.goals[0]).toMatchObject({ value: 65, high: 67.5 });
    expect(view.insight).toBe("Up 7.5 kg across 3 sessions");
  });

  it("does not manufacture an e1RM line when the API has none", () => {
    const view = buildLiftDetail({ ...detail, points: detail.points.map((point) => ({ ...point, e1rm: null })) });
    expect(view.chart.segments).toEqual([]);
    expect(view.chart.summary).toContain("No comparable estimated 1RM");
    expect(view.insight).toBe("3 sessions logged");
  });

  it("calls a flat series holding rather than up zero", () => {
    const flat = { ...detail, points: detail.points.map((point) => ({ ...point, e1rm: point.e1rm ? { ...point.e1rm, kg: 60 } : null })) };
    expect(buildLiftDetail(flat).insight).toBe("Holding at 60 kg across 3 sessions");
  });
});
