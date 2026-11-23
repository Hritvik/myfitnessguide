// Tickets 61 and 63 end to end: Today's and Train's fix plans
// (app/web/src/fixes.ts) built from the real tools' answers, sent through the
// app's own client (callTool, runPlanResults, writeBook) to the real write
// tools, and the stored result read back. Pure functions only; no DOM.
// Invented data only.
import { describe, expect, it } from "vitest";
import { callTool } from "../../web/src/api";
import { editItemPlan, editReadingPlan, editSetPlan, itemFix, switchItemMeasure, readingFixes, removeItemPlan, removeReadingPlan, removeSetPlan } from "../../web/src/fixes";
import { setPlan } from "../../web/src/setEntry";
import { buildHistory, editCardioPlan, removeCardioPlan } from "../../web/src/train";
import { loggedLines } from "../../web/src/workout";
import type { DayMeals, LogWorkout, MealItem, ReadingMetrics, SessionsList } from "../../web/src/types";
import { confirmPlan, planStep, questionChoices, sameInput, runPlanResults, writeBook, type Call, type Plan } from "../../web/src/writes";
import { setup, type As, type Harness } from "./harness";
import { MONDAY, seedUpperA } from "./input-seed";
import { seedCatalogue, seedTraining } from "./seed";


/** The app's own client, signed in as `as`, against the harness's Worker. */
const appCall = (x: Harness, as: As): Call => (tool, input) =>
  callTool(tool, input, {
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("x-test-as", as);
      return x.app.fetch(new Request(`https://api.test${String(url)}`, { ...init, headers }));
    },
  });

const run = async (x: Harness, plan: Plan | { error: string }, as: As = "hritvik") => {
  if ("error" in plan) throw new Error(plan.error);
  return runPlanResults(plan, appCall(x, as));
};

const meals = async (x: Harness, date = MONDAY) => (await x.ok("day_meals", { member: "Hritvik", date }, "hritvik")) as unknown as DayMeals;
const items = async (x: Harness, date = MONDAY) => (await meals(x, date)).slots.flatMap((s) => s.items.map((i) => ({ ...i, slot: s.slot }))) as (MealItem & { slot: string })[];

