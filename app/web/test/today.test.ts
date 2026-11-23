import { describe, expect, it, vi } from "vitest";
import { buildToday, kcalWords, proteinWords } from "../src/today";
import { loadText } from "../src/format";
import { dalCook, item, meals, needs, stressHousehold, today, totals } from "./fixtures";

const text = (parts: { text: string }[]) => parts.map((p) => p.text).join("");

describe("title", () => {
  it("dates the screen and says whether it is your own day", () => {
    const view = buildToday(today());
    expect(view.title).toBe("Tue 6 Oct");
    expect(view.ownDay).toBe(true);
    expect(buildToday(today({ viewing: "Kabir" })).ownDay).toBe(false);
  });
});

describe("the left line", () => {
  it("says what is left of energy and protein, rounded, with the ± and the biggest uncertainty", () => {
    const view = buildToday(today());
    expect(text(view.left.parts)).toBe("Left today: 406 kcal and 51 g protein.");
    expect(view.left.parts.filter((p) => p.strong).map((p) => p.text)).toEqual(["406 kcal", "51 g protein"]);
    expect(view.left.note).toBe("Estimate ±120 kcal; the biggest uncertainty is bowl size, ±120, in 1 bowl. 1 estimated item has no ± given.");
  });

  it("names the biggest uncertainty in a few words, never the agent's whole note or a ref (click test P2-1)", () => {
    const long = "Egg size. FS016 is a large egg at 72 kcal; a medium is ~63 and a jumbo ~90, so three eggs span roughly 190-270 kcal.";
    const view = buildToday(today({ meals: meals({ estimate: { plus_minus_kcal: 143, estimated_items: 1, estimated_without_size: 0, dominant: { name: "Whole egg", description: long, kcal: 40 } } }) }));
    expect(view.left.note).toBe("Estimate ±143 kcal; the biggest uncertainty is egg size, ±40, in Whole egg.");
    const essay = "Whether the cook used two or three tablespoons of oil in the tadka for FS201 and the rest";
    const noWords = buildToday(today({ meals: meals({ estimate: { plus_minus_kcal: 90, estimated_items: 1, estimated_without_size: 0, dominant: { name: "Dal", description: essay, kcal: 90 } } }) }));
    expect(noWords.left.note).toBe("Estimate ±90 kcal; the biggest uncertainty is in Dal, ±90.");
  });

  it("says over by N, never a negative and never red", () => {
    const t = totals();
    const view = buildToday(today({ totals: { ...t, left: { ...t.left!, kcal: { ...t.left!.kcal, consumed: 1720, left: -120 } } } }));
    expect(text(view.left.parts)).toBe("Today: over by 120 kcal, 51 g protein left.");
  });

  it("names a past day instead of today", () => {
    const view = buildToday(today({ date: "2026-10-05" }));
    expect(text(view.left.parts)).toBe("Left on Mon 5 Oct: 406 kcal and 51 g protein.");
  });

  it("says when the estimates carry no size at all, and when nothing is estimated", () => {
    const none = buildToday(today({ meals: meals({ estimate: { plus_minus_kcal: null, estimated_items: 3, estimated_without_size: 3, dominant: null } }) }));
    expect(none.left.note).toBe("3 items are estimated, with no ± given.");
    const measured = buildToday(today({ meals: meals({ estimate: { plus_minus_kcal: null, estimated_items: 0, estimated_without_size: 0, dominant: null } }) }));
    expect(measured.left.note).toBe("Everything so far is weighed, counted or from a label.");
  });

  it("an empty day has nothing logged yet and no estimate note", () => {
    const view = buildToday(today({
      totals: totals({
        item_count: 0, so_far: {},
        left: {
          kcal: { goal: 1600, consumed: 0, left: 1600, floor: null, floorLeft: null },
          protein: { goal: 140, consumed: 0, left: 140, floor: null, floorLeft: null },
          carbs: { goal: 120, consumed: 0, left: 120, floor: null, floorLeft: null },
          fat: { goal: 55, consumed: 0, left: 55, floor: 45, floorLeft: 45 },
        },
      }),
      meals: meals({ estimate: { plus_minus_kcal: null, estimated_items: 0, estimated_without_size: 0, dominant: null } }),
    }));
    expect(text(view.left.parts)).toBe("Left today: 1,600 kcal and 140 g protein.");
    expect(view.left.note).toBe("Nothing logged yet.");
  });

  it("without a target, says so and gives what was eaten", () => {
    const view = buildToday(today({ totals: totals({ left: null, target_values: [] }) }));
    expect(text(view.left.parts)).toBe("So far today: 1,194 kcal and 89 g protein. No target is set for this day.");
  });
});

