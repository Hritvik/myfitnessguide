import { describe, expect, it } from "vitest";
import { loadHealth, loadHousehold, loadLifts, loadNutrition, loadProgressSummary, loadToday, loadEarlierSessions, loadTrain, loadTrajectory, loadWeek, loadWho, todayKey } from "../src/load";
import { fake, full, ok, WHO, type Replies } from "./fixtures";
import { page } from "./trends-fixtures";

describe("loadWho", () => {
  it("is the signed-in member", async () => {
    const out = await loadWho(fake({ whoami: ok(WHO) }).call);
    expect(out).toMatchObject({ kind: "ok", data: { member: "Asha", today: "2026-10-06" } });
  });

  it("is signed out for an agent identity (no member) and passes a sign-out through", async () => {
    expect(await loadWho(fake({ whoami: ok({ member: null, members: ["Asha"], today: "2026-10-06" }) }).call)).toEqual({ kind: "signed_out", http: 403 });
    expect(await loadWho(fake({ whoami: { kind: "signed_out", http: 401 } }).call)).toEqual({ kind: "signed_out", http: 401 });
  });
});

describe("loadToday", () => {
  it("reads your own today with needs_you, and no flags or staleness", async () => {
    const f = fake(full);
    const out = await loadToday(f.call, { who: WHO, viewing: "Asha", date: null });
    expect(out.kind === "ok" && out.data.needs).toEqual({ status: "ok", member: "Asha", date: "2026-10-06", cards: [], more: [] });
    expect(f.calls.map((c) => c.tool).sort()).toEqual(["day_cooks", "day_meals", "day_prep", "day_totals", "inbox_entries", "needs_you", "next_prescription"]);
  });

  it("keeps your texts about the viewed member still waiting for Claude on the day shown, naming nobody, and none when that read fails (decisions 75, 110)", async () => {
    const entry = (over: object) => ({ id: 1, member: "Kabir", date: "2026-10-06", meal_slot: "breakfast", text: "poha and chai", spans: [], status: "pending", note: null, created_at: "2026-10-06T03:00:00Z", ...over });
    const f = fake({
      ...full,
      inbox_entries: ok({ entries: [entry({}), entry({ id: 2, date: "2026-10-05" }), entry({ id: 3, member: "Asha" }), entry({ id: 4, meal_slot: "dinner", text: "dal" })], truncated: false }),
    });
    const out = await loadToday(f.call, { who: WHO, viewing: "Kabir", date: null });
    expect(f.calls.find((c) => c.tool === "inbox_entries")?.input).toEqual({ status: "pending" });
    expect(out.kind === "ok" && out.data.waiting.map((e) => e.id)).toEqual([1, 4]);
    const failed = await loadToday(fake({ ...full, inbox_entries: { kind: "error", code: "boom", message: "no", http: 500 } }).call, { who: WHO, viewing: "Asha", date: null });
    expect(failed.kind === "ok" && failed.data.waiting).toEqual([]);
  });

  it("asks needs_you only for your own today: never for another member, never for a past day", async () => {
    const other = fake(full);
    await loadToday(other.call, { who: WHO, viewing: "Kabir", date: null });
    expect(other.calls.map((c) => c.tool)).not.toContain("needs_you");
    const past = fake(full);
    await loadToday(past.call, { who: WHO, viewing: "Asha", date: "2026-10-05" });
    expect(past.calls.map((c) => c.tool)).not.toContain("needs_you");
  });

  it("is offline or failed as a whole when a day read is", async () => {
    expect(await loadToday(fake({ ...full, day_meals: { kind: "offline" } }).call, { who: WHO, viewing: "Asha", date: null })).toEqual({ kind: "offline" });
    expect(await loadToday(fake({ ...full, day_cooks: { kind: "error", code: "query_error", message: "boom", http: 500 } }).call, { who: WHO, viewing: "Asha", date: null }))
      .toMatchObject({ kind: "error", code: "query_error" });
  });

  it("keeps the day when only a footer read fails", async () => {
    const out = await loadToday(fake({ ...full, needs_you: { kind: "error", code: "boom", message: "no", http: 500 }, next_prescription: { kind: "offline" } }).call, { who: WHO, viewing: "Asha", date: null });
    expect(out.kind === "ok" && out.data.needs).toBeNull();
    expect(out.kind === "ok" && out.data.next).toBeNull();
  });
});