describe("Today's fix plans against the real tools", () => {
  it("edits a food's amount and meal in one amend, then removes it", async () => {
    const x = setup();
    await seedCatalogue(x);
    await x.ok("log_intake", { member: "Hritvik", date: MONDAY, meal_slot: "breakfast", items: [{ source: "food", food: "curd", value: 50, unit: "g", provenance: "weighed", confidence: "high" }] }, "hritvik");
    const [rice] = await items(x);
    const fix = itemFix(rice!, rice!.slot, MONDAY);
    if (fix.edit === "leftover") throw new Error("not a leftover");
    const edited = await run(x, editItemPlan(fix.edit, { amount: "75", slot: "lunch", date: MONDAY }, MONDAY));
    expect(edited.status).toEqual({ state: "saved", message: "Changed." });
    const after = (await items(x))[0];
    expect(after).toMatchObject({ id: rice!.id, slot: "lunch", amount: { value: 75, unit: "g" } });
    expect(x.t.get("SELECT w.reason FROM record_version v JOIN write_log w ON w.id = v.write_id WHERE v.table_name = 'intake_item' AND v.record_id = ? ORDER BY v.version DESC", rice!.id)).toEqual({ reason: "Corrected in the app" });

    const removed = await run(x, removeItemPlan(itemFix(after!, after!.slot, MONDAY).remove));
    expect(removed.status).toEqual({ state: "saved", message: "Removed." });
    expect(await items(x)).toEqual([]);
  });

  it("changes a food's measure in place: the Edit offers its measures and amend recomputes it (click test P2-8)", async () => {
    const x = setup();
    await seedCatalogue(x);
    await x.ok("log_intake", { member: "Hritvik", date: MONDAY, meal_slot: "breakfast", items: [{ source: "food", food: "egg", value: 100, unit: "g", provenance: "weighed", confidence: "high" }] }, "hritvik");
    const [egg] = await items(x);
    expect(egg!.food).toEqual({ ref: "FS003", reference_unit: "g", measures: [{ name: "egg", amount: 50 }] });
    const fix = itemFix(egg!, egg!.slot, MONDAY);
    if (fix.edit === "leftover" || !fix.edit.amount?.options) throw new Error("a food with measures");
    expect(fix.edit.amount.options.map((o) => o.label)).toEqual(["egg (50 g)", "g"]);
    const draft = switchItemMeasure(fix.edit.amount, { amount: "100", slot: "breakfast", date: MONDAY, option: fix.edit.amount.current }, 0);
    expect(draft.amount).toBe("2");
    expect((await run(x, editItemPlan(fix.edit, { ...draft, amount: "3" }, MONDAY))).status.state).toBe("saved");
    const after = (await items(x))[0]!;
    expect(after).toMatchObject({ id: egg!.id, amount: { value: 3, unit: "measure", measure: "egg" } });
    expect(after.kcal).toBeCloseTo(214.5, 6);
  });

  it("moves an item to an earlier day", async () => {
    const x = setup();
    await seedCatalogue(x);
    await x.ok("log_intake", { member: "Hritvik", date: MONDAY, meal_slot: "breakfast", items: [{ source: "food", food: "curd", value: 50, unit: "g", provenance: "weighed", confidence: "high" }] }, "hritvik");
    const [rice] = await items(x);
    const fix = itemFix(rice!, rice!.slot, MONDAY);
    if (fix.edit === "leftover") throw new Error("not a leftover");
    expect((await run(x, editItemPlan(fix.edit, { amount: "50", slot: "breakfast", date: "2026-10-04" }, MONDAY))).status.state).toBe("saved");
    expect(await items(x)).toEqual([]);
    expect((await items(x, "2026-10-04")).map((i) => i.id)).toEqual([rice!.id]);
  });

  it("changes a pot share's percent on its portion and its meal on its item, and removes it as the portion", async () => {
    const x = setup();
    await seedCatalogue(x);
    await x.ok("household_meal", {
      date: MONDAY, meal_slot: "lunch",
      cooks: [{ name: "Rajma", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Hritvik", fraction: 0.4, provenance: "estimated" }] }],
    }, "hritvik");
    const [share] = await items(x);
    expect(share).toMatchObject({ source_kind: "portion", state: "confirmed" });
    const fix = itemFix(share!, share!.slot, MONDAY);
    expect(fix.remove).toEqual({ table: "portion", id: share!.portion_id });
    if (fix.edit === "leftover") throw new Error("not a leftover");
    expect((await run(x, editItemPlan(fix.edit, { amount: "50", slot: "dinner", date: MONDAY }, MONDAY))).status.state).toBe("saved");
    expect((await items(x))[0]).toMatchObject({ slot: "dinner", amount: { fraction: 0.5 } });

    expect((await run(x, removeItemPlan(fix.remove))).status.state).toBe("saved");
    expect(await items(x)).toEqual([]);
    expect(x.t.get("SELECT count(*) AS n FROM portion")).toEqual({ n: 0 });
  });

  it("a share that would take more than the pot asks on its first step, and the meal stays as it was", async () => {
    const x = setup();
    await seedCatalogue(x);
    await x.ok("household_meal", {
      date: MONDAY, meal_slot: "lunch",
      cooks: [{
        name: "Rajma", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }],
        portions: [{ member: "Hritvik", fraction: 0.4, provenance: "estimated" }, { member: "Asha", fraction: 0.5, provenance: "estimated" }],
      }],
    }, "hritvik");
    const [share] = await items(x);
    const fix = itemFix(share!, share!.slot, MONDAY);
    if (fix.edit === "leftover") throw new Error("not a leftover");
    const out = await run(x, editItemPlan(fix.edit, { amount: "70", slot: "dinner", date: MONDAY }, MONDAY));
    expect(out.status).toMatchObject({ state: "question", reason: "portions_exceed_whole" });
    expect(out.results).toEqual([]);
    expect((await items(x))[0]).toMatchObject({ slot: "lunch", amount: { fraction: 0.4 } });
  });

  it("a leftover helping: no edit (the API refuses one), and Remove retracts its serving", async () => {
    const x = setup();
    await seedCatalogue(x);
    const COOKED = "2026-10-03";
    const meal = await x.ok("household_meal", {
      date: COOKED, meal_slot: "lunch",
      cooks: [{ name: "Rajma", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }] }],
    }, "hritvik");
    const componentId = meal.cooks[0].components[0].id as number;
    await x.ok("mark_remainder", { component_id: componentId, disposition: "leftover", provenance: "estimated", date: COOKED }, "hritvik");
    const eaten = await x.ok("mark_remainder", { component_id: componentId, disposition: "eaten", member: "Hritvik", meal_slot: "dinner", fraction: 0.2, provenance: "estimated" }, "hritvik");
    const [helping] = await items(x);
    const fix = itemFix(helping!, helping!.slot, MONDAY);
    expect(fix.edit).toBe("leftover");
    expect(fix.remove).toEqual({ table: "leftover_serving", id: eaten.serving.id });
    // Why Edit says "Remove it and log it again": the item can't be amended.
    expect((await x.call("amend", { record: { table: "intake_item", id: helping!.id }, changes: { meal_slot: "lunch" }, reason: "x" }, "hritvik")).body.error.code).toBe("amend_the_serving");

    expect((await run(x, removeItemPlan(fix.remove))).status.state).toBe("saved");
    expect(await items(x)).toEqual([]);
    expect(x.t.get("SELECT count(*) AS n FROM leftover_serving")).toEqual({ n: 0 });
  });
});

