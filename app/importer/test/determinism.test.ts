// Two runs over the same snapshot, members and rulings give byte-identical
// output, and decided rulings are re-applied on the next run.
import { describe, expect, it } from "vitest";
import { rehearse } from "../src/rehearse";
import { readRulings } from "../src/rulings";
import { basePeople, f, food, FOOD_HEADER, intake, LOG_HEADER, members, NUTRITION_HEADER, set, snapshot } from "./fixture";

const snap = () =>
  snapshot({
    base: { People: basePeople(), "Food Sources": [FOOD_HEADER, food({ ref: "FS001", name: "Puffed test rice", serving: "100 g", kcal: 400, protein: 6, carbs: 90, fat: 0.5, category: "Carb" })] },
    hritvik: {
      Nutrition: [NUTRITION_HEADER, intake({ date: 46240, meal: 0.625, item: "Rice", person: "Hritvik", ref: "FS001", qty: "0.5", macros: [f("=..", 200), f("=..", 3), f("=..", 45), f("=..", 0.25)] })],
      Log: [LOG_HEADER, set({ date: 46240, session: "Upper A", exercise: "Bench Press", set: 1, reps: 8, rir: 46024, weight: 30, total: 30, volume: 250 })],
    },
  } as never);

describe("determinism", () => {
  it("gives byte-identical rulings, parity and SQL on two runs", async () => {
    const a = await rehearse({ snapshot: snap(), members: members() });
    const b = await rehearse({ snapshot: snap(), members: members() });
    expect(b.rulingsYaml).toBe(a.rulingsYaml);
    expect(b.parityJson).toBe(a.parityJson);
    expect(b.parityMd).toBe(a.parityMd);
    expect(b.sql).toEqual(a.sql);
  });

  it("re-applies decisions read back from rulings.yaml, and is stable from then on", async () => {
    const first = await rehearse({ snapshot: snap(), members: members() });
    const decided = readRulings(first.rulingsYaml).map((r) => (r.code === "meal_slot" ? { ...r, decision: "accepted" as const, decided_by: "Hritvik", override: "snack" } : r));
    const second = await rehearse({ snapshot: snap(), members: members(), previousRulings: decided });
    expect(second.db.get("SELECT meal_slot FROM intake_item")).toEqual({ meal_slot: "snack" });
    const third = await rehearse({ snapshot: snap(), members: members(), previousRulings: readRulings(second.rulingsYaml) });
    expect(third.rulingsYaml).toBe(second.rulingsYaml);
    expect(third.sql).toEqual(second.sql);
  });
});