describe("the macro strip", () => {
  it("shows four columns with what is left, the fill, and N of target, with a floor or remainder in the caption", () => {
    const view = buildToday(today());
    expect(view.macros.map((m) => [m.label, m.amount, m.unit, m.caption, m.note])).toEqual([
      ["Energy", "406", "kcal", "1,194 of 1,600", null],
      ["Protein", "51", "g", "89 of 140", null],
      ["Carbs", "5", "g", "115 of 120", "the remainder"],
      ["Fat", "14", "g", "41 of 55", "floor 45"],
    ]);
    expect(view.macros[0]?.fill).toBeCloseTo(1194.4 / 1600, 9);
    expect(view.macros.every((m) => !m.over)).toBe(true);
  });

  it("an over target reads 'over by N' with a full track", () => {
    const t = totals();
    const view = buildToday(today({ totals: { ...t, left: { ...t.left!, fat: { goal: 55, consumed: 62, left: -7, floor: 45, floorLeft: 0 } } } }));
    const fat = view.macros[3];
    expect(fat).toMatchObject({ amount: "7", over: true, fill: 1 });
  });

  it("without a target shows what was eaten so far, with no track", () => {
    const view = buildToday(today({ totals: totals({ left: null, target_values: [] }) }));
    expect(view.macros.map((m) => [m.amount, m.caption, m.fill])).toEqual([
      ["1,194", "so far", null],
      ["89", "so far", null],
      ["115", "so far", null],
      ["41", "so far", null],
    ]);
  });

  it("a nutrient no item reports is unknown, not zero", () => {
    const view = buildToday(today({ totals: totals({ left: null, target_values: [], so_far: { kcal: { value: 300, known: 1, of: 1 } } }) }));
    expect(view.macros[1]).toMatchObject({ amount: "unknown", caption: "not reported", fill: null });
  });
});