describe("Train's fix plans against the real tools", () => {
  it("edits a set's reps and RIR in one amend (its load stays), then removes it", async () => {
    const x = setup();
    const s = seedTraining(x);
    seedUpperA(x, s);
    await x.ok("log_set", { member: "Hritvik", date: MONDAY, exercise: "lat pulldown", reps: 12, rir: 2, load: { value: 40, unit: "kg", basis: "total" } }, "hritvik");
    const sessions = async () => (await x.ok("sessions", { member: "Hritvik", from: MONDAY, to: MONDAY }, "hritvik")) as unknown as SessionsList;
    const [card] = buildHistory(await sessions(), true);
    const fix = card!.sets[0]!.fix!;
    expect((await run(x, editSetPlan(fix.edit, { reps: "10", rir: "1-2" }, "prescribed"))).status).toEqual({ state: "saved", message: "Set changed." });
    const [again] = buildHistory(await sessions(), true);
    expect(again!.sets[0]!.text).toBe("Cable lat pulldown: 10 × 40 kg, RIR 1–2");

    expect((await run(x, removeSetPlan(fix.edit.id))).status.state).toBe("saved");
    expect(buildHistory(await sessions(), true)[0]?.sets ?? []).toEqual([]);
  });
});

describe("a timed or measured set reads by its time or distance on Train (click test P2-14)", () => {
  it("says the seconds or the distance the API stored, never \"? ×\"", async () => {
    const x = setup();
    seedTraining(x);
    await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets: [
      { exercise: "incline walk", duration_s: 1600, load: "none" },
      { exercise: "pushups", duration_s: 45, rir: 1, load: "none" },
      { exercise: "db curl", distance: { value: 20, unit: "m" }, load: { value: 10, unit: "kg", basis: "per_hand" } },
    ] }, "hritvik");
    const list = (await x.ok("sessions", { member: "Hritvik", from: MONDAY, to: MONDAY }, "hritvik")) as unknown as SessionsList;
    const [card] = buildHistory(list, true);
    expect(card!.sets.map((s) => s.text)).toEqual([
      "Push-up: 45 s, RIR 1",
      "Dumbbell curl: 20 m with 10 kg a hand",
    ]);
    // The treadmill line is a cardio block in the same session (ticket 68), and its Remove leaves the sets.
    expect(card!.cardio).toBe("Cardio: 1 block, 26.67 min");
    expect((await run(x, removeCardioPlan(card!.cardioFix!.remove, card!.cardioFix!.session))).status.state).toBe("saved");
    const after = buildHistory((await x.ok("sessions", { member: "Hritvik", from: MONDAY, to: MONDAY }, "hritvik")) as unknown as SessionsList, true)[0];
    expect(after).toMatchObject({ id: card!.id, sets: [{ text: "Push-up: 45 s, RIR 1" }, { text: "Dumbbell curl: 20 m with 10 kg a hand" }] });
    expect(after!.cardio).toBeUndefined();
  });
});

