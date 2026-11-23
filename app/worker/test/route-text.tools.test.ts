// route_text: free text to pieces, each resolved with its API preview,
// needing a choice (with every option complete), or unresolved. It writes
// nothing, guesses nothing, and loads each table once per call.
import { describe, expect, it } from "vitest";
import { ROUTE_MAX_COMPARISONS } from "../src/tools/input";
import { toolWithinBudget } from "./budget";
import { setup } from "./harness";
import { busyInput, MONDAY, seedUpperA } from "./input-seed";
import { seedCatalogue, seedTraining } from "./seed";

async function ready() {
  const x = setup();
  await seedCatalogue(x);
  const s = seedTraining(x);
  seedUpperA(x, s);
  await x.ok("upsert_recipe", { name: "Fried rice", kind: "dish", servings: 2, lines: [{ food: "FS002", value: 300, unit: "g" }, { food: "FS005", value: 10, unit: "ml" }] });
  await x.ok("household_meal", {
    date: MONDAY, meal_slot: "lunch",
    cooks: [
      { name: "Fried rice", lines: [{ food: "FS002", value: 600, unit: "g", provenance: "weighed" }, { food: "FS005", value: 20, unit: "ml", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.3, provenance: "estimated" }] },
      { name: "Ghugni", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.25, provenance: "estimated" }] },
    ],
  }, "asha");
  x.t.insert("workout", { household_id: x.h.id, name: "Hotel legs", created_at: "2026-10-01T00:00:00Z" });
  await x.ok("learn_alias", { alias: "dahi", kind: "food_source", target: "FS004", reason: "what we call it" });
  return { x, s };
}

const route = async (x: Awaited<ReturnType<typeof ready>>["x"], text: string) =>
  (await x.ok("route_text", { member: "Hritvik", text, date: MONDAY, meal_slot: "dinner" }, "hritvik")) as { pieces: any[]; comparisons: number };

