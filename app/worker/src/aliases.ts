/**
 * The one alias store (spec §6): the household's other names for food
 * sources, recipes, exercises, workouts and implements, one meaning per
 * word.
 */
import type { Ctx } from "./context";
import { all, first } from "./db";
import { Clarify } from "./errors";

export const ALIAS_KINDS = ["food_source", "recipe", "exercise", "workout", "implement"] as const;
export type AliasKind = (typeof ALIAS_KINDS)[number];

/** SQL naming an alias row `a`'s target, as people read it. */
export const TARGET_LABEL = `CASE a.kind
  WHEN 'food_source' THEN (SELECT name || ' (' || state || ', ' || ref || ')' FROM food_source WHERE id = a.target_id)
  WHEN 'recipe' THEN (SELECT name || ' (' || ref || ')' FROM recipe WHERE id = a.target_id)
  WHEN 'exercise' THEN (SELECT name FROM exercise WHERE id = a.target_id)
  WHEN 'implement' THEN (SELECT i.name || ' (' || g.name || ')' FROM implement i JOIN gym g ON g.id = i.gym_id WHERE i.id = a.target_id)
  ELSE (SELECT name FROM workout WHERE id = a.target_id) END`;

/** A new name must not be a word the household already uses for something (one meaning per word). */
export async function assertNotAnAlias(ctx: Ctx, name: string, path: (string | number)[]): Promise<void> {
  const hit = await first<{ alias: string; target: string }>(
    ctx.db,
    `SELECT a.alias, ${TARGET_LABEL} AS target FROM alias a WHERE a.household_id = ? AND a.alias = ? COLLATE NOCASE`,
    ctx.householdId,
    name.trim(),
  );
  if (hit) {
    throw new Clarify("name_is_an_alias", `"${name.trim()}" is the household's word for ${hit.target}. Use another name, or forget that word first.`, [], path);
  }
}

/**
 * Every name and alias in the household equal to the word, ignoring case,
 * with its stored spelling (`word`): one statement. Its compound SELECT has
 * five terms, D1's cap; a sixth kind needs a second statement or a join.
 */
export async function taken(ctx: Ctx, word: string) {
  return all<{ source: "name" | "alias"; kind: AliasKind; id: number; target_id: number; word: string; label: string }>(
    ctx.db,
    `SELECT 'name' AS source, 'food_source' AS kind, id, id AS target_id, name AS word, name || ' (' || state || ', ' || ref || ')' AS label FROM food_source
       WHERE household_id = ?1 AND (name = ?2 COLLATE NOCASE OR ref = ?2 COLLATE NOCASE)
     UNION ALL SELECT 'name', 'recipe', id, id, name, name || ' (' || ref || ')' FROM recipe WHERE household_id = ?1 AND (name = ?2 COLLATE NOCASE OR ref = ?2 COLLATE NOCASE)
     UNION ALL SELECT 'name', 'exercise', id, id, name, name FROM exercise WHERE household_id = ?1 AND name = ?2 COLLATE NOCASE
     UNION ALL SELECT 'name', 'workout', id, id, name, name FROM workout WHERE household_id = ?1 AND name = ?2 COLLATE NOCASE
     UNION ALL SELECT 'alias', a.kind, a.id, a.target_id, a.alias, ${TARGET_LABEL} FROM alias a WHERE a.household_id = ?1 AND a.alias = ?2 COLLATE NOCASE`,
    ctx.householdId,
    word,
  );
}