describe("a timed set's Edit (ticket 68)", () => {
  it("changes a hold's seconds in one amend, never asking reps or RIR of a prescribed member", async () => {
    const x = setup();
    seedTraining(x);
    await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets: [{ exercise: "pushups", duration_s: 45, load: "none" }] }, "hritvik");
    const list = async () => (await x.ok("sessions", { member: "Hritvik", from: MONDAY, to: MONDAY }, "hritvik")) as unknown as SessionsList;
    const [hold] = buildHistory(await list(), true)[0]!.sets;
    if (!hold?.fix) throw new Error("an own confirmed set has a fix");
    expect(hold.fix.edit).toMatchObject({ counted: "seconds", secs: "45" });
    expect((await run(x, editSetPlan(hold.fix.edit, { reps: "", rir: "", secs: "60" }, "prescribed"))).status.state).toBe("saved");
    expect(buildHistory(await list(), true)[0]!.sets.map((s) => s.text)).toEqual(["Push-up: 1 min"]);
  });
});

describe("a cardio session can be fixed on Train (click test P2-20)", () => {
  it("edits a one-block session's minutes in one amend, then removes the session itself, its energy with it", async () => {
    const x = setup();
    seedTraining(x);
    // The week's exercise energy, as week_summary counts it from the sessions on each day.
    const energy = async () => {
      const week = (await x.ok("week_summary", { member: "Hritvik", week: MONDAY }, "hritvik")) as { days: { training: { energy_kcal: number | null }[] }[] };
      return week.days.flatMap((d) => d.training).reduce((a, t) => a + (t.energy_kcal ?? 0), 0);
    };
    const before = await energy();
    await x.ok("log_cardio", { member: "Hritvik", date: MONDAY, session_type: "class", energy_kcal: 300, blocks: [{ kind: "steady", activity: "dance", duration_s: 1800 }] }, "hritvik");
    expect(await energy()).toBe(before + 300);
    const sessions = async () => (await x.ok("sessions", { member: "Hritvik", from: MONDAY, to: MONDAY }, "hritvik")) as unknown as SessionsList;
    const [card] = buildHistory(await sessions(), true);
    const fix = card!.cardioFix!;
    expect(fix.edit).toMatchObject({ minutes: "30" });
    expect((await run(x, editCardioPlan(fix.edit!, "25"))).status).toEqual({ state: "saved", message: "Changed to 25 min." });
    expect(buildHistory(await sessions(), true)[0]!.summary).toBe("1 block, 25 min, 300 kcal");
    const remove = removeCardioPlan(fix.remove, fix.session);
    expect(remove.steps.map((s) => [s.tool, s.input.records])).toEqual([["retract", fix.remove], ["retract", [{ table: "session", id: card!.id }]]]);
    expect((await run(x, remove)).status.state).toBe("saved");
    expect(buildHistory(await sessions(), true)).toEqual([]);
    expect(await energy()).toBe(before);
  });
});

describe("a member with no home gym logs a set by choosing a gym (ticket 63)", () => {
  it("the Save asks which gym with the household's gyms; the chip resends under the same key and the session starts there", async () => {
    const x = setup();
    const s = seedTraining(x);
    const calls: Record<string, unknown>[] = [];
    const call = appCall(x, "kabir");
    const book = writeBook(async (tool, input) => (calls.push(input), call(tool, input)), { status: () => {}, saved: () => {}, signedOut: () => {} });
    const asked = await book.run("save", setPlan({ member: "Kabir", date: MONDAY, exercise: "pushups", set_type: "working", reps: 10, rir: { low: 2, high: 2 }, load: "none" }));
    expect(asked.status).toMatchObject({ state: "question", message: "Which gym are you at?" });
    expect(questionChoices(asked.status).map((c) => c.label)).toEqual(["Cult Koramangala", "Asha's gym"]);
    const chip = questionChoices(asked.status)[1]!;
    const saved = await book.answer("save", "log_set", chip.path, chip.value, calls[0]!);
    expect(saved?.status.state).toBe("saved");
    expect(calls[1]).toEqual({ ...calls[0], gym: "Asha's gym" });
    expect(x.t.get("SELECT gym_id FROM session WHERE member_id = ?", x.h.kabir)).toEqual({ gym_id: s.ashaGym });
  });
});