describe("route_text", () => {
  it("resolves food by measure, a share of today's pot, an alias and a set, each with its preview, and writes nothing", async () => {
    const { x } = await ready();
    const writes = x.t.get("SELECT count(*) AS n FROM write_log");
    const { pieces } = await route(x, "2 eggs, half the ghugni, 200 g dahi, lat pulldown 40kg x 12 rir 2");
    expect(x.t.get("SELECT count(*) AS n FROM write_log")).toEqual(writes);
    expect(pieces.map((p) => [p.span.text, p.status, p.entry?.kind])).toEqual([
      ["2 eggs", "resolved", "item"], ["half the ghugni", "resolved", "cook"], ["200 g dahi", "resolved", "item"], ["lat pulldown 40kg x 12 rir 2", "resolved", "set"],
    ]);
    expect(pieces[0].entry.item).toMatchObject({ source: "food", food: "egg", value: 2, measure: "egg", provenance: "estimated", label: "2 eggs" });
    expect(pieces[0].preview.kcal).toBeCloseTo(143, 9);
    expect(pieces[1].entry).toMatchObject({ kind: "cook", fraction: 0.5, provenance: "estimated" });
    expect(pieces[1].preview.kcal).toBeCloseTo(162, 9);
    expect(pieces[2].entry.item).toMatchObject({ food: "dahi", value: 200, unit: "g" });
    expect(pieces[3].entry).toMatchObject({ kind: "set", count: 1, set: { exercise: "Cable lat pulldown", reps: 12, rir: { low: 2, high: 2 }, load: { value: 40, unit: "kg", basis: "total" } } });
    expect(pieces[3].preview.set).toMatchObject({ set: { total_kg: 40 }, state: "confirmed" });
  });

  it("reads a percent as a share of the pot: '10% of the ghugni' and '10 % ghugni' are 0.1", async () => {
    const { x } = await ready();
    const { pieces } = await route(x, "10% of the ghugni, 10 % ghugni, 150% of the ghugni");
    expect(pieces[0]).toMatchObject({ status: "resolved", entry: { kind: "cook", fraction: 0.1, provenance: "estimated" } });
    expect(pieces[1]).toMatchObject({ status: "resolved", entry: { kind: "cook", fraction: 0.1 } });
    expect(pieces[0].preview.kcal).toBeCloseTo(32.4, 9);
    expect(pieces[2].status).not.toBe("resolved");
  });

  it("asks which state, offering each as a complete entry with its preview", async () => {
    const { x } = await ready();
    const [rice] = (await route(x, "150 g rice")).pieces;
    expect(rice).toMatchObject({ status: "needs_choice", reason: "ambiguous_state" });
    expect(rice.options.map((o: { entry: { item: { state: string } } }) => o.entry.item.state)).toEqual(["dry", "cooked"]);
    expect(rice.options.every((o: { preview: { kcal: number } }) => o.preview.kcal > 0)).toBe(true);
    expect((await route(x, "150 g cooked rice")).pieces[0].status).toBe("resolved");
  });

  it("never guesses an amount: a bare count with no matching measure, or no amount, is a choice", async () => {
    const { x } = await ready();
    const [peas] = (await route(x, "2 peas")).pieces;
    expect(peas).toMatchObject({ status: "needs_choice", reason: "amount" });
    const [curd] = (await route(x, "curd")).pieces;
    expect(curd.status).toBe("needs_choice");
  });

  it("asks which meaning when a word names several things", async () => {
    const { x } = await ready();
    const [both] = (await route(x, "1/3 of fried rice")).pieces;
    expect(both).toMatchObject({ status: "needs_choice", reason: "which_meaning" });
    expect(both.options.map((o: { entry: { kind: string } }) => o.entry.kind).sort()).toEqual(["cook", "item"]);
    expect((await route(x, "1/3 of the fried rice")).pieces[0]).toMatchObject({ status: "resolved", entry: { kind: "cook" } });
  });

  it("reads my usual from recent_items", async () => {
    const { x } = await ready();
    for (const d of ["2026-10-01", "2026-10-02"]) {
      await x.ok("log_intake", { member: "Hritvik", date: d, meal_slot: "breakfast", items: [{ source: "food", food: "egg", value: 3, measure: "egg", provenance: "counted", confidence: "high" }] });
    }
    const [eggs] = (await route(x, "my usual eggs")).pieces;
    expect(eggs).toMatchObject({ status: "resolved", entry: { kind: "item", item: { value: 3, measure: "egg" } } });
    expect((await route(x, "my usual peas")).pieces[0]).toMatchObject({ status: "unresolved", reason: "no_usual" });
  });

  it("resolves a workout name to the workout, to pre-fill it", async () => {
    const { x } = await ready();
    expect((await route(x, "hotel legs")).pieces[0]).toMatchObject({ status: "resolved", entry: { kind: "workout", name: "Hotel legs" } });
  });

  it("offers kg and lb for a load with no unit, and asks for RIR the member's own set needs", async () => {
    const { x } = await ready();
    const [unitless] = (await route(x, "40 x 12 lat pulldown rir 2")).pieces;
    expect(unitless).toMatchObject({ status: "needs_choice" });
    expect(unitless.options.map((o: { entry: { set: { load: { unit: string } } } }) => o.entry.set.load.unit)).toEqual(["kg", "lb"]);
    const [noRir] = (await route(x, "lat pulldown 40kg x 12")).pieces;
    expect(noRir).toMatchObject({ status: "needs_choice", reason: "rir_needed", field: ["set", "rir"], partial: { kind: "set" } });
  });

  it("reads 'N and a half' as one amount, never a whole and a half split apart", async () => {
    const { x } = await ready();
    x.t.insert("food_source", { household_id: x.h.id, ref: "FS050", name: "Roti", state: "cooked", reference_amount: 1, reference_unit: "piece", kcal: 120, protein_g: 3, carbs_g: 20, fat_g: 3 });
    const [roti] = (await route(x, "1 and a half roti")).pieces;
    expect(roti).toMatchObject({ span: { text: "1 and a half roti" }, status: "resolved", entry: { item: { food: "roti", value: 1.5, unit: "piece" } } });
    const { pieces } = await route(x, "1 and a half roti and 2 eggs");
    expect(pieces.map((p) => [p.span.text, p.status, p.entry?.item?.value])).toEqual([["1 and a half roti", "resolved", 1.5], ["2 eggs", "resolved", 2]]);
    // A number ending a longer part stays with it, so these still split into two pieces.
    for (const [text, first] of [["eggs 2 and half the ghugni", "eggs 2"], ["lat pulldown 40kg x 12 rir 2 and half the ghugni", "lat pulldown 40kg x 12 rir 2"]]) {
      expect((await route(x, text as string)).pieces.map((p) => [p.span.text, p.status])).toEqual([[first, "resolved"], ["half the ghugni", "resolved"]]);
    }
  });

  it("tries a piece's parts when the whole names nothing", async () => {
    const { x } = await ready();
    const { pieces } = await route(x, "2 eggs and toast");
    expect(pieces.map((p) => [p.span.text, p.status])).toEqual([["2 eggs", "resolved"], ["toast", "unresolved"]]);
    // Two amounts make the whole unreadable; its parts each have one.
    expect((await route(x, "2 eggs and 100 g curd")).pieces.map((p) => [p.span.text, p.status])).toEqual([["2 eggs", "resolved"], ["100 g curd", "resolved"]]);
    expect((await route(x, "0 g rice and 0 g curd")).pieces.map((p) => [p.span.text, p.reason])).toEqual([["0 g rice and 0 g curd", "unreadable"]]);
  });

  it("leaves what it can't read unresolved, with suggestions, and returns nothing for nothing", async () => {
    const { x } = await ready();
    const [typo] = (await route(x, "200 g curdd")).pieces;
    expect(typo).toMatchObject({ status: "unresolved", reason: "unknown" });
    expect(typo.suggestions[0]).toMatchObject({ kind: "food_source", name: "Curd (as_sold)" });
    expect((await route(x, "0 g rice")).pieces[0]).toMatchObject({ status: "unresolved", reason: "unreadable" });
    for (const text of ["", "   ", "👍", "and and"]) expect((await route(x, text)).pieces).toEqual([]);
  });

  it("sends the text past twenty pieces to Claude as one span, within the budget", async () => {
    const { x } = await ready();
    const text = Array.from({ length: 40 }, () => "2 eggs").join(", ");
    const { pieces } = (await toolWithinBudget(x, "route_text", { member: "Hritvik", text, date: MONDAY, meal_slot: "dinner" }, "hritvik")).body as { pieces: any[] };
    expect(pieces).toHaveLength(21);
    expect(pieces[20]).toMatchObject({ status: "unresolved", reason: "too_long" });
    expect(pieces[20].span.end).toBe(text.length);
  });
});

