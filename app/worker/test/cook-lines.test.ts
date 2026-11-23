// Adding an ingredient to a cook that is already written, and taking one out.
// The case this exists for: the oil, the ghee or the cheese that is reported
// after the meal went in. A cook used to be frozen once written, so the only
// recourse was a hand-split intake item per eater - which left the cook's own
// totals understating the dish and gave the leftovers no share of the late
// ingredient at all. The leftovers assertion is the point of these tests.
import { describe, expect, it } from "vitest";
import { setup } from "./harness";
import { seedCatalogue } from "./seed";

const COOKED = "2026-10-06";

/** 400 g of peas, halved to Hritvik and quartered to Asha: a quarter stays unaccounted. */
async function cooked() {
  const x = setup();
  await seedCatalogue(x);
  const meal = await x.ok(
    "household_meal",
    {
      date: COOKED,
      meal_slot: "lunch",
      cooks: [
        {
          name: "Peas",
          lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }],
          portions: [
            { member: "Hritvik", fraction: 0.5, provenance: "estimated" },
            { member: "Asha", fraction: 0.25, provenance: "estimated" },
          ],
        },
      ],
    },
    "hritvik",
  );
  const cook = meal.cooks[0];
  return { x, componentId: cook.components[0].id as number, before: cook.totals.kcal.value as number };
}

const remainderKcal = (body: { remainder: { nutrients: { kcal: { value: number } } }[] }) => body.remainder[0]?.nutrients.kcal.value;
const portionKcal = (body: { portions: { member: string; nutrients: { kcal: { value: number } } }[] }, member: string) =>
  body.portions.find((p) => p.member === member)?.nutrients.kcal.value;
const reasonOf = (x: ReturnType<typeof setup>, tool: string) => x.t.get("SELECT reason FROM write_log WHERE tool = ? ORDER BY id DESC LIMIT 1", tool)?.reason;

describe("add_cook_line", () => {
  it("the forgotten oil reaches both portions AND the leftovers", async () => {
    const { x, componentId, before } = await cooked();
    // 10 ml of mustard oil is 88.4 kcal, split 0.5 / 0.25 / 0.25.
    const body = await x.ok(
      "add_cook_line",
      { component_id: componentId, line: { food: "mustard oil", value: 10, unit: "ml", provenance: "estimated" }, reason: "It went in the pan and was not reported." },
      "hritvik",
    );
    expect(body.state).toBe("confirmed");
    expect(body.totals.kcal.value).toBeCloseTo(before + 88.4, 6);
    expect(portionKcal(body, "Hritvik")).toBeCloseTo(before * 0.5 + 44.2, 6);
    expect(portionKcal(body, "Asha")).toBeCloseTo(before * 0.25 + 22.1, 6);
    // The one a hand-split intake item could never have reached.
    expect(remainderKcal(body)).toBeCloseTo(before * 0.25 + 22.1, 6);
  });

  it("both members' days move, the draft included", async () => {
    const { x, componentId, before } = await cooked();
    await x.ok(
      "add_cook_line",
      { component_id: componentId, line: { food: "mustard oil", value: 10, unit: "ml", provenance: "estimated" }, reason: "Forgot the oil." },
      "hritvik",
    );
    const day = async (member: string) => (await x.ok("day_totals", { member, date: COOKED }, "hritvik")).so_far.kcal.value;
    expect(await day("Hritvik")).toBeCloseTo(before * 0.5 + 44.2, 6);
    expect(await day("Asha")).toBeCloseTo(before * 0.25 + 22.1, 6);
  });

  it("goes at the end by default, or at a position, pushing later lines down", async () => {
    const { x, componentId } = await cooked();
    const end = await x.ok("add_cook_line", { component_id: componentId, line: { food: "curd", value: 50, unit: "g", provenance: "estimated" }, reason: "Stirred in." }, "hritvik");
    expect(end.line.position).toBe(2);
    const first = await x.ok(
      "add_cook_line",
      { component_id: componentId, line: { food: "mustard oil", value: 5, unit: "ml", provenance: "estimated" }, reason: "The pan was oiled first." , position: 1 },
      "hritvik",
    );
    expect(first.line.position).toBe(1);
    expect(x.t.all("SELECT position FROM cook_line WHERE component_id = ? ORDER BY position", componentId)).toEqual([{ position: 1 }, { position: 2 }, { position: 3 }]);
  });

  it("keeps the reason in the write log, and asks for one when it is missing", async () => {
    const { x, componentId } = await cooked();
    await x.ok("add_cook_line", { component_id: componentId, line: { food: "curd", value: 50, unit: "g", provenance: "estimated" }, reason: "Stirred in at the end." }, "hritvik");
    expect(reasonOf(x, "add_cook_line")).toBe("Stirred in at the end.");
    const bare = await x.call("add_cook_line", { component_id: componentId, line: { food: "curd", value: 50, unit: "g", provenance: "estimated" } }, "hritvik");
    expect(bare.body).toMatchObject({ status: "needs_clarification", reason: "reason_needed" });
  });

  it("an unknown component is a 404", async () => {
    const { x } = await cooked();
    const missing = await x.call("add_cook_line", { component_id: 9999, line: { food: "curd", value: 50, unit: "g", provenance: "estimated" }, reason: "x" }, "hritvik");
    expect(missing.http).toBe(404);
  });
});

describe("remove_cook_line", () => {
  it("takes the ingredient back out of every share", async () => {
    const { x, componentId, before } = await cooked();
    const added = await x.ok(
      "add_cook_line",
      { component_id: componentId, line: { food: "mustard oil", value: 10, unit: "ml", provenance: "estimated" }, reason: "Forgot the oil." },
      "hritvik",
    );
    const body = await x.ok("remove_cook_line", { component_id: componentId, line_id: added.line.id, reason: "It was a different pan." }, "hritvik");
    expect(body.totals.kcal.value).toBeCloseTo(before, 6);
    expect(portionKcal(body, "Hritvik")).toBeCloseTo(before * 0.5, 6);
    expect(remainderKcal(body)).toBeCloseTo(before * 0.25, 6);
    expect(reasonOf(x, "remove_cook_line")).toBe("It was a different pan.");
  });

  it("a component keeps at least one line", async () => {
    const { x, componentId } = await cooked();
    const only = x.t.get("SELECT id FROM cook_line WHERE component_id = ?", componentId)?.id as number;
    const refused = await x.call("remove_cook_line", { component_id: componentId, line_id: only, reason: "Nothing went in." }, "hritvik");
    expect(refused.body).toMatchObject({ status: "needs_clarification", reason: "no_lines" });
  });

  it("a line that is not this component's is a 404", async () => {
    const { x, componentId } = await cooked();
    const wrong = await x.call("remove_cook_line", { component_id: componentId, line_id: 9999, reason: "x" }, "hritvik");
    expect(wrong.http).toBe(404);
  });
});