describe("the pot card", () => {
  it("splits the pot: you, the others, then the hatched remainder, naming who wasn't there", () => {
    const [pot] = buildToday(today()).pots;
    expect(pot?.title).toBe("Masoor dal");
    expect(pot?.meta).toBe("lunch, logged by Kabir");
    expect(pot?.bars).toHaveLength(1);
    expect(pot?.bars[0]?.name).toBeNull();
    expect(pot?.bars[0]?.segments.map((s) => [s.kind, s.label])).toEqual([
      ["you", "You 38%"],
      ["other", "Kabir 34%"],
      ["unaccounted", "28%"],
    ]);
    expect(pot?.bars[0]?.description).toBe("Asha 38%, Kabir 34%, 28% not yet accounted for, Noor not present");
    expect(pot?.legend).toEqual(["Noor wasn't there, so no portion", "28% not yet accounted for"]);
  });

  it("asks about your draft with what it amounts to and who logged it", () => {
    const [pot] = buildToday(today()).pots;
    expect(pot?.ask).toEqual({
      question: "Kabir logged your 38% (about 180 kcal, estimated ±60, mostly ladle size). Is that right?",
      parts: [
        { text: "Kabir logged your 38% (about 180 kcal, " },
        { text: "estimated ±60, mostly ladle size", estimated: true },
        { text: "). Is that right?" },
      ],
      confirm: [{ table: "portion", id: 7 }],
      portionId: 7,
      componentId: 21,
      sharePercent: 38,
      canMarkLeftover: true,
      redraft: false,
    });
    expect(pot?.settle).toEqual([]);
  });

  it("a re-drafted share names its editor and asks to keep their change (ticket 69 re-review)", () => {
    const base = dalCook();
    const view = buildToday(today({ cooks: { member: "Asha", date: "2026-10-06", cooks: [dalCook({ ask: { ...base.ask!, logged_by: { kind: "member", name: "Asha" }, ever_confirmed: true, edited_by: { kind: "agent", origin: "live", speaker: "Kabir" } } })] } }));
    expect(view.pots[0]?.ask).toMatchObject({
      question: "Edited by Kabir: your 38% (about 180 kcal, estimated ±60, mostly ladle size). Keep their change?",
      redraft: true,
    });
    expect(buildToday(today()).pots[0]?.ask?.redraft).toBe(false);
  });

  it("an estimated share with no size says estimated alone; a weighed one carries no estimate", () => {
    const base = dalCook();
    const unsized = buildToday(today({ cooks: { member: "Asha", date: "2026-10-06", cooks: [dalCook({ ask: { ...base.ask!, plus_minus_kcal: null, uncertainty: null } })] } }));
    expect(unsized.pots[0]?.ask?.parts).toEqual([
      { text: "Kabir logged your 38% (about 180 kcal, " },
      { text: "estimated", estimated: true },
      { text: "). Is that right?" },
    ]);
    const sizedNoWords = buildToday(today({ cooks: { member: "Asha", date: "2026-10-06", cooks: [dalCook({ ask: { ...base.ask!, uncertainty: null } })] } }));
    expect(sizedNoWords.pots[0]?.ask?.question).toBe("Kabir logged your 38% (about 180 kcal, estimated ±60). Is that right?");
    const weighed = buildToday(today({ cooks: { member: "Asha", date: "2026-10-06", cooks: [dalCook({ ask: { ...base.ask!, provenance: "weighed", plus_minus_kcal: null, uncertainty: null } })] } }));
    expect(weighed.pots[0]?.ask?.parts).toEqual([{ text: "Kabir logged your 38% (about 180 kcal, weighed). Is that right?" }]);
  });

  it("an agent's draft names the member the agent was talking with", () => {
    const base = dalCook();
    const agentCook = dalCook({ logged_by: { kind: "agent", origin: "live", speaker: "Kabir" }, ask: { ...base.ask!, logged_by: { kind: "agent", origin: "live", speaker: "Kabir" } } });
    const view = buildToday(today({ cooks: { member: "Asha", date: "2026-10-06", cooks: [agentCook] } }));
    expect(view.pots[0]?.ask?.question).toMatch(/^Kabir logged your 38%/);
    expect(view.pots[0]?.meta).toBe("lunch, logged by Kabir");
  });

  it("only with no speaker does an agent's draft say the agent logged it; the Inbox's says the Inbox", () => {
    const base = dalCook();
    const agent = buildToday(today({ cooks: { member: "Asha", date: "2026-10-06", cooks: [dalCook({ ask: { ...base.ask!, logged_by: { kind: "agent", origin: "live", speaker: null } } })] } }));
    expect(agent.pots[0]?.ask?.question).toMatch(/^The agent logged your 38%/);
    const inbox = buildToday(today({ cooks: { member: "Asha", date: "2026-10-06", cooks: [dalCook({ ask: { ...base.ask!, logged_by: { kind: "agent", origin: "inbox", speaker: null } } })] } }));
    expect(inbox.pots[0]?.ask?.question).toMatch(/^The Inbox logged your 38%/);
  });

  it("with no draft on your own day, offers to mark an unaccounted rest leftover; a settled rest is said plainly", () => {
    const view = buildToday(today({ cooks: { member: "Asha", date: "2026-10-06", cooks: [dalCook({ ask: null })] } }));
    expect(view.pots[0]?.settle).toEqual([21]);
    const base = dalCook();
    const settled = dalCook({ ask: null, components: [{ ...base.components[0]!, remainder: { fraction: 0.28, status: "leftover" } }] });
    const pot = buildToday(today({ cooks: { member: "Asha", date: "2026-10-06", cooks: [settled] } })).pots[0];
    expect(pot?.settle).toEqual([]);
    expect(pot?.bars[0]?.segments[2]).toMatchObject({ kind: "leftover", label: "leftover 28%" });
    expect(pot?.legend[1]).toBe("28% kept as leftover");
  });

  it("shows a leftover someone has eaten, so the shares visibly add up to the pot (click test P1-7)", () => {
    const base = dalCook();
    const eaten = dalCook({
      ask: null,
      components: [{ ...base.components[0]!, remainder: null, leftovers: [{ serving_id: 3, member: "Kabir", you: false, fraction: 0.28, eaten_on: "2026-10-07" }] }],
    });
    const pot = buildToday(today({ cooks: { member: "Asha", date: "2026-10-06", cooks: [eaten] } })).pots[0];
    expect(pot?.bars[0]?.segments.map((x) => [x.kind, x.label])).toEqual([
      ["you", "You 38%"], ["other", "Kabir 34%"], ["other", "Kabir 28% (leftover)"],
    ]);
    expect(pot?.bars[0]?.description).toBe("Asha 38%, Kabir 34%, Kabir 28% as a leftover on Wed 7 Oct, Noor not present");
    expect(pot?.legend).toContain("28% eaten as a leftover by Kabir on Wed 7 Oct");
    // Yours is "You"; a Worker without leftovers shows the card as before.
    const mine = dalCook({ ask: null, components: [{ ...base.components[0]!, remainder: null, leftovers: [{ serving_id: 4, member: "Asha", you: true, fraction: 0.28, eaten_on: "2026-10-07" }] }] });
    expect(buildToday(today({ cooks: { member: "Asha", date: "2026-10-06", cooks: [mine] } })).pots[0]?.bars[0]?.segments[2]).toEqual({ kind: "you", label: "You 28% (leftover)", share: 0.28 });
  });

  it("names two absent members together, and labels each part of a multi-part cook", () => {
    const base = dalCook();
    const salad = { component_id: 22, name: "salad", shares: [{ ...base.components[0]!.shares[0]!, portion_id: 9, fraction: 0.5 }], remainder: null };
    const view = buildToday(today({ cooks: { member: "Asha", date: "2026-10-06", cooks: [dalCook({ absent: ["Kabir", "Noor"], components: [{ ...base.components[0]!, name: "dal" }, salad] })] } }));
    const pot = view.pots[0];
    expect(pot?.bars.map((b) => b.name)).toEqual(["dal", "salad"]);
    expect(pot?.legend).toEqual(["Kabir and Noor weren't there, so no portion", "28% of the dal not yet accounted for"]);
  });

  it("a day with no shared cook has no pot card", () => {
    expect(buildToday(today({ cooks: { member: "Asha", date: "2026-10-06", cooks: [] } })).pots).toEqual([]);
  });
});

