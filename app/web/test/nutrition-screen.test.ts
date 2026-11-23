import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildNutrition, type NutritionData } from "../src/nutrition";
import { nutritionScreenKey, NutritionDashboard } from "../src/screens/ViewScreens";
import type { Loaded } from "../src/hooks";
import { page } from "./trends-fixtures";

const who = { member: "Asha", members: ["Asha", "Kabir"], today: "2026-10-06", time: "13:05", time_zone: "Asia/Kolkata" };
const ready = (data: NutritionData): Loaded<NutritionData> => ({ kind: "ready", data, loadedAt: new Date("2026-10-06T08:00:00Z") });
const data = (first = page("2026-09-13", 4), pages: NutritionData["pages"] = []): NutritionData => ({ viewing: "Kabir", today: who.today, range: "4w", first, pages });
const render = (state: Loaded<NutritionData>, range: "4w" | "12w" | "all" = "4w") => renderToStaticMarkup(createElement(NutritionDashboard, { who, viewing: "Kabir", range, week: "2026-09-27", go: vi.fn(), state, retry: vi.fn() }));

describe("NutritionDashboard", () => {
  it("reloads date-relative ranges when the household day changes", () => {
    expect(nutritionScreenKey(who, "Kabir", "4w")).not.toBe(nutritionScreenKey({ ...who, today: "2026-10-07" }, "Kabir", "4w"));
  });

  it("keeps household, range, and week context while rendering real summaries and the weekly table", () => {
    const out = render(ready(data()));
    const view = buildNutrition(data());

    expect(out).toContain("<h1>Nutrition</h1>");
    expect(out).toContain('href="/progress/nutrition?week=2026-09-27&amp;member=Kabir"');
    expect(out).toMatch(/href="\/progress\/nutrition\?range=4w&amp;week=2026-09-27&amp;member=Kabir"[^>]*aria-current="page"/);
    expect(out).toContain(view.charts[0]!.summary);
    expect(out).toContain(view.split.summary);
    expect(out).toContain(view.cost.daily.summary);
    expect(out).toContain('aria-label="Nutrition charts"');
    expect(out.match(/role="img"/g)).toHaveLength(7);
    expect(out).toContain('class="chart macro-split"');
    expect(out).toContain('<table class="wide-table nutrition-weeks">');
    expect(out).toContain("<caption>Weekly nutrition averages</caption>");
    expect(out).toContain('<th scope="col">Week</th>');
    expect(out).toContain('<th scope="row">Sun 4 Oct</th>');
    expect(out).toContain("1,900 / 2,200 kcal");
    expect(out).toContain("₹180–₹210");
  });

  it("makes an older page failure visible without hiding the weeks that did load", () => {
    const first = page("2026-09-13", 4);
    const out = render(ready(data(first, [{ from: "2026-08-16", to: "2026-09-12", failed: true }])));

    expect(out).toContain("Some history could not be loaded. The available weeks are still shown.");
    expect(out).toContain("Sun 16 Aug – Sat 12 Sep");
    expect(out).toContain("Couldn&#x27;t load these weeks");
    expect(out).toContain("Sun 4 Oct");
  });

  it("explains empty and capped history", () => {
    const empty = page("2026-09-27", 1, { first_logged_on: null, from: null, to: null, days: [], weeks: [] });
    expect(render(ready(data(empty)))).toContain('role="status">Nothing logged yet.</p>');

    const capped = page("2026-09-13", 4, { capped: true });
    expect(render(ready(data(capped)), "all")).toContain("Showing the last 2 years");
  });

  it.each([
    [{ kind: "loading" } as const, 'aria-busy="true"', "Loading nutrition history"],
    [{ kind: "offline" } as const, 'role="status"', "Nutrition needs a connection to load"],
    [{ kind: "error", message: "The server did not answer." } as const, 'role="alert"', "The server did not answer."],
    [{ kind: "signed_out" } as const, 'role="alert"', "Sign in again"],
  ])("renders an accessible %s state", (state, landmark, copy) => {
    const out = render(state);
    expect(out).toContain(landmark);
    expect(out).toContain(copy);
    expect(out).toContain("<h1>Nutrition</h1>");
  });
});