describe("route_text: the bare words of an unresolved piece", () => {
  // `words` is what learn_alias is taught and what a mapping replaces: the words without the
  // amount or unit, with offsets in the text as the span's.
  const unresolvedWords = async (x: Awaited<ReturnType<typeof ready>>["x"], text: string) =>
    (await route(x, text)).pieces.map((p) => [p.status, p.reason, p.words]);

  it("gives the words without an amount before or after them, in the text's own offsets", async () => {
    const { x } = await ready();
    expect(await unresolvedWords(x, "2 pb")).toEqual([["unresolved", "unknown", { text: "pb", start: 2, end: 4 }]]);
    expect(await unresolvedWords(x, "pb 200 g")).toEqual([["unresolved", "unknown", { text: "pb", start: 0, end: 2 }]]);
    expect(await unresolvedWords(x, "about 120 g Paneer Bhurjee")).toEqual([["unresolved", "unknown", { text: "Paneer Bhurjee", start: 12, end: 26 }]]);
    expect(await unresolvedWords(x, "half the zzq")).toEqual([["unresolved", "unknown", { text: "zzq", start: 9, end: 12 }]]);
    expect(await unresolvedWords(x, "zzq 40kg x 8")).toEqual([["unresolved", "unknown", { text: "zzq", start: 0, end: 3 }]]);
  });

  it("points into the whole text when there are several pieces, and keeps a word inside another whole", async () => {
    const { x } = await ready();
    const text = "2 eggs, 3 pb, 150 g  Qqx Rice\n1/2 qqx";
    const { pieces } = await route(x, text);
    expect(pieces.map((p) => [p.span.text, p.status, p.words])).toEqual([
      ["2 eggs", "resolved", undefined],
      ["3 pb", "unresolved", { text: "pb", start: 10, end: 12 }],
      ["150 g  Qqx Rice", "unresolved", { text: "Qqx Rice", start: 21, end: 29 }],
      ["1/2 qqx", "unresolved", { text: "qqx", start: 34, end: 37 }],
    ]);
    for (const p of pieces.filter((q) => q.words)) expect(text.slice(p.words.start, p.words.end)).toBe(p.words.text);
  });

  it("keeps Devanagari words whole, vowel signs and all, after a Devanagari amount", async () => {
    const { x } = await ready();
    const text = "2 eggs, २ पनीर भुर्जी";
    const { pieces } = await route(x, text);
    expect(pieces[1]).toMatchObject({ status: "unresolved", reason: "unknown", words: { text: "पनीर भुर्जी", start: 10, end: 21 } });
    expect(text.slice(10, 21)).toBe("पनीर भुर्जी");
  });

  it("gives the words of a part split on and, and of my usual with none", async () => {
    const { x } = await ready();
    const { pieces } = await route(x, "2 eggs and 100 g zzq toast");
    expect(pieces[1]).toMatchObject({ span: { text: "100 g zzq toast", start: 11 }, status: "unresolved", words: { text: "zzq toast", start: 17, end: 26 } });
    expect((await route(x, "my usual peas")).pieces[0]).toMatchObject({ reason: "no_usual", words: { text: "peas", start: 9, end: 13 } });
  });

  it("gives no words when an amount, a unit or a filler sits between them: that span could never be read back", async () => {
    const { x } = await ready();
    const [split] = (await route(x, "paneer 200 g bhurji")).pieces;
    expect(split).toMatchObject({ status: "unresolved", reason: "unknown" });
    expect(split.words).toBeUndefined();
    expect((await route(x, "pb with ghee")).pieces[0].words).toBeUndefined();
    expect((await route(x, "200 g paneer bhurji")).pieces[0].words).toEqual({ text: "paneer bhurji", start: 6, end: 19 });
    // Any whitespace between the words is still one span; learn_alias collapses it.
    expect((await route(x, "200 g paneer  bhurji")).pieces[0].words).toEqual({ text: "paneer  bhurji", start: 6, end: 20 });
    expect((await route(x, "paneer\tbhurji 200 g")).pieces[0].words).toEqual({ text: "paneer\tbhurji", start: 0, end: 13 });
  });

  it("learn_alias collapses the whitespace inside a word, so a mapped span teaches what the router reads", async () => {
    const { x } = await ready();
    const taught = (await x.ok("learn_alias", { alias: "  set  \tcurd ", kind: "food_source", target: "FS004", reason: "what we call it" }, "hritvik")) as { alias: { alias: string } };
    expect(taught.alias.alias).toBe("set curd");
    expect((await route(x, "200 g set  curd")).pieces[0]).toMatchObject({ status: "resolved", entry: { item: { food: "set curd", value: 200, unit: "g" } } });
    expect(await x.ok("learn_alias", { alias: "set curd", kind: "food_source", target: "FS004", reason: "again" }, "hritvik")).toMatchObject({ unchanged: true });
  });

  it("gives no words where there are none to name", async () => {
    const { x } = await ready();
    const [zero] = (await route(x, "0 g rice")).pieces;
    expect(zero).toMatchObject({ status: "unresolved", reason: "unreadable" });
    expect(zero.words).toBeUndefined();
  });
});