describe("\"Which cable?\" is answered with a chip (click test P1-6)", () => {
  it("the Save asks which cable with the gym's cables; the chip resends with load.implement under the same key", async () => {
    const x = setup();
    const s = seedTraining(x);
    const crossover = x.t.insert("implement", { gym_id: s.gym, name: "Cable crossover", kind: "cable", unit: "kg", loading: "total", load_list_complete: 1 });
    x.t.insert("implement_load", { implement_id: crossover, load: 40, unit: "kg" });
    const calls: Record<string, unknown>[] = [];
    const call = appCall(x, "hritvik");
    const book = writeBook(async (tool, input) => (calls.push(input), call(tool, input)), { status: () => {}, saved: () => {}, signedOut: () => {} });
    // A day with no programme session: nothing names the pulldown's cable, so the API asks.
    const asked = await book.run("save", setPlan({ member: "Hritvik", date: MONDAY, exercise: "lat pulldown", set_type: "working", reps: 10, rir: { low: 2, high: 2 }, load: { value: 40, unit: "kg", basis: "total" } }));
    expect(asked.status).toMatchObject({ state: "question", reason: "implement_needed" });
    const chips = questionChoices(asked.status);
    expect(chips.map((c) => c.label).sort()).toEqual(["Cable crossover", "Lat pulldown stack"]);
    const chip = chips.find((c) => c.label === "Cable crossover")!;
    const saved = await book.answer("save", "log_set", chip.path, chip.value, calls[0]!);
    expect(saved?.status.state).toBe("saved");
    expect(calls[1]).toEqual({ ...calls[0], load: { value: 40, unit: "kg", basis: "total", implement: "Cable crossover" } });
    expect(x.t.get("SELECT load_implement_id FROM session_set")).toEqual({ load_implement_id: crossover });
  });
});

describe("Progress's reading fixes against the real tools (click test P1-3)", () => {
  it("a 700 kg weight is corrected (the 700 asked about first, as a new one is), then a wrong waist removed; both leave the trends", async () => {
    const x = setup();
    const reading = (more: Record<string, unknown>) => ({ member: "Hritvik", date: MONDAY, body_state: "fasted", ...more });
    await x.ok("log_reading", reading({ date: "2026-10-01", metric: "weight", value: 70.2, unit: "kg" }), "hritvik");
    await x.ok("log_reading", reading({ metric: "weight", value: 700, unit: "kg", implausible_ok: true }), "hritvik");
    await x.ok("log_reading", reading({ metric: "waist_navel", value: 94, unit: "in", body_state: "not_recorded", implausible_ok: true }), "hritvik");
    const metrics = async () => (await x.ok("reading_metrics", { member: "Hritvik" }, "hritvik")) as unknown as ReadingMetrics;
    const rows = readingFixes(await metrics());
    expect(rows.map((r) => r.text)).toEqual(["Waist at navel: 94 in, Mon 5 Oct", "Body weight: 700 kg, fasted, Mon 5 Oct", "Body weight: 70.2 kg, fasted, Thu 1 Oct"]);

    // Edit 700 to 7000 by mistake: asked, nothing written; "Yes, it's right" would send it; the member types 70 instead.
    const weight = rows[1]!;
    const calls: Record<string, unknown>[] = [];
    const call = appCall(x, "hritvik");
    const book = writeBook(async (tool, input) => (calls.push(input), call(tool, input)), { status: () => {}, saved: () => {}, signedOut: () => {} });
    const plan = editReadingPlan(weight.edit, { value: "7000", unit: "kg", date: MONDAY }, MONDAY);
    if ("error" in plan) throw new Error(plan.error);
    const asked = await book.run("fix-edit:reading", plan);
    expect(asked.status).toMatchObject({ state: "question", reason: "implausible_reading" });
    expect(questionChoices(asked.status)).toEqual([{ label: "Yes, it's right", path: ["implausible_ok"], value: true }]);
    expect((await run(x, editReadingPlan(weight.edit, { value: "70", unit: "kg", date: MONDAY }, MONDAY))).status.state).toBe("saved");
    const trend = await x.ok("body_trends", { member: "Hritvik", metric: "weight" }, "hritvik");
    expect(trend.segments.flatMap((sg: { readings: { value: number }[] }) => sg.readings.map((r) => r.value))).toEqual([70.2, 70]);

    expect((await run(x, removeReadingPlan(rows[0]!.id))).status.state).toBe("saved");
    expect(readingFixes(await metrics()).map((r) => r.id)).not.toContain(rows[0]!.id);
    expect(x.t.get("SELECT id FROM reading WHERE id = ?", rows[0]!.id)).toBeUndefined();
  });
});

