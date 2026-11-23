/** "What I've learned" (spec §6, §7): the household's words and the router's measure, as the API gives them. */
import { day, pct, plainFood, plural } from "./format";
import type { Learned } from "./types";

export interface LearnedView {
  words: { id: number; word: string; means: string; kind: string; by: string; when: string }[];
  measure: string[];
}

const KIND: Record<string, string> = { food_source: "food", recipe: "dish", exercise: "exercise", workout: "workout" };

export function buildLearned(data: Learned): LearnedView {
  return {
    words: data.aliases.map((a) => ({ id: a.id, word: a.alias, means: plainFood(a.target), kind: KIND[a.kind] ?? a.kind, by: a.created_by ?? "set up at the start", when: day(a.created_at.slice(0, 10)) })),
    measure: data.router.map((w) => `${w.member}, week of ${day(w.week_of)}: ${w.share_unedited === null ? "not known" : pct(w.share_unedited)} saved without Claude (${w.unedited} of ${plural(w.pieces, "piece", "pieces")}).`),
  };
}
