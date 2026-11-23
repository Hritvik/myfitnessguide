// One way to a record (Worker decision 125): amend, retract, history,
// confirm and reject find a record's owner and household through
// ownersOf/householdsOf, many records in one statement per table, with
// loadRecord's refusals in its order. Typed over STATE_TABLES, so a new
// state table fails here too until it has a draft. Invented data only.
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import { householdsOf, ownersOf, STATE_TABLES } from "../src/records";
import { checkRecord, OWNER_ONLY, type LoadedRecord } from "../src/tools/records";
import { seedGym, toolWithinBudget } from "./budget";
import { NOW } from "./db";
import { exercise, gym, reading, session, set, writeLog } from "./fixtures";
import { setup, type Harness } from "./harness";
import { seedCatalogue } from "./seed";

type StateTable = (typeof STATE_TABLES)[number];
const DAY = "2026-10-04";
const curd = { source: "food", food: "curd", value: 100, unit: "g", provenance: "weighed", confidence: "high" };
const pot = (portions: unknown[]) => ({ date: DAY, meal_slot: "lunch", cooks: [{ name: "Invented dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions }] });

/** A draft of every state table: about Asha where it has an owner, logged by someone else; household-level otherwise. */
const DRAFTS: Record<StateTable, (x: Harness) => Promise<{ id: number; owner: "asha" | null; change: Record<string, unknown> }>> = {
  session: async (x) => ({ id: session(x.t, x.h.asha, gym(x.t, x.h)), owner: "asha", change: { note: "invented" } }),
  session_set: async (x) => ({ id: set(x.t, session(x.t, x.h.asha, gym(x.t, x.h)), exercise(x.t, x.h)), owner: "asha", change: { note: "invented" } }),
  cook: async (x) => ({ id: x.t.insert("cook", { household_id: x.h.id, cooked_on: DAY, name: "Invented rajma", state: "draft" }), owner: null, change: { note: "invented" } }),
  household_meal: async (x) => ({ id: x.t.insert("household_meal", { household_id: x.h.id, eaten_on: DAY, meal_slot: "dinner", state: "draft" }), owner: null, change: { note: "invented" } }),
  portion: async (x) => {
    const meal = await x.ok("household_meal", pot([{ member: "Asha", fraction: 0.3, provenance: "estimated" }]), "hritvik");
    return { id: meal.cooks[0].portions[0].id, owner: "asha", change: { provenance: "weighed" } };
  },
  leftover_serving: async (x) => {
    const meal = await x.ok("household_meal", pot([{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }]), "hritvik");
    const component = meal.cooks[0].components[0].id;
    await x.ok("mark_remainder", { component_id: component, disposition: "leftover", provenance: "estimated", date: DAY }, "hritvik");
    const eaten = await x.ok("mark_remainder", { component_id: component, disposition: "eaten", member: "Asha", meal_slot: "dinner", fraction: 0.1, provenance: "estimated", date: DAY });
    return { id: eaten.serving.id, owner: "asha", change: { provenance: "weighed" } };
  },
  intake_item: async (x) => ({ id: (await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "lunch", items: [curd] })).items[0].id, owner: "asha", change: { note: "invented" } }),
  reading: async (x) => ({ id: (await x.ok("log_reading", { member: "Asha", date: DAY, metric: "weight", value: 61.2, unit: "kg", body_state: "fasted" })).reading.id, owner: "asha", change: { note: "invented" } }),
  blood_draw: async (x) => ({ id: (await x.ok("log_blood_draw", { member: "Asha", date: DAY, lab: "Orange", results: [{ marker: "Ferritin", value: 20, unit: "ng/mL" }] })).draw.id, owner: "asha", change: { note: "invented" } }),
};

describe.each(STATE_TABLES.map((t) => [t]))("who a %s draft is about", (table) => {
  it("is the same member for the drafts list, confirm and amend", async () => {
    const x = setup();
    await seedCatalogue(x);
    const d = await DRAFTS[table](x);
    const ref = { table, id: d.id };
    // The drafts list (DRAFT_SOURCES) lists it for its member, and never a household-level one.
    const hers = (await x.ok("household_overview", {}, "asha")).waiting_on_you.drafts.map((w: { table: string; id: number }) => `${w.table}:${w.id}`);
    expect(hers.includes(`${table}:${d.id}`)).toBe(d.owner === "asha");
    // confirm: only its member decides it (and an owner-only kind isn't even visible to another); anyone confirms a household-level draft.
    const his = await x.call("confirm", { records: [ref] }, "hritvik");
    if (d.owner === null) expect(his.http).toBe(200);
    else expect(his.body.error.code).toBe(table in OWNER_ONLY ? "not_visible" : "not_yours_to_decide");
    // amend writes on behalf of that same member.
    expect((await x.call("amend", { record: ref, changes: d.change, reason: "invented" }, "asha")).http).toBe(200);
    expect(x.t.get("SELECT on_behalf_of_member_id AS o FROM write_log ORDER BY id DESC LIMIT 1")).toEqual({ o: d.owner === null ? null : x.h.asha });
  });
});

describe("loadRecord's refusals, for every tool that loads records", () => {
  it("keeps amend's, retract's and history's: not_visible for another member's owner-only record, not_yours_to_retract for another's entry, not_found for another household's or a missing catalogue record", async () => {
    const x = setup();
    await seedCatalogue(x);
    const reading = (await x.ok("log_reading", { member: "Asha", date: DAY, metric: "weight", value: 61.2, unit: "kg", body_state: "fasted" })).reading;
    const item = (await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "lunch", items: [curd] })).items[0];
    const err = async (tool: string, input: Record<string, unknown>) => {
      const r = await x.call(tool, input, "hritvik");
      return [r.http, r.body.error.code];
    };
    expect(await err("amend", { record: { table: "reading", id: reading.id }, changes: { note: "x" }, reason: "x" })).toEqual([403, "not_visible"]);
    expect(await err("history", { table: "reading", id: reading.id })).toEqual([403, "not_visible"]);
    expect(await err("retract", { records: [{ table: "intake_item", id: item.id }], reason: "x" })).toEqual([403, "not_yours_to_retract"]);
    const other = x.t.insert("household", { name: "Invented elsewhere", created_at: NOW });
    const theirs = x.t.insert("food_source", { household_id: other, ref: "FS9998", name: "Invented food", state: "as_sold", reference_amount: 100, reference_unit: "g", kcal: 1, protein_g: 0, carbs_g: 0, fat_g: 0 });
    expect(await err("amend", { record: { table: "food_source", id: theirs }, changes: { tags: "x" }, reason: "x" })).toEqual([404, "not_found"]);
    expect(await err("amend", { record: { table: "food_source", id: 999_999 }, changes: { tags: "x" }, reason: "x" })).toEqual([404, "not_found"]);
  });

  it("refuses another household's records as not_found, for a member and for the agent: a set and a lab result (owner through a parent) and a reading (own member_id)", async () => {
    const x = setup();
    await seedCatalogue(x);
    // A second household with its own member: the shortcut (an owner among this household's members) must not take them in.
    const other = x.t.insert("household", { name: "Invented elsewhere", created_at: NOW });
    const stranger = x.t.insert("member", { household_id: other, name: "Invented member", email: "invented.member@example.com", programming_mode: "prescribed", created_at: NOW });
    const theirSet = set(x.t, session(x.t, stranger, x.t.insert("gym", { household_id: other, name: "Invented gym elsewhere" })), exercise(x.t, x.h));
    const draw = x.t.insert("blood_draw", { member_id: stranger, drawn_on: DAY, lab: "Invented lab", state: "draft" });
    const theirResult = x.t.insert("lab_result", { draw_id: draw, marker: "Ferritin", value: 20, unit: "ng/mL" });
    const theirReading = reading(x.t, stranger);
    const refs = [
      { table: "session_set", id: theirSet },
      { table: "lab_result", id: theirResult },
      { table: "reading", id: theirReading },
    ];
    // Each has a history, so history reaches the household check rather than stopping at "no versions".
    const w = writeLog(x.t);
    for (const r of refs) {
      x.t.insert("record_version", { write_id: w, table_name: r.table, record_id: r.id, version: 1, action: "create", data: JSON.stringify(x.t.get(`SELECT * FROM ${r.table} WHERE id = ?`, r.id)), created_at: NOW });
    }
    for (const as of ["hritvik", "agent"] as const) {
      const err = async (tool: string, input: Record<string, unknown>) => {
        const r = await x.call(tool, input, as);
        return [tool, r.http, r.body.error?.code];
      };
      for (const ref of refs) {
        expect(await err("amend", { record: ref, changes: { note: "invented" }, reason: "invented" })).toEqual(["amend", 404, "not_found"]);
        expect(await err("history", ref)).toEqual(["history", 404, "not_found"]);
        // lab_result has no draft state and can't be retracted: those tools refuse it by its table before they load it.
        const stateful = ref.table !== "lab_result";
        expect(await err("retract", { records: [ref], reason: "invented" })).toEqual(stateful ? ["retract", 404, "not_found"] : ["retract", 400, "not_retractable"]);
        expect(await err("confirm", { records: [ref] })).toEqual(stateful ? ["confirm", 404, "not_found"] : ["confirm", 400, "no_state"]);
        expect(await err("reject", { records: [ref], reason: "invented" })).toEqual(stateful ? ["reject", 404, "not_found"] : ["reject", 400, "no_state"]);
      }
    }
  });

  it("keeps confirm's, in the records' order: no_state, not_found, not_visible, not_yours_to_decide and not_draft with their index, then rir_needed", async () => {
    const x = setup();
    await seedCatalogue(x);
    const item = (await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "lunch", items: [curd] })).items[0];
    const reading = (await x.ok("log_reading", { member: "Asha", date: DAY, metric: "weight", value: 61.2, unit: "kg", body_state: "fasted" })).reading;
    const mine = (await x.ok("log_intake", { speaker: "Asha", member: "Hritvik", date: DAY, meal_slot: "lunch", items: [curd, curd] })).items;
    const code = async (records: { table: string; id: number }[], as: "hritvik" | "asha") => {
      const r = await x.call("confirm", { records }, as);
      return [r.http, r.body.error?.code ?? r.body.reason, r.body.error?.index ?? null];
    };
    expect(await code([{ table: "food_source", id: 1 }], "asha")).toEqual([400, "no_state", null]);
    expect(await code([{ table: "intake_item", id: 999_999 }], "asha")).toEqual([404, "not_found", null]);
    expect(await code([{ table: "reading", id: reading.id }], "hritvik")).toEqual([403, "not_visible", null]);
    expect(await code([{ table: "intake_item", id: 999_999 }, { table: "intake_item", id: item.id }], "hritvik")).toEqual([404, "not_found", null]);
    expect(await code([{ table: "intake_item", id: mine[0].id }, { table: "intake_item", id: item.id }], "hritvik")).toEqual([403, "not_yours_to_decide", 1]);
    await x.ok("confirm", { records: [{ table: "intake_item", id: mine[1].id }] }, "hritvik");
    expect(await code([{ table: "intake_item", id: mine[0].id }, { table: "intake_item", id: mine[1].id }], "hritvik")).toEqual([409, "not_draft", 1]);
    expect(x.t.get("SELECT state FROM intake_item WHERE id = ?", mine[0].id)).toEqual({ state: "draft" });
    // A prescribed member's draft set with no RIR asks, naming the set.
    const blank = set(x.t, session(x.t, x.h.hritvik, gym(x.t, x.h), { performed_on: "2026-10-03" }), exercise(x.t, x.h));
    const asked = await x.call("confirm", { records: [{ table: "session_set", id: blank }] }, "hritvik");
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "rir_needed", options: [blank] });
  });
});

