import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LiftsDashboard, LiftsScreen, NutritionScreen, PrivateProgressScreen, ProgressViewHeader, ProgressViewNav, TrainViewNav } from "../src/screens/ViewScreens";
import type { LiftsData } from "../src/load";

const who = { member: "Asha", members: ["Asha", "Kabir"], today: "2026-10-06", time: "13:05", time_zone: "Asia/Kolkata" };
const html = <P extends object>(component: ComponentType<P>, props: P) => renderToStaticMarkup(createElement(component, props));

describe("Progress view navigation", () => {
  it("keeps the view switcher in the wide Progress header", () => {
    const out = html(ProgressViewHeader, { who, viewing: "Asha", current: "overview", range: "12w", week: null, go: vi.fn() });
    expect(out).toContain("<h1>Progress</h1>");
    expect(out).toContain('aria-label="Progress views"');
    expect(out).toMatch(/<a href="\/progress"[^>]*aria-current="page"/);
    expect(out).toContain('href="/progress/nutrition"');
    expect(out).toContain('href="/progress/health"');
  });

  it("offers all three views to the owner and marks the current view", () => {
    const out = html(ProgressViewNav, { who, viewing: "Asha", current: "nutrition", range: "4w", week: null, go: vi.fn() });
    expect(out).toContain('aria-label="Progress views"');
    expect(out).toContain('href="/progress?range=4w"');
    expect(out).toMatch(/<a href="\/progress\/nutrition\?range=4w"[^>]*aria-current="page"/);
    expect(out).toContain('href="/progress/health?range=4w"');
  });

  it("shows only household-visible Nutrition when viewing another member", () => {
    const out = html(ProgressViewNav, { who, viewing: "Kabir", current: "nutrition", range: "12w", week: null, go: vi.fn() });
    expect(out).toContain('href="/progress/nutrition?member=Kabir"');
    expect(out).not.toContain("Trajectory");
    expect(out).not.toContain("Health");
  });

  it("offers Nutrition from an owner-only view without exposing the private views", () => {
    const out = html(PrivateProgressScreen, {
      who,
      viewing: "Kabir",
      view: "health",
      range: "12w",
      week: null,
      message: "Health is private to Kabir.",
      go: vi.fn(),
    });
    expect(out).toContain("Health is private to Kabir.");
    expect(out).toContain('href="/progress/nutrition?member=Kabir"');
    expect(out).not.toContain(">Trajectory<");
  });
});

describe("route-specific screen scaffolds", () => {
  it("renders a dedicated household-visible Nutrition screen", () => {
    const out = html(NutritionScreen, { who, viewing: "Kabir", range: "12w", week: null, go: vi.fn() });
    expect(out).toContain("<h1>Nutrition</h1>");
    expect(out).toContain('href="/progress/nutrition?member=Kabir"');
    expect(out).not.toContain("Progress is private");
  });

  it("renders a dedicated Lifts screen with a switch back to Session", () => {
    const out = html(LiftsScreen, { who, viewing: "Kabir", go: vi.fn() });
    expect(out).toContain("<h1>Lifts</h1>");
    expect(out).toContain("Loading lift history…");
    expect(out).not.toContain("Loading nutrition history");
    expect(out).toContain('href="/train?member=Kabir"');
    expect(out).toMatch(/<a href="\/train\/lifts\?member=Kabir"[^>]*aria-current="page"/);
  });

  it("marks Session when using the Train switch", () => {
    const out = html(TrainViewNav, { who, viewing: "Asha", current: "session", go: vi.fn() });
    expect(out).toContain('aria-label="Training views"');
    expect(out).toMatch(/<a href="\/train"[^>]*aria-current="page"/);
    expect(out).toContain('href="/train/lifts"');
  });

  it("renders lift signals as links and the selected lift as the focal story", () => {
    const data: LiftsData = {
      list: { member: "Kabir", lifts: [{ exercise_id: 4, exercise: "Bench press", slug: "bench-press", implement_kind: "barbell", bodyweight_dominant: false, last_done: "2026-10-05", sessions: 2, best_e1rm: { kg: 60, on: "2026-10-05", session_id: 2, implement: "Barbell", reps: 8, rir_low: 2 }, no_e1rm: null, best_top_set: { kg: 48, on: "2026-10-05", session_id: 2 }, next_goal: null }], weekly_volume: [] },
      detail: { member: "Kabir", exercise_id: 4, exercise: "Bench press", slug: "bench-press", bodyweight_dominant: false, points: [{ session_id: 2, date: "2026-10-05", state: "confirmed", segment: 0, e1rm: { kg: 60, implement: "Barbell", set_id: 8, reps: 8, rir_low: 2, effective_reps: 10, reps_assumed: false }, top_set: { set_id: 8, total_kg: 48, reps: 8 }, volume_kg: 900, working_sets: 3, sets_without_volume: 0 }], goals: [], method_changes: [], sessions: [] },
    };
    const out = html(LiftsDashboard, { who, viewing: "Kabir", exerciseId: 4, unknown: false, go: vi.fn(), state: { kind: "ready", data, loadedAt: new Date() }, retry: vi.fn() });
    expect(out).toContain('href="/train/lift/4/bench-press?member=Kabir"');
    expect(out).toContain("Estimated 1RM");
    expect(out).toContain("60 kg estimated 1RM");
    expect(out).toContain("Lift history data");
  });
});