describe("own sets off the gym's list: said plainly, and confirmed on Train (click test P1-5)", () => {
  it("log_workout's answer names the drafts and why; Train's session offers Yes, confirm, which confirms them", async () => {
    const x = setup();
    seedTraining(x);
    const sets = [1, 2].map(() => ({ exercise: "db curl", reps: 10, rir: 2, load: { value: 11, unit: "kg", basis: "total" } }));
    const out = await run(x, { steps: [planStep("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets: [...sets, { exercise: "db curl", reps: 10, rir: 2, load: { value: 10, unit: "kg", basis: "total" } }] })], done: "Logged." });
    expect(out.status.state).toBe("saved");
    expect(loggedLines(out.results[0] as unknown as LogWorkout).slice(0, 2)).toEqual([
      "3 sets saved.",
      "2 of them went in as drafts, not confirmed: Dumbbell curl sets 1-2, because 11 kg isn't on the gym's list for the Dumbbells. Confirm them on Train if that is what you lifted.",
    ]);
    const list = (await x.ok("sessions", { member: "Hritvik", from: MONDAY, to: MONDAY }, "hritvik")) as unknown as SessionsList;
    const confirm = buildHistory(list, true)[0]!.sets.flatMap((st) => st.confirm ?? []);
    expect(confirm).toHaveLength(2);
    expect((await run(x, confirmPlan(confirm))).status.state).toBe("saved");
    expect(x.t.all("SELECT state FROM session_set ORDER BY id").map((r) => r.state)).toEqual(["confirmed", "confirmed", "confirmed"]);
  });
});

describe("\"Yes, it's right\" for an implausible reading, against the real tool (review round)", () => {
  it("answers only the entry that was asked about: after the form changes to 70, the chip sends nothing; unchanged, it logs 700", async () => {
    const x = setup();
    const call = appCall(x, "hritvik");
    const book = writeBook(call, { status: () => {}, saved: () => {}, signedOut: () => {} });
    const entry = { member: "Hritvik", date: MONDAY, metric: "weight", value: 700, unit: "kg", body_state: "fasted" };
    const asked = await book.run("save", { steps: [planStep("log_reading", entry)], done: "Logged." });
    expect(asked.status).toMatchObject({ state: "question", reason: "implausible_reading" });
    const chip = questionChoices(asked.status)[0]!;
    expect(chip).toEqual({ label: "Yes, it's right", path: ["implausible_ok"], value: true });
    expect(await book.answer("save", "log_reading", chip.path, chip.value, { ...entry, value: 70 })).toBeNull();
    expect(x.t.get("SELECT count(*) AS n FROM reading")).toEqual({ n: 0 });
    expect((await book.answer("save", "log_reading", chip.path, chip.value, entry))?.status.state).toBe("saved");
    expect(x.t.all("SELECT value FROM reading")).toEqual([{ value: 700 }]);
    expect(sameInput(entry, { ...entry })).toBe(true);
  });
});