describe("route_text never routes to the wrong member", () => {
  it("sends back every piece of a text that names another member, unrouted", async () => {
    const { x } = await ready();
    for (const text of ["Asha, half the ghugni", "2 eggs and asha had toast", "half the ghugni for ASHA", "Kabir's 2 eggs"]) {
      const { pieces } = await route(x, text);
      expect(pieces.length).toBeGreaterThan(0);
      expect(pieces.every((p) => p.status === "unresolved" && p.reason === "other_member")).toBe(true);
    }
    const [eggs] = (await route(x, "Asha, 2 eggs")).pieces.slice(1);
    expect(eggs).toMatchObject({ status: "unresolved", reason: "other_member", words: { text: "eggs", start: 8, end: 12 } });
  });

  it("reads a name only as a whole word, and the member's own name is no other member", async () => {
    const { x } = await ready();
    expect((await route(x, "2 eggs, ashanzz")).pieces.map((p) => p.reason ?? p.status)).toEqual(["resolved", "unknown"]);
    expect((await route(x, "hritvik, 2 eggs")).pieces[1]).toMatchObject({ status: "resolved" });
  });

  it("previews a share of the pot for the member asked about: their own portion asks, as the write would", async () => {
    const { x } = await ready();
    const asAsha = (await x.ok("route_text", { member: "Asha", text: "half the ghugni", date: MONDAY }, "asha")) as { pieces: any[] };
    expect(asAsha.pieces[0]).toMatchObject({ status: "needs_choice", reason: "duplicate_portion", partial: { kind: "cook" } });
    const asAgent = (await x.ok("route_text", { member: "Kabir", text: "half the ghugni", date: MONDAY })) as { pieces: any[] };
    expect(asAgent.pieces[0]).toMatchObject({ status: "resolved", entry: { kind: "cook", fraction: 0.5 } });
  });

  it("asks rather than taking a portion from a pot whose rest is no longer unaccounted", async () => {
    const { x } = await ready();
    const ghugni = x.t.get("SELECT c.id FROM component c JOIN cook k ON k.id = c.cook_id WHERE k.name = 'Ghugni'") as { id: number };
    await x.ok("mark_remainder", { component_id: ghugni.id, disposition: "leftover", provenance: "estimated" }, "asha");
    expect((await route(x, "half the ghugni")).pieces[0]).toMatchObject({ status: "needs_choice", reason: "not_unaccounted", partial: { kind: "cook" } });
  });
});