describe("the cost of a record's owner", () => {
  it("reads a set's owner once on amend, within the budget", async () => {
    const x = setup();
    seedGym(x, 40);
    const s = set(x.t, session(x.t, x.h.hritvik, gym(x.t, x.h)), exercise(x.t, x.h));
    const run = await toolWithinBudget(x, "amend", { record: { table: "session_set", id: s }, changes: { note: "invented" }, reason: "invented" }, "hritvik");
    expect(run.log.filter((l) => /FROM session WHERE id/.test(l))).toHaveLength(1);
  });
});

describe("a table name that is an Object property", () => {
  it("has no owner or household path and reads nothing", async () => {
    const db = { prepare: () => { throw new Error("no statement expected"); } } as unknown as Db;
    const row = { undefined: 1 };
    expect([await ownersOf(db, "constructor", [row]), await householdsOf(db, "constructor", [row], [null])]).toEqual([[null], [null]]);
  });

  it("is not amendable (400, not a TypeError) and is no owner-only kind", async () => {
    const reply = await setup().call("amend", { record: { table: "constructor", id: 1 }, changes: { name: "x" }, reason: "invented" });
    expect([reply.http, reply.body.error.code]).toEqual([400, "not_amendable"]);
    const r = { table: "constructor", id: 1, row: { id: 1 }, owner: null, household: null } as unknown as LoadedRecord;
    expect(() => checkRecord({ householdId: 1 } as unknown as Parameters<typeof checkRecord>[0], r)).not.toThrow();
  });
});