describe("the meal tiers", () => {
  it("heads each eaten meal with its kcal and protein, and gives each item its amount and provenance", () => {
    const [breakfast, lunch] = buildToday(today()).tiers;
    expect(breakfast).toMatchObject({ label: "Breakfast", state: "eaten", meta: "438 kcal, P 37 g" });
    expect(breakfast?.items.map((i) => [i.name, i.amount, i.provenance, i.estimated])).toEqual([
      ["Oats", "50 g", "weighed", false],
      ["Whey isolate", "1 scoop", "label", false],
    ]);
    expect(lunch?.items.map((i) => [i.name, i.amount, i.provenance, i.estimated])).toEqual([
      ["Masoor dal", "38% of the pot", "estimated, no ± recorded", true],
      ["Paneer bhurji", null, "estimated ±120", true],
    ]);
  });

  it("keeps nothing yet, skipped and not recorded apart", () => {
    const view = buildToday(today({
      meals: meals({
        slots: [
          { slot: "breakfast", state: "not_recorded", totals: null, items: [] },
          { slot: "snack", state: "skipped", totals: null, items: [] },
          { slot: "dinner", state: "nothing_yet", totals: null, items: [] },
        ],
      }),
    }));
    expect(view.tiers.map((t) => [t.state, t.meta])).toEqual([
      ["not_recorded", "not recorded"],
      ["skipped", "skipped"],
      ["nothing_yet", "nothing yet"],
    ]);
  });

  it("shows a meal's Tell Claude text still waiting under it, and the meal no longer says nothing yet (decision 75)", () => {
    const entry = (over: object) => ({ id: 1, member: "Asha", date: "2026-10-06", meal_slot: "dinner", text: "poha and chai", spans: [], status: "pending" as const, note: null, created_at: "2026-10-06T03:00:00Z", ...over });
    const view = buildToday(today({ waiting: [entry({}), entry({ id: 2, text: "a banana" }), entry({ id: 3, meal_slot: "snack", text: "an apple" })] }));
    const by = Object.fromEntries(view.tiers.map((t) => [t.slot, t]));
    expect(by.dinner).toMatchObject({ state: "nothing_yet", meta: "sent to Claude", waiting: ['Waiting for Claude: "poha and chai"', 'Waiting for Claude: "a banana"'] });
    // A meal already marked skipped still says so, with the text under it.
    expect(by.snack).toMatchObject({ state: "skipped", meta: "skipped", waiting: ['Waiting for Claude: "an apple"'] });
    expect(by.breakfast?.waiting).toEqual([]);
    expect(buildToday(today()).tiers.every((t) => t.waiting.length === 0)).toBe(true);
  });

  it("marks a draft with who logged it; a portion's draft is settled on its pot card", () => {
    const view = buildToday(today({
      meals: meals({
        slots: [{
          slot: "snack", state: "eaten", totals: { kcal: 100, protein: 10 },
          items: [
            item({ id: 5, name: "Greek yogurt", state: "draft", logged_by: { kind: "member", name: "Kabir" } }),
            item({ id: 3, source_kind: "portion", portion_id: 7, name: "Masoor dal", amount: { fraction: 0.38 }, state: "draft", logged_by: { kind: "member", name: "Kabir" } }),
          ],
        }],
      }),
    }));
    expect(view.tiers[0]?.items.map((i) => i.draft)).toEqual([
      { by: "Kabir", confirm: [{ table: "intake_item", id: 5 }], where: "here", edited: false },
      { by: "Kabir", confirm: [{ table: "intake_item", id: 3 }], where: "pot", edited: false },
    ]);
    const theirs = buildToday(today({ viewing: "Kabir", meals: meals({ slots: [{ slot: "snack", state: "eaten", totals: { kcal: 100, protein: 10 }, items: [item({ id: 5, state: "draft", logged_by: { kind: "agent", origin: "inbox", speaker: null } })] }] }) }));
    expect(theirs.tiers[0]?.items[0]?.draft).toEqual({ by: "The Inbox", confirm: [{ table: "intake_item", id: 5 }], where: "owner", edited: false });
  });

  it("on another member's day, your own plain draft is yours to take back; anything else waits for them (ticket 69)", () => {
    const draft = (over: Parameters<typeof item>[0]) => item({ state: "draft", ...over });
    const view = buildToday(today({ viewing: "Kabir", meals: meals({ slots: [{ slot: "snack", state: "eaten", totals: { kcal: 100, protein: 10 }, items: [
      draft({ id: 5, logged_by: { kind: "member", name: "Asha" } }),
      draft({ id: 6, logged_by: { kind: "agent", origin: "live", speaker: "Asha" } }),
      draft({ id: 7, logged_by: { kind: "agent", origin: "inbox", speaker: "Asha" } }),
      draft({ id: 8, logged_by: { kind: "member", name: "Noor" } }),
      draft({ id: 9, source_kind: "portion", portion_id: 4, logged_by: { kind: "member", name: "Asha" } }),
      draft({ id: 10, leftover_serving_id: 3, logged_by: { kind: "member", name: "Asha" } }),
    ] }] }) }));
    // An Inbox-created draft naming you is yours too, as the Worker has it (review P2-2).
    expect(view.tiers[0]?.items.map((i) => i.draft?.where)).toEqual(["author", "author", "author", "owner", "owner", "owner"]);
    expect(view.tiers[0]?.items[0]?.draft).toEqual({ by: "Asha", confirm: [{ table: "intake_item", id: 5 }], where: "author", edited: false });
  });

  it("a draft its member had confirmed is a re-draft: edited by its editor, theirs to keep or undo, never yours to take back (review P1-1, P2-3)", () => {
    const redraft = item({ id: 5, state: "draft", logged_by: { kind: "member", name: "Asha" }, ever_confirmed: true, edited_by: { kind: "agent", origin: "live", speaker: "Kabir" } });
    const mine = buildToday(today({ meals: meals({ slots: [{ slot: "snack", state: "eaten", totals: { kcal: 100, protein: 10 }, items: [redraft] }] }) }));
    expect(mine.tiers[0]?.items[0]?.draft).toEqual({ by: "Kabir", confirm: [{ table: "intake_item", id: 5 }], where: "redraft", edited: true });
    const plain = buildToday(today({ meals: meals({ slots: [{ slot: "snack", state: "eaten", totals: { kcal: 100, protein: 10 }, items: [{ ...redraft, ever_confirmed: false, edited_by: null }] }] }) }));
    expect(plain.tiers[0]?.items[0]?.draft).toMatchObject({ by: "Asha", where: "here", edited: false });
    // On Kabir's day, his own item that Asha edited is not hers to take back.
    const theirs = buildToday(today({ viewing: "Kabir", meals: meals({ slots: [{ slot: "snack", state: "eaten", totals: { kcal: 100, protein: 10 }, items: [{ ...redraft, edited_by: { kind: "member", name: "Asha" } }] }] }) }));
    expect(theirs.tiers[0]?.items[0]?.draft).toMatchObject({ by: "Asha", where: "owner", edited: true });
  });

  it("names a recipe by servings, a counted measure, and prefers the words the member used", () => {
    const view = buildToday(today({
      meals: meals({
        slots: [{
          slot: "dinner", state: "eaten", totals: { kcal: 500, protein: 30 },
          items: [
            item({ id: 6, source_kind: "recipe", name: "Egg fried rice", amount: { servings: 1.5 }, provenance: "estimated" }),
            item({ id: 7, name: "Egg", amount: { value: 2, unit: "measure", measure: "egg" }, provenance: "counted" }),
            item({ id: 10, name: "Pizza (whole)", amount: { value: 0.3333, unit: "piece" }, provenance: "estimated" }),
            item({ id: 8, name: "Roti", label: "2 medium", amount: { value: 2, unit: "piece" }, provenance: "counted" }),
            item({ id: 9, name: "Banana", label: "Banana (1 medium, about 118 g, size assumed)", amount: { value: 118, unit: "g" }, provenance: "estimated" }),
          ],
        }],
      }),
    }));
    expect(view.tiers[0]?.items.map((i) => i.amount)).toEqual(["1.5 servings", "2 egg", "0.33 pc", "2 medium", "118 g"]);
  });

  it("shows a draft the agent logged by its structured amount, not the raw words (click test P2-26)", () => {
    const agent = { kind: "agent" as const, origin: "live", speaker: "Kabir" };
    const view = buildToday(today({
      meals: meals({
        slots: [{
          slot: "breakfast", state: "eaten", totals: { kcal: 180, protein: 12 },
          items: [
            item({ id: 11, name: "Provilac High Protein Milk", label: "provilac milk 280ml", amount: { value: 280, unit: "ml" }, provenance: "estimated", state: "draft", logged_by: agent }),
            item({ id: 12, name: "Roti", label: "2 medium", amount: { value: 2, unit: "piece" }, provenance: "counted", state: "draft", logged_by: { kind: "member", name: "Kabir" } }),
            item({ id: 13, name: "Egg", label: "2 boiled", amount: { value: 2, unit: "measure", measure: "egg" }, provenance: "counted", state: "draft", logged_by: { kind: "agent", origin: "inbox", speaker: null } }),
          ],
        }],
      }),
    }));
    // A member's own draft keeps their words (decision 22).
    expect(view.tiers[0]?.items.map((i) => i.amount)).toEqual(["280 ml", "2 medium", "2 egg"]);
  });
});