describe("route_text budgets", () => {
  it("loads each table once per call: within the statement budget and the comparison ceiling on a big catalogue", async () => {
    const { x } = await busyInput(40);
    for (let i = 0; i < 300; i++) {
      x.t.insert("food_source", { household_id: x.h.id, ref: `FS9${i}`, name: `Invented food ${i}`, state: "as_sold", reference_amount: 100, reference_unit: "g", kcal: 100, protein_g: 5, carbs_g: 10, fat_g: 4 });
    }
    await x.ok("household_meal", { date: MONDAY, meal_slot: "lunch", cooks: [{ name: "Ghugni", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.25, provenance: "estimated" }] }] }, "asha");
    const text = "2 eggs, half the ghugni, bench 40 kg x 8 rir 2, my usual curd, zzq one, zzq two, zzq three, zzq four, zzq five";
    const started = performance.now();
    const run = await toolWithinBudget(x, "route_text", { member: "Hritvik", text, date: MONDAY, meal_slot: "dinner" }, "hritvik");
    // Node wall time, statements included: it overstates the Worker's CPU (spec §10).
    console.info(`route_text heavy case: ${run.statements} statements, ${run.body.comparisons} comparisons, ${(performance.now() - started).toFixed(1)} ms wall`);
    expect(run.body.comparisons).toBeLessThanOrEqual(ROUTE_MAX_COMPARISONS);
    expect(run.body.pieces).toHaveLength(9);
  });

  it("a long line of twenty mixed pieces, splits and all, stays within the statement budget and the ceiling", async () => {
    const { x } = await busyInput(40);
    for (let i = 0; i < 300; i++) {
      x.t.insert("food_source", { household_id: x.h.id, ref: `FS9${i}`, name: `Invented food ${i}`, state: "as_sold", reference_amount: 100, reference_unit: "g", kcal: 100, protein_g: 5, carbs_g: 10, fat_g: 4 });
    }
    await x.ok("household_meal", { date: MONDAY, meal_slot: "lunch", cooks: [{ name: "Ghugni", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.25, provenance: "estimated" }] }] }, "asha");
    await x.ok("log_intake", { member: "Hritvik", date: "2026-10-02", meal_slot: "breakfast", items: [{ source: "food", food: "curd", value: 150, unit: "g", provenance: "weighed", confidence: "high" }] }, "hritvik");
    const text = [
      "2 eggs", "half the ghugni", "bench 40 kg x 8 rir 2", "lat pulldown 40kg x 12 rir 2", "my usual curd", "150 g rice", "200 g curd", "1 tsp mustard oil",
      "2 peas", "curd", "zzq a", "zzq b", "zzq c", "zzq d", "zzq e", "zzq f", "zzq g", "zzq h", "100 g cooked rice", "3 eggs and 100 g curd",
    ].join(", ");
    const started = performance.now();
    const run = await toolWithinBudget(x, "route_text", { member: "Hritvik", text, date: MONDAY, meal_slot: "dinner" }, "hritvik");
    console.info(`route_text twenty pieces: ${run.statements} statements, ${run.body.comparisons} comparisons, ${(performance.now() - started).toFixed(1)} ms wall`);
    expect(run.body.comparisons).toBeLessThanOrEqual(ROUTE_MAX_COMPARISONS);
    const pieces = run.body.pieces as any[];
    expect(pieces).toHaveLength(21);
    expect(pieces.slice(0, 8).map((p) => p.status)).toEqual(["resolved", "resolved", "needs_choice", "resolved", "resolved", "needs_choice", "resolved", "resolved"]);
    expect(pieces[19]).toMatchObject({ span: { text: "3 eggs" }, status: "resolved" });
    expect(pieces[20]).toMatchObject({ status: "unresolved", reason: "too_long", span: { text: "100 g curd", end: text.length } });
  });

  it("asks for the session once, however many sets: thirty sets joined by and on a day with two sessions", async () => {
    const { x, s } = await busyInput(40);
    for (let i = 0; i < 2; i++) x.t.insert("session", { member_id: x.h.hritvik, performed_on: MONDAY, gym_id: s.gym, session_type: "strength", state: "confirmed", confirmed_at: "2026-10-05T00:00:00Z" });
    const text = Array.from({ length: 30 }, () => "lat pulldown 40kg x 12 rir 2").join(" and ");
    expect(text.length).toBeLessThan(1000);
    const run = await toolWithinBudget(x, "route_text", { member: "Hritvik", text, date: MONDAY, meal_slot: "dinner" }, "hritvik");
    console.info(`route_text thirty sets by and: ${run.statements} statements`);
    const pieces = run.body.pieces as any[];
    expect(pieces).toHaveLength(21);
    expect(pieces.slice(0, 20).every((p) => p.status === "needs_choice" && p.reason === "session_choice")).toBe(true);
    expect(pieces[20]).toMatchObject({ reason: "too_long", span: { start: pieces[19].span.end + 5, end: text.length } });
  });

  it("thirty comma pieces of sets stay within the budget", async () => {
    const { x } = await busyInput(40);
    const text = Array.from({ length: 30 }, () => "lat pulldown 40kg x 12 rir 2").join(", ");
    const run = await toolWithinBudget(x, "route_text", { member: "Hritvik", text, date: MONDAY, meal_slot: "dinner" }, "hritvik");
    console.info(`route_text thirty comma sets: ${run.statements} statements`);
    const pieces = run.body.pieces as any[];
    expect(pieces).toHaveLength(21);
    expect(pieces.slice(0, 20).every((p) => p.status === "resolved")).toBe(true);
  });

  it("bounds the fuzzy CPU, not just the count: a long line of unknown words joined by and", async () => {
    const { x } = await busyInput(40);
    for (let i = 0; i < 300; i++) {
      x.t.insert("food_source", { household_id: x.h.id, ref: `FS9${i}`, name: `Invented food ${i}`, state: "as_sold", reference_amount: 100, reference_unit: "g", kcal: 100, protein_g: 5, carbs_g: 10, fat_g: 4 });
    }
    const foods = x.t.all("SELECT id FROM food_source WHERE household_id = ? ORDER BY id LIMIT 60", x.h.id) as { id: number }[];
    foods.forEach((f, i) => x.t.insert("alias", { household_id: x.h.id, alias: `invented word ${i}`, kind: "food_source", target_id: f.id, created_by: x.h.hritvik, created_at: "2026-10-01T00:00:00Z" }));
    const text = Array.from({ length: 112 }, () => "zzq").join(" and ");
    expect(text.length).toBeGreaterThan(890);
    expect(text.length).toBeLessThan(1000);
    const started = performance.now();
    const run = await toolWithinBudget(x, "route_text", { member: "Hritvik", text, date: MONDAY, meal_slot: "dinner" }, "hritvik");
    console.info(`route_text zzq and zzq: ${text.length} chars, ${run.statements} statements, ${run.body.comparisons} comparisons, ${(performance.now() - started).toFixed(1)} ms wall`);
    expect(run.body.comparisons).toBeLessThanOrEqual(ROUTE_MAX_COMPARISONS);
    // A query that long (112 words) is never searched; nothing names a part, so the whole stands.
    expect(run.body.pieces).toMatchObject([{ status: "unresolved", reason: "unknown", suggestions: [] }]);
    expect(run.body.comparisons).toBe(0);
    // With a part that names something, the parts stand: only the twenty kept are searched, up to the ceiling.
    const mixed = `2 eggs and ${Array.from({ length: 110 }, () => "zzq").join(" and ")}`;
    const t2 = performance.now();
    const run2 = await toolWithinBudget(x, "route_text", { member: "Hritvik", text: mixed, date: MONDAY, meal_slot: "dinner" }, "hritvik");
    console.info(`route_text 2 eggs and zzq…: ${mixed.length} chars, ${run2.statements} statements, ${run2.body.comparisons} comparisons, ${(performance.now() - t2).toFixed(1)} ms wall`);
    expect(run2.body.comparisons).toBeLessThanOrEqual(ROUTE_MAX_COMPARISONS);
    expect(run2.body.pieces).toHaveLength(21);
    expect(run2.body.pieces[0]).toMatchObject({ span: { text: "2 eggs" }, status: "resolved" });
  });
});
