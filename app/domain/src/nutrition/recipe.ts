import type { CookLine, Nutrients, NutrientTotals } from "../types";
import { scaleNutrients, scaleTotals, sumNutrients, totalsFrom } from "./totals";

/** A recipe as an intake source: resolved lines making `servings`, or manual per-serving macros. */
export interface RecipeSource {
  /** How many servings the lines make. */
  servings: number;
  lines?: readonly CookLine[];
  /** Manual macros per serving (a recipe not yet derived). They win over lines. */
  manualPerServing?: Nutrients;
}

/**
 * Nutrients for `servings` servings of a recipe (schema decision 30: an
 * intake item may be a recipe by servings). Manual per-serving macros win
 * when present. A recipe with neither lines nor manual macros returns no
 * nutrients at all, so a day counts it as unknown rather than 0 kcal.
 */
export function recipeIntake(recipe: RecipeSource, servings: number): NutrientTotals {
  if (!(servings > 0)) throw new RangeError("servings eaten must be positive");
  if (!(recipe.servings > 0)) throw new RangeError("a recipe must make a positive number of servings");
  if (recipe.manualPerServing) return scaleTotals(totalsFrom(recipe.manualPerServing), servings);
  const lines = recipe.lines ?? [];
  if (lines.length === 0) return {};
  const whole = sumNutrients(lines.map((l) => scaleNutrients(l.source.nutrients, l.multiples)));
  return scaleTotals(whole, servings / recipe.servings);
}