describe("todayKey", () => {
  it("names the resolved day, so a rolled-over household day reloads Today", () => {
    expect(todayKey(WHO, "Asha", null)).toBe("today|Asha|2026-10-06");
    expect(todayKey({ ...WHO, today: "2026-10-07" }, "Asha", null)).toBe("today|Asha|2026-10-07");
    expect(todayKey(WHO, "Kabir", "2026-10-05")).toBe("today|Kabir|2026-10-05");
  });
});
describe("loadTrain", () => {
  const replies: Replies = {
    next_prescription: ok({ programming_mode: "prescribed", session: "Upper A", date: "2026-10-12", prescriptions: [], gaps: [] }),
    inventory_gaps: ok({ gym: "Sample gym", next_session: "Upper A", gaps: [], ask: null }),
    sessions: ok({ member: "Asha", from: "2026-08-12", to: "2026-10-06", sessions: [] }),
  };

  it("reads your next session and your gym's open question", async () => {
    const f = fake(replies);
    const out = await loadTrain(f.call, { who: WHO, viewing: "Asha", from: null });
    expect(out.kind === "ok" && out.data).toMatchObject({ own: true, viewing: "Asha", next: { session: "Upper A" }, gaps: { ask: null }, history: { sessions: [] } });
    expect(f.calls).toEqual([{ tool: "next_prescription", input: { member: "Asha" } }, { tool: "inventory_gaps", input: { member: "Asha" } }, { tool: "sessions", input: { member: "Asha" } }]);
  });

  it("never asks another member's gym questions", async () => {
    const f = fake(replies);
    const out = await loadTrain(f.call, { who: WHO, viewing: "Kabir", from: null });
    expect(out.kind === "ok" && out.data.gaps).toBeNull();
    expect(f.calls.map((c) => c.tool)).toEqual(["next_prescription", "sessions"]);
  });

  it("reaches further back when asked", async () => {
    const f = fake({ next_prescription: ok({ programming_mode: "prescribed", session: null }), inventory_gaps: ok({ ask: null }), sessions: ok({ sessions: [] }) });
    await loadTrain(f.call, { who: WHO, viewing: "Asha", from: "2026-06-17" });
    expect(f.calls.find((c) => c.tool === "sessions")?.input).toEqual({ member: "Asha", from: "2026-06-17" });
  });

  it("still shows the next session when the sessions read fails", async () => {
    const f = fake({ ...replies, sessions: { kind: "offline" } });
    const out = await loadTrain(f.call, { who: WHO, viewing: "Asha", from: null });
    expect(out.kind === "ok" && out.data.history).toBeNull();
  });
});

describe("loadEarlierSessions", () => {
  it("reads the eight weeks before the oldest shown, ending the day before it", async () => {
    const f = fake({ sessions: ok({ member: "Asha", from: "2026-06-17", to: "2026-08-11", sessions: [] }) });
    const out = await loadEarlierSessions(f.call, { viewing: "Asha", before: "2026-08-12" });
    expect(f.calls).toEqual([{ tool: "sessions", input: { member: "Asha", from: "2026-06-17", to: "2026-08-11" } }]);
    expect(out.kind).toBe("ok");
  });

  it("passes a failure through", async () => {
    expect(await loadEarlierSessions(fake({ sessions: { kind: "offline" } }).call, { viewing: "Asha", before: "2026-08-12" })).toEqual({ kind: "offline" });
  });
});