describe("the footer", () => {
  it("is one line naming the next session, linking to Train for the member viewed", () => {
    expect(buildToday(today()).footer).toEqual([{ label: "Next session", value: "Lower A, Thu 8 Oct", href: "/train" }]);
    expect(buildToday(today({ viewing: "Kabir" })).footer).toEqual([{ label: "Next session", value: "Lower A, Thu 8 Oct", href: "/train?member=Kabir" }]);
  });

  it("says a record-only member's sessions are trainer-led", () => {
    const view = buildToday(today({ viewing: "Kabir", next: { programming_mode: "record_only", session: null } }));
    expect(view.footer).toEqual([{ label: "Sessions", value: "trainer-led", href: "/train?member=Kabir" }]);
  });
});

describe("loadText", () => {
  it("reads a composition as the bar plus the plates a side, units mixed", () => {
    expect(loadText({ value: 12.27, unit: "kg", basis: "per_side", bar: { value: 20, unit: "kg" }, plates: [{ value: 10, unit: "kg", count: 1 }, { value: 5, unit: "lb", count: 1 }] })).toBe("20 kg bar + 10 kg + 5 lb a side");
  });

  it("reads a sled press's repeated plates, a dumbbell and a bar with no plates", () => {
    expect(loadText({ value: 40, unit: "kg", basis: "per_side", bar: null, plates: [{ value: 20, unit: "kg", count: 2 }] })).toBe("2 × 20 kg a side");
    expect(loadText({ value: 12.5, unit: "kg", basis: "per_hand", bar: null, plates: null })).toBe("12.5 kg a hand");
    expect(loadText({ value: 15, unit: "lb", basis: "per_side", bar: { value: 20, unit: "kg" }, plates: null })).toBe("20 kg bar + 15 lb a side");
  });
});

