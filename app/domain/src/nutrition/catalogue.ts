import type { CatalogueIngredientLine, CatalogueRecipe } from "../types";

/**
 * Integrity failures that a spreadsheet shows as ordinary numbers, as
 * human-readable strings; empty when clean.
 *
 * A derived recipe with no lines would sum to a plausible 0 kcal. A recipe
 * used as an ingredient is rejected outright: it is the only way to build a
 * cycle. `sources` is keyed by food id.
 */
export function catalogueProblems(
  recipes: readonly CatalogueRecipe[],
  ingredients: readonly CatalogueIngredientLine[],
  sources: Readonly<Record<string, { name?: string }>>,
): string[] {
  const problems: string[] = [];

  for (const recipe of recipes) {
    if (recipe.derivation === "derived" && !recipe.lines) {
      problems.push(`${recipe.ref} is marked derived but has no ingredient lines; its macros will read 0 kcal`);
    }
  }

  for (const line of ingredients) {
    const foodId = line.foodId ?? "";
    if (foodId.startsWith("R")) {
      problems.push(`${line.recipe} uses ${foodId} as an ingredient; a recipe may not contain a recipe`);
    } else if (!Object.hasOwn(sources, foodId)) {
      problems.push(`${line.recipe} references ${foodId || "(blank)"}, which is not a Food Source`);
    }
  }

  for (const [foodId, source] of Object.entries(sources)) {
    if (!foodId) {
      problems.push(
        `a Food Source has no Food ID (${source.name ?? "unnamed"}); it is unreachable by ref and a mirror regeneration would drop it`,
      );
    }
  }

  return problems;
}
