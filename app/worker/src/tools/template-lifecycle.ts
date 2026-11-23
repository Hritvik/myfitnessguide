import { z } from "zod";
import type { Ctx } from "../context";
import { first, type Row } from "../db";
import { Clarify, ToolError } from "../errors";
import { findRecipe } from "../recipes";
import { writeTool, type Tool } from "../tool";
import { loadWorkouts, workoutByRef } from "../workouts";

type Usage = { n: number; first_on: string | null; last_on: string | null };

function usage(row: Usage | null) {
  return {
    count: row?.n ?? 0,
    dates: row && row.n > 0 && row.first_on && row.last_on ? { first: row.first_on, last: row.last_on } : null,
  };
}

function reason(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Clarify("reason_needed", "Why is this reusable template being archived or restored?", [], ["change_reason"]);
  return trimmed;
}

const setRecipeArchived = writeTool({
  name: "set_recipe_archived",
  group: "catalogue",
  description:
    "Reversibly remove a saved recipe from normal suggestions and lists, or restore it. Its lines, uses and audit history are retained. Use archived=true when the member says to delete, remove or retire a recipe; archived=false restores it. Needs a change reason.",
  input: {
    recipe: z.string().min(1).describe("Recipe ref, exact name or alias."),
    archived: z.boolean(),
    change_reason: z.string().trim().min(1).optional().describe("Why the member wants this recipe removed or restored."),
  },
  async run(ctx, input) {
    const recipe = await findRecipe(ctx, input.recipe, true);
    if (!recipe) throw new ToolError("not_found", `no recipe ${input.recipe}`, 404);
    const cooks = await first<Usage>(ctx.db, "SELECT count(*) AS n, min(cooked_on) AS first_on, max(cooked_on) AS last_on FROM cook WHERE recipe_id = ?", recipe.id);
    const intake = await first<Usage>(ctx.db, "SELECT count(*) AS n, min(eaten_on) AS first_on, max(eaten_on) AS last_on FROM intake_item WHERE recipe_id = ?", recipe.id);
    const auditReason = reason(input.change_reason ?? input.reason);
    const currentArchived = recipe.archived_at !== null && recipe.archived_at !== undefined;
    const changed = currentArchived !== input.archived;
    const archivedAt = changed ? (input.archived ? ctx.nowIso() : null) : ((recipe.archived_at as string | null | undefined) ?? null);
    const archivedReason = changed ? (input.archived ? auditReason : null) : ((recipe.archived_reason as string | null | undefined) ?? null);
    if (changed) {
      const { aliases: _aliases, ...storedRecipe } = recipe as typeof recipe & { aliases?: string[] };
      ctx.txOrThrow.update(
        "recipe",
        recipe.id,
        { archived_at: archivedAt, archived_reason: archivedReason },
        { ...storedRecipe, archived_at: archivedAt, archived_reason: archivedReason },
      );
    }
    return {
      state: "confirmed",
      action: changed ? (input.archived ? "archived" : "restored") : "unchanged",
      recipe: { id: recipe.id, ref: recipe.ref, name: recipe.name, archived: input.archived, archived_at: archivedAt, archived_reason: archivedReason },
      dependents: { cooks: usage(cooks).count, cook_dates: usage(cooks).dates, intake_items: usage(intake).count, intake_dates: usage(intake).dates },
    };
  },
});

const setWorkoutArchived = writeTool({
  name: "set_workout_archived",
  group: "workouts",
  description:
    "Reversibly remove a saved workout from normal suggestions and lists, or restore it. Its prescription, past sessions and audit history are retained. Use archived=true when the member says to delete, remove or retire a workout; archived=false restores it. Needs a change reason.",
  input: {
    workout: z.union([z.number().int().positive(), z.string().min(1)]).describe("Workout id, exact name or alias."),
    archived: z.boolean(),
    change_reason: z.string().trim().min(1).optional().describe("Why the member wants this workout removed or restored."),
  },
  async run(ctx, input) {
    const ref = await workoutByRef(ctx, input.workout, ["workout"], true);
    const row = await first<Row & { id: number; archived_at: string | null }>(ctx.db, "SELECT * FROM workout WHERE id = ? AND household_id = ?", ref.id, ctx.householdId);
    if (!row) throw new ToolError("not_found", `no workout ${ref.id}`, 404);
    const sessions = await first<Usage>(ctx.db, "SELECT count(*) AS n, min(performed_on) AS first_on, max(performed_on) AS last_on FROM session WHERE workout_id = ?", ref.id);
    const auditReason = reason(input.change_reason ?? input.reason);
    const changed = (row.archived_at !== null) !== input.archived;
    const archivedAt = changed ? (input.archived ? ctx.nowIso() : null) : row.archived_at;
    const archivedReason = changed ? (input.archived ? auditReason : null) : ((row.archived_reason as string | null | undefined) ?? null);
    if (changed) {
      ctx.txOrThrow.update("workout", ref.id, { archived_at: archivedAt, archived_reason: archivedReason }, { ...row, archived_at: archivedAt, archived_reason: archivedReason });
    }
    const workout = (await loadWorkouts(ctx, null, true)).find((item) => item.id === ref.id);
    if (!workout) throw new ToolError("not_found", `no workout ${ref.id}`, 404);
    return {
      state: "confirmed",
      action: changed ? (input.archived ? "archived" : "restored") : "unchanged",
      workout: { ...workout, archived: input.archived, archived_at: archivedAt, archived_reason: archivedReason },
      dependents: { sessions: usage(sessions).count, session_dates: usage(sessions).dates },
    };
  },
});

export const RECIPE_LIFECYCLE_TOOLS: Tool[] = [setRecipeArchived];
export const WORKOUT_LIFECYCLE_TOOLS: Tool[] = [setWorkoutArchived];