describe("the needs-you strip", () => {
  it("shows on your own today", () => {
    expect(buildToday(today({ needs: needs() })).strip?.cards).toHaveLength(6);
  });

  it("is absent on someone else's day and on a past day", () => {
    expect(buildToday(today({ viewing: "Kabir", needs: needs() })).strip).toBeNull();
    expect(buildToday(today({ date: "2026-10-05", needs: needs() })).strip).toBeNull();
  });

  it("follows the household's today from the API, not the phone's clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T23:30:00Z"));
    try {
      expect(buildToday(today({ needs: needs() })).strip).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Sheets-era honesty", () => {
  it("notes an imported day, and a day mostly typed in as macros, with the share", () => {
    const view = buildToday(today({ meals: meals({ honesty: { imported: true, typed_macros: { items: 3, kcal: 1200, share: 0.71, high: true } } }) }));
    expect(view.notes).toEqual(["Imported from Sheets.", "71% of this day's known energy was typed in as macros in Sheets, not from the catalogue."]);
  });

  it("says nothing when the day was logged here and is not mostly typed", () => {
    expect(buildToday(today()).notes).toEqual([]);
  });
});

describe("the one wording of energy and protein (plan review, prior-art F2, structural F1)", () => {
  it("reads a number, and null or undefined as unknown, never 0", () => {
    expect([kcalWords(1194.4), kcalWords(0), kcalWords(null), kcalWords(undefined)]).toEqual(["1,194 kcal", "0 kcal", "kcal unknown", "kcal unknown"]);
    expect([proteinWords(42), proteinWords(0), proteinWords(null), proteinWords(undefined)]).toEqual(["P 42 g", "P 0 g", "P unknown", "P unknown"]);
  });

  it("is the tier header's wording too, unchanged", () => {
    const view = buildToday(today());
    expect(view.tiers[0]?.meta).toBe("438 kcal, P 37 g");
    const unknown = buildToday(today({ meals: meals({ slots: [{ slot: "breakfast", state: "eaten", totals: { kcal: null, protein: null }, items: [item()] }] }) }));
    expect(unknown.tiers[0]?.meta).toBe("kcal unknown, P unknown");
  });
});

