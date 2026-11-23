import { describe, expect, it } from "vitest";
import { setup } from "./harness";
import { seedUpperA } from "./input-seed";
import { seedCatalogue, seedTraining } from "./seed";

describe("reversible template removal", () => {
  it("archives and restores a recipe without deleting its history or lines", async () => {
    const x = setup();
    await seedCatalogue(x);
    const recipe = (
      await x.ok("upsert_recipe", {
        name: "Repeat bowl",
        kind: "dish",
        servings: 2,
        lines: [{ food: "FS002", value: 300, unit: "g" }],
      })
    ).recipe;

    const removed = await x.ok("set_recipe_archived", {
      recipe: recipe.ref,
      archived: true,
      change_reason: "we no longer make this version",
    });
    expect(removed.dependents).toMatchObject({ cooks: 0, intake_items: 0 });

    expect((await x.ok("catalogue_list", { kind: "recipe" })).items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ ref: recipe.ref })]),
    );
    const archived = await x.ok("catalogue_lookup", { refs: [recipe.ref] });
    expect(archived.recipes[0]).toMatchObject({ ref: recipe.ref, archived: true, archived_reason: "we no longer make this version" });
    expect(archived.recipes[0].lines).toHaveLength(1);

    const repeated = await x.ok("set_recipe_archived", {
      recipe: recipe.ref,
      archived: true,
      change_reason: "repeat request must not invent new archive metadata",
    });
    expect(repeated).toMatchObject({ action: "unchanged", recipe: { archived_at: removed.recipe.archived_at, archived_reason: "we no longer make this version" } });

    await x.ok("set_recipe_archived", {
      recipe: recipe.ref,
      archived: false,
      change_reason: "we are making it again",
    });
    expect((await x.ok("catalogue_list", { kind: "recipe" })).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ ref: recipe.ref })]),
    );
  });

  it("archives and restores a workout while retaining its prescription", async () => {
    const x = setup();
    const seeded = seedTraining(x);
    seedUpperA(x, seeded);
    const workout = (
      await x.ok("create_workout", {
        name: "Old travel routine",
        reason: "initial routine",
        lines: [{ exercise: "pushups", sets: 3, reps: { low: 10, high: 15 }, load: "none" }],
      })
    ).workout;

    const removed = await x.ok("set_workout_archived", {
      workout: workout.id,
      archived: true,
      change_reason: "retired after equipment changed",
    });
    expect(removed.dependents).toMatchObject({ sessions: 0 });
    expect((await x.ok("workouts", {})).workouts).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: workout.id })]));

    const duplicate = await x.call("create_workout", {
      name: "Old travel routine",
      reason: "accidental duplicate",
      lines: [{ exercise: "pushups", sets: 2, reps: { low: 8, high: 12 }, load: "none" }],
    });
    expect(duplicate.body).toMatchObject({ status: "needs_clarification", reason: "duplicate_workout" });
    expect(JSON.stringify(duplicate.body)).toContain("Restore or rename the archived");

    const restored = await x.ok("set_workout_archived", {
      workout: workout.id,
      archived: false,
      change_reason: "needed for travel again",
    });
    expect(restored.workout).toMatchObject({ id: workout.id, archived: false });
    expect(restored.workout.lines).toHaveLength(1);
    expect((await x.ok("workouts", {})).workouts).toEqual(expect.arrayContaining([expect.objectContaining({ id: workout.id })]));
  });

  it("rejects a whitespace-only archive reason before reaching database constraints", async () => {
    const x = setup();
    await seedCatalogue(x);
    const recipe = (await x.ok("upsert_recipe", { name: "Keep me", kind: "dish", servings: 1, lines: [{ food: "FS002", value: 100, unit: "g" }] })).recipe;
    const reply = await x.call("set_recipe_archived", { recipe: recipe.ref, archived: true, change_reason: "   " });
    expect(reply.http).toBe(400);
    expect(reply.body).toMatchObject({ status: "invalid" });
  });
});