describe("loadTrajectory", () => {
  const trends = (metric: string, headline: object = { metric: "waist_to_height", direction: "decrease", reason: null }) => ok({ member: "Asha", metric, segments: [], method_changes: [], goal_points: [], current_phase: null, headline, canonical_unit: "cm" });

  it("makes no calls at all for another member: Progress is private", async () => {
    const f = fake({});
    expect(await loadTrajectory(f.call, { who: WHO, viewing: "Kabir", range: "12w" })).toEqual({ kind: "ok", data: { private: true, message: "Progress is private to Kabir." } });
    expect(f.calls).toEqual([]);
  });

  it("asks for the headline (resolved by the API) and the weight over the range; All asks from the first reading", async () => {
    const f = fake({ body_trends: (input) => trends(String(input.metric)) });
    await loadTrajectory(f.call, { who: WHO, viewing: "Asha", range: "4w" });
    expect(f.calls).toEqual([
      { tool: "body_trends", input: { member: "Asha", metric: "headline", from: "2026-09-09", to: "2026-10-06" } },
      { tool: "body_trends", input: { member: "Asha", metric: "weight", from: "2026-09-09", to: "2026-10-06" } },
    ]);
    const all = fake({ body_trends: (input) => trends(String(input.metric)) });
    await loadTrajectory(all.call, { who: WHO, viewing: "Asha", range: "all" });
    expect(all.calls[0]?.input).toEqual({ member: "Asha", metric: "headline", to: "2026-10-06" });
  });

  it("makes no follow-up call when the headline falls back to another metric", async () => {
    const f = fake({ body_trends: (input) => (input.metric === "headline" ? trends("weight", { metric: "weight", direction: "decrease", reason: "No height is stored." }) : trends("weight")) });
    const out = await loadTrajectory(f.call, { who: WHO, viewing: "Asha", range: "12w" });
    expect(f.calls).toHaveLength(2);
    expect(out.kind === "ok" && !out.data.private && out.data.lead.metric).toBe("weight");
  });
});

describe("loadProgressSummary", () => {
  const summary = (over: object = {}) => ok({
    member: "Asha", period: "12w", as_of: "2026-10-06", from: "2026-07-15", to: "2026-10-06",
    signals: [
      { name: "body", metric: "weight", latest: null, change: null, rate_per_week: null, reading_count: 0, body_states: [], method_changes_reflected: false, note: null },
      { name: "strength", lifts: [], note: null },
      { name: "nutrition", from: "2026-07-15", to: "2026-10-05", logged_days: 0, days_in_window: 83, coverage: null, average_kcal: null, target_kcal: null, adherence_gap_kcal: null, note: null },
      { name: "review", open_flags: 0, blood_draws_in_period: 0, latest_reading_on: null, note: null },
      { name: "next", drill_down: "body", reason: "nothing recorded yet" },
    ],
    ...over,
  });

  it("makes no calls at all for another member: Progress is private", async () => {
    const f = fake({});
    expect(await loadProgressSummary(f.call, { who: WHO, viewing: "Kabir", range: "12w" })).toEqual({ kind: "ok", data: { private: true, message: "Progress is private to Kabir." } });
    expect(f.calls).toEqual([]);
  });

  it("asks for the summary over the range as its period, as of today", async () => {
    const f = fake({ progress_summary: summary() });
    const out = await loadProgressSummary(f.call, { who: WHO, viewing: "Asha", range: "6m" });
    expect(f.calls).toEqual([{ tool: "progress_summary", input: { member: "Asha", period: "6m", as_of: "2026-10-06" } }]);
    expect(out.kind === "ok" && !out.data.private && out.data.summary.period).toBe("12w");
    expect(out.kind === "ok" && !out.data.private && out.data.range).toBe("6m");
  });

  it("passes a failure through", async () => {
    expect(await loadProgressSummary(fake({ progress_summary: { kind: "offline" } }).call, { who: WHO, viewing: "Asha", range: "12w" })).toEqual({ kind: "offline" });
  });
});

describe("Progress loaders are owner-only", () => {
  it("make no calls for another member", async () => {
    const f = fake({});
    expect(await loadWeek(f.call, { who: WHO, viewing: "Noor", week: null })).toEqual({ kind: "ok", data: { private: true, message: "Progress is private to Noor." } });
    expect(await loadHealth(f.call, { who: WHO, viewing: "Noor" })).toEqual({ kind: "ok", data: { private: true, message: "Progress is private to Noor." } });
    expect(f.calls).toEqual([]);
  });

  it("read your week (any week) and your bloods and open flags", async () => {
    const f = fake({ week_summary: ok({ week_start: "2026-09-20" }), blood_draws: ok({ draws: [] }), flags: ok({ flags: [] }) });
    await loadWeek(f.call, { who: WHO, viewing: "Asha", week: "2026-09-23" });
    await loadHealth(f.call, { who: WHO, viewing: "Asha" });
    expect(f.calls).toEqual([
      { tool: "week_summary", input: { member: "Asha", week: "2026-09-23" } },
      { tool: "blood_draws", input: { member: "Asha" } },
      { tool: "flags", input: { member: "Asha", status: "open" } },
    ]);
  });
});

