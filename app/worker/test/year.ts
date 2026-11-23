import type { Invented } from "./invented";
import type { TestDb } from "./db";

const END = "2026-10-07";
const CONFIRMED_AT = "2026-10-07T04:30:00Z";
const SLOTS = ["breakfast", "lunch", "dinner", "snack", "pre_workout", "post_workout"] as const;

const offsetDay = (offset: number): string =>
  new Date(Date.parse(`${END}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * Direct-SQL, deterministic nutrition-page fixture. It intentionally avoids
 * the HTTP/tool seam: this is a scale fixture, not a write-workflow test.
 */
export function seedYear(t: TestDb, household: Invented, options: { cooksPerDay: 2 | 6 }): void {
  const db = t.db;
  db.exec("BEGIN");
  try {
    const food = t.insert("food_source", {
      household_id: household.id,
      ref: "FS-YEAR",
      name: "Year fixture food",
      state: "as_sold",
      reference_amount: 100,
      reference_unit: "g",
      kcal: 125,
      protein_g: 10,
      carbs_g: 15,
      fat_g: 3,
      fibre_g: 2,
      protein_band: "complete",
    });
    const members = [household.asha, household.kabir, household.noor];

    for (const [index, member] of members.entries()) {
      const firstTarget = t.insert("target", {
        member_id: member,
        effective_from: "2025-10-01",
        provenance: index === 0 ? "member" : "agent",
        reasoning: "year fixture baseline",
        created_at: CONFIRMED_AT,
      });
      t.insert("target_value", { target_id: firstTarget, nutrient: "kcal", kind: "target", value: 2000 + index * 100 });
      t.insert("target_value", { target_id: firstTarget, nutrient: "protein_g", kind: "floor", value: 100 + index * 10 });
      t.insert("target_value", { target_id: firstTarget, nutrient: "carbs_g", kind: "remainder", value: null });
      const revised = t.insert("target", {
        member_id: member,
        effective_from: "2026-09-24",
        provenance: "professional",
        reasoning: "year fixture revision",
        created_at: CONFIRMED_AT,
      });
      t.insert("target_value", { target_id: revised, nutrient: "kcal", kind: "target", value: 2100 + index * 100 });
      t.insert("target_value", { target_id: revised, nutrient: "protein_g", kind: "target", value: 120 + index * 10 });
      t.insert("target_value", { target_id: revised, nutrient: "fat_g", kind: "ceiling", value: 70 });
    }

    for (let offset = -364; offset <= 0; offset++) {
      const date = offsetDay(offset);
      const status = offset % 3 === 0 ? "complete" : offset % 3 === -1 ? "partial" : "open";
      for (const member of members) {
        t.insert("day_status", { member_id: member, day: date, status });
        if (status === "partial") t.insert("skipped_meal", { member_id: member, day: date, meal_slot: "post_workout" });
        for (let item = 0; item < 6; item++) {
          t.insert("intake_item", {
            member_id: member,
            eaten_on: date,
            meal_slot: SLOTS[item],
            source_kind: "food_source",
            food_source_id: food,
            amount_value: 40 + item * 5,
            amount_unit: "g",
            provenance: item % 2 === 0 ? "weighed" : "estimated",
            confidence: item % 2 === 0 ? "high" : "medium",
            state: "confirmed",
            confirmed_at: CONFIRMED_AT,
          });
        }
      }

      for (let cookIndex = 0; cookIndex < options.cooksPerDay; cookIndex++) {
        const cook = t.insert("cook", {
          household_id: household.id,
          cooked_on: date,
          name: `Shared cook ${date} ${cookIndex + 1}`,
          state: "confirmed",
          confirmed_at: CONFIRMED_AT,
        });
        const component = t.insert("component", { cook_id: cook, position: 1, name: "whole" });
        t.insert("cook_line", {
          component_id: component,
          position: 1,
          food_source_id: food,
          amount_value: 300 + cookIndex * 10,
          amount_unit: "g",
          provenance: "weighed",
        });
        for (const member of members) {
          const portion = t.insert("portion", {
            component_id: component,
            member_id: member,
            kind: "fraction",
            fraction: 0.25,
            provenance: "estimated",
            state: "confirmed",
            confirmed_at: CONFIRMED_AT,
          });
          t.insert("intake_item", {
            member_id: member,
            eaten_on: date,
            meal_slot: cookIndex % 2 === 0 ? "lunch" : "dinner",
            source_kind: "portion",
            portion_id: portion,
            provenance: null,
            confidence: "medium",
            state: "confirmed",
            confirmed_at: CONFIRMED_AT,
          });
        }
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