describe("a tier item's kcal and protein (wide-layout spec §5, Today B; review #8)", () => {
  it("words the API's values", () => {
    expect(buildToday(today()).tiers[0]?.items[0]).toMatchObject({ kcal: "190 kcal", protein: "P 7 g" });
  });

  it("reads a value nobody knows as unknown, never 0", () => {
    const dinner = buildToday(stressHousehold().today).tiers.find((t) => t.slot === "dinner");
    expect(dinner?.items.find((i) => i.name === "Tofu")).toMatchObject({ kcal: "kcal unknown", protein: "P unknown" });
  });

  it("shows a measured zero as 0", () => {
    const zero = buildToday(today({ meals: meals({ slots: [{ slot: "breakfast", state: "eaten", totals: { kcal: 0, protein: 0 }, items: [item({ name: "Black coffee", kcal: 0, protein: 0 })] }] }) }));
    expect(zero.tiers[0]?.items[0]).toMatchObject({ kcal: "0 kcal", protein: "P 0 g" });
  });
});

describe("a partial total says so (ticket 72, web decision 118)", () => {
  const stress = () => stressHousehold().today;

  it("heads a meal that leaves out an unknown item with its known sum, a plus, and the count", () => {
    const dinner = buildToday(stress()).tiers.find((t) => t.slot === "dinner");
    expect(dinner?.meta).toBe("1,315+ kcal, P 75+ g · 1 item unknown");
    // The item itself still reads unknown; a complete meal is unchanged.
    expect(dinner?.items.find((i) => i.name === "Tofu")).toMatchObject({ kcal: "kcal unknown", protein: "P unknown" });
    expect(buildToday(stress()).tiers[0]?.meta).toBe("438 kcal, P 37 g");
  });

  it("marks only the nutrient its unknown items leave out, and counts the larger", () => {
    const one = buildToday(today({ meals: meals({ slots: [{ slot: "breakfast", state: "eaten", totals: { kcal: 300, protein: 20, unknown_items: { kcal: 0, protein: 2 } }, items: [item()] }] }) }));
    expect(one.tiers[0]?.meta).toBe("300 kcal, P 20+ g · 2 items unknown");
  });

  it("a meal of only unknown items reads unknown, with no count", () => {
    const none = buildToday(today({ meals: meals({ slots: [{ slot: "breakfast", state: "eaten", totals: { kcal: null, protein: null, unknown_items: { kcal: 1, protein: 1 } }, items: [item()] }] }) }));
    expect(none.tiers[0]?.meta).toBe("kcal unknown, P unknown");
  });

  it("says the day's left is at most what it reads, with the count", () => {
    const view = buildToday(stress());
    expect(text(view.left.parts)).toBe("Left today: at most 406 kcal and at most 51 g protein · 1 item unknown.");
    expect(view.left.parts.filter((p) => p.strong).map((p) => p.text)).toEqual(["406 kcal", "51 g protein"]);
  });

  it("says over by at least, when over", () => {
    const t = totals({ unknown_items: { kcal: 1, protein: 0, carbs: 0, fat: 0 } });
    const view = buildToday(today({ totals: { ...t, left: { ...t.left!, kcal: { ...t.left!.kcal, consumed: 1720, left: -120 } } } }));
    expect(text(view.left.parts)).toBe("Today: over by 120+ kcal, 51 g protein left · 1 item unknown.");
  });

  it("says so far is at least what it reads, with no target", () => {
    const view = buildToday(today({ totals: totals({ left: null, unknown_items: { kcal: 2, protein: 2, carbs: 2, fat: 2 } }) }));
    expect(text(view.left.parts)).toBe("So far today: 1,194+ kcal and 89+ g protein · 2 items unknown. No target is set for this day.");
  });

  it("marks each macro column whose sum is partial: left at most, consumed at least", () => {
    const t = totals({ unknown_items: { kcal: 1, protein: 1, carbs: 0, fat: 1 } });
    const macros = buildToday(today({ totals: { ...t, left: { ...t.left!, fat: { ...t.left!.fat, consumed: 60, left: -5 } } } })).macros;
    expect(macros.map((m) => [m.amount, m.caption])).toEqual([
      ["≤406", "1,194+ of 1,600"],
      ["≤51", "89+ of 140"],
      ["5", "115 of 120"],
      ["5+", "60+ of 55"],
    ]);
    const noTarget = buildToday(today({ totals: totals({ left: null, unknown_items: { kcal: 1, protein: 0, carbs: 0, fat: 0 } }) })).macros;
    expect(noTarget[0]).toMatchObject({ amount: "1,194+", caption: "so far" });
  });

  it("a day whose items are all unknown reads unknown of the goal in the strip, with no track (review P2-1)", () => {
    const t = totals({ so_far: {}, unknown_items: { kcal: 1, protein: 1, carbs: 1, fat: 1, any: 1 } });
    const line = (goal: number) => ({ goal, consumed: 0, left: goal, floor: null, floorLeft: null });
    const view = buildToday(today({ totals: { ...t, left: { kcal: line(1600), protein: line(140), carbs: line(120), fat: line(55) } } }));
    expect(view.macros[0]).toMatchObject({ amount: "≤1,600", caption: "unknown of 1,600", fill: null });
    expect(text(view.left.parts)).toBe("Left today: at most 1,600 kcal and at most 140 g protein · 1 item unknown.");
  });

  it("counts an item with any macro unknown once, a carbs-only unknown too (review P2-4)", () => {
    const view = buildToday(today({ totals: totals({ unknown_items: { kcal: 0, protein: 0, carbs: 1, fat: 0, any: 1 } }) }));
    expect(text(view.left.parts)).toBe("Left today: 406 kcal and 51 g protein · 1 item unknown.");
    expect(view.macros[2]).toMatchObject({ amount: "≤5", caption: "115+ of 120" });
    const meal = buildToday(today({ meals: meals({ slots: [{ slot: "breakfast", state: "eaten", totals: { kcal: 300, protein: 20, unknown_items: { kcal: 1, protein: 1, any: 2 } }, items: [item()] }] }) }));
    expect(meal.tiers[0]?.meta).toBe("300+ kcal, P 20+ g · 2 items unknown");
  });

  it("a partly known item's row reads its known part with a plus (review P2-3)", () => {
    const view = buildToday(today({ meals: meals({ slots: [{ slot: "lunch", state: "eaten", totals: { kcal: 450, protein: 7, unknown_items: { kcal: 1, protein: 0, any: 1 } }, items: [item({ name: "Curd rice", kcal: 450, protein: 7, partial: { kcal: true, protein: false } })] }] }) }));
    expect(view.tiers[0]?.items[0]).toMatchObject({ kcal: "450+ kcal", protein: "P 7 g" });
    expect(view.tiers[0]?.meta).toBe("450+ kcal, P 7 g · 1 item unknown");
  });

  it("an older Worker without the count reads as before", () => {
    const view = buildToday(today());
    expect(text(view.left.parts)).toBe("Left today: 406 kcal and 51 g protein.");
    expect(view.macros[0]?.amount).toBe("406");
  });
});
