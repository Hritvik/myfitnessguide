// Ticket 75: catalogue_search scores by words. A query's words match in any
// order, an extra word lowers the score instead of zeroing it, a near-spelling
// matches a word inside a longer name, and a whole-word or word-start match
// ranks above a match inside a word. Synthetic foods with invented values; the
// names are the ones the ticket found missing, no household data.
import { describe, expect, it } from "vitest";
import { NEAR_SPELLING } from "../src/fuzzy";
import { setup, type Harness } from "./harness";

const food = { state: "as_sold", reference_amount: 100, reference_unit: "g", kcal: 100, protein_g: 5, carbs_g: 15, fat_g: 2 };

/** Catalogue order puts the inside-a-word and partial matches first, so order alone can't pass a test. */
async function catalogue(): Promise<Harness> {
  const x = setup();
  for (const name of [
    "Potato, boiled", "Chickpeas, boiled", "Matta rice", "Amul High Protein Wheat Flour", "MillD High Protein Atta",
    "Whole-wheat atta", "Cooking oil", "Mustard oil", "Atta", "Atta biscuits", "Milk",
  ]) await x.ok("upsert_food_source", { name, ...food });
  return x;
}

type Hit = { name: string; score: number };
const search = async (x: Harness, query: string): Promise<Hit[]> => (await x.ok("catalogue_search", { query, kinds: ["food_source"], limit: 50 })).results;
const scoreOf = (hits: Hit[], name: string) => hits.find((h) => h.name === name)?.score ?? 0;

describe("catalogue_search by words (ticket 75)", () => {
  it("a query's words match in any order, as a strong match", async () => {
    const x = await catalogue();
    const reordered = await search(x, "atta wheat");
    expect(reordered[0]).toMatchObject({ name: "Whole-wheat atta" });
    // Every word a word start: the words tier (40), above any partial or inside-a-word match.
    expect(reordered[0]!.score).toBe(40);
  });

  it("an extra query word lowers the score instead of zeroing it: \"wheat flour atta\" finds Whole-wheat atta", async () => {
    const x = await catalogue();
    const hits = await search(x, "wheat flour atta");
    const extra = scoreOf(hits, "Whole-wheat atta");
    expect(extra).toBeGreaterThan(NEAR_SPELLING);
    expect(extra).toBeLessThan(scoreOf(await search(x, "atta wheat"), "Whole-wheat atta"));
    // Two of its three words, and the closer name: above the flour (also two of three) and MillD (one).
    expect(hits[0]).toMatchObject({ name: "Whole-wheat atta" });
    expect(scoreOf(hits, "MillD High Protein Atta")).toBeLessThan(extra);
  });

  it("\"wheat flour\" still finds Whole-wheat atta, below the flour that holds both words", async () => {
    const x = await catalogue();
    const names = (await search(x, "wheat flour")).map((h) => h.name);
    expect(names[0]).toBe("Amul High Protein Wheat Flour");
    expect(names).toContain("Whole-wheat atta");
  });

  it("a near-spelling matches a word inside a longer name: \"miild\" finds MillD High Protein Atta first", async () => {
    const x = await catalogue();
    const hits = await search(x, "miild");
    expect(hits[0]).toMatchObject({ name: "MillD High Protein Atta" });
    const brand = await search(x, "miild atta");
    expect(brand[0]).toMatchObject({ name: "MillD High Protein Atta" });
  });

  it("a whole-word match ranks above a match inside a word: \"oil\" finds the oils before anything boiled", async () => {
    const x = await catalogue();
    const hits = await search(x, "oil");
    expect(hits.slice(0, 2).map((h) => h.name)).toEqual(["Cooking oil", "Mustard oil"]);
    expect(scoreOf(hits, "Potato, boiled")).toBeLessThan(scoreOf(hits, "Mustard oil"));
    expect(scoreOf(hits, "Chickpeas, boiled")).toBeLessThan(scoreOf(hits, "Mustard oil"));
  });

  it("keeps the best-first order for an exact name: exact, then prefix, then a whole word, then inside a word", async () => {
    const x = await catalogue();
    const hits = await search(x, "atta");
    expect(hits.map((h) => [h.name, h.score])).toEqual([
      ["Atta", 100], ["Atta biscuits", 80], ["MillD High Protein Atta", 60], ["Whole-wheat atta", 60], ["Matta rice", expect.any(Number)],
    ]);
    expect(hits[4]!.score).toBeLessThan(40);
    expect(hits[4]!.score).toBeGreaterThan(NEAR_SPELLING);
  });
});