describe("loadHousehold", () => {
  it("reads the household for the date shown, today by default", async () => {
    const f = fake({ household_overview: ok({ date: "2026-10-06", members: [], meals: [], leftovers: [], waiting: [] }) });
    await loadHousehold(f.call, { date: null });
    await loadHousehold(f.call, { date: "2026-10-01" });
    expect(f.calls).toEqual([{ tool: "household_overview", input: {} }, { tool: "household_overview", input: { date: "2026-10-01" } }]);
  });
});

describe("loadNutrition", () => {
  it("loads 4 weeks in one call", async () => {
    const f = fake({ nutrition_trends: ok({ ...page("2026-09-13", 4), pages: [] }) });
    const out = await loadNutrition(f.call, { who: WHO, viewing: "Asha", range: "4w" });
    expect(f.calls).toEqual([{ tool: "nutrition_trends", input: { member: "Asha", from: "2026-09-15" } }]);
    expect(out.kind === "ok" && out.data.pages).toEqual([]);
  });

  it("loads returned pages and preserves their order", async () => {
    const f = fake({
      nutrition_trends: (input) => input.to === undefined
        ? ok({ ...page("2026-09-13", 4), pages: [{ from: "2026-08-16", to: "2026-09-12" }, { from: "2026-07-19", to: "2026-08-15" }] })
        : ok(page(String(input.from), 4)),
    });
    const out = await loadNutrition(f.call, { who: WHO, viewing: "Kabir", range: "12w" });
    expect(f.calls.map((c) => c.input)).toEqual([
      { member: "Kabir", from: "2026-07-21" },
      { member: "Kabir", from: "2026-08-16", to: "2026-09-12" },
      { member: "Kabir", from: "2026-07-19", to: "2026-08-15" },
    ]);
    expect(out.kind === "ok" && out.data.pages.map((p) => p.from)).toEqual(["2026-08-16", "2026-07-19"]);
  });

  it("asks for all history without a from date", async () => {
    const f = fake({ nutrition_trends: ok({ ...page("2026-01-04", 40), pages: [] }) });
    await loadNutrition(f.call, { who: WHO, viewing: "Asha", range: "all" });
    expect(f.calls).toEqual([{ tool: "nutrition_trends", input: { member: "Asha" } }]);
  });

  it("holds failed later pages as gaps and passes through a failed first call", async () => {
    const f = fake({ nutrition_trends: (input) => input.to === undefined ? ok({ ...page("2026-09-13", 4), pages: [{ from: "2026-08-16", to: "2026-09-12" }] }) : { kind: "error", code: "boom", message: "no", http: 500 } });
    const out = await loadNutrition(f.call, { who: WHO, viewing: "Asha", range: "12w" });
    expect(out.kind === "ok" && out.data.pages).toEqual([{ from: "2026-08-16", to: "2026-09-12", failed: true }]);
    expect(await loadNutrition(fake({ nutrition_trends: { kind: "offline" } }).call, { who: WHO, viewing: "Asha", range: "4w" })).toEqual({ kind: "offline" });
  });
});

describe("loadLifts", () => {
  it("loads the list and selected lift together", async () => {
    const f = fake({ lift_trends: (input) => ok(input.exercise_id ? { exercise_id: input.exercise_id, exercise: "Bench", points: [] } : { member: "Asha", lifts: [], weekly_volume: [] }) });
    const out = await loadLifts(f.call, { viewing: "Asha", exerciseId: 7 });
    expect(f.calls).toEqual([
      { tool: "lift_trends", input: { member: "Asha" } },
      { tool: "lift_trends", input: { member: "Asha", exercise_id: 7 } },
    ]);
    expect(out.kind === "ok" && out.data.detail).toMatchObject({ exercise_id: 7 });
  });

  it("loads only the list without a selection and passes either required failure through", async () => {
    const list = fake({ lift_trends: ok({ member: "Asha", lifts: [], weekly_volume: [] }) });
    expect((await loadLifts(list.call, { viewing: "Asha", exerciseId: null })).kind).toBe("ok");
    expect(list.calls).toHaveLength(1);
    const failed = fake({ lift_trends: (input) => input.exercise_id ? { kind: "error", code: "not_found", message: "gone", http: 404 } : ok({ member: "Asha", lifts: [], weekly_volume: [] }) });
    expect(await loadLifts(failed.call, { viewing: "Asha", exerciseId: 7 })).toMatchObject({ kind: "error", code: "not_found" });
  });
});
