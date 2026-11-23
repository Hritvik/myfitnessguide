
// confirm, set-based (spec 2026-10-07 §4): many drafts in one write, in a
// constant number of statements, with the same rows, states, versions and
// answer as the one-record-at-a-time confirm it replaces (its refusals are
// pinned in record-access.tools.test.ts). And one JSON statement for every
// batch of versions. The regression tests pass on HEAD too; the budget and
// version-writer cases fail there. Invented data only.
import { describe, expect, it } from "vitest";
import { seedGym, toolWithinBudget } from "./budget";
import type { Db } from "../src/db";
import { chunkJson, VERSION_JSON_BYTES, WriteTx } from "../src/write";
import { exercise, gym, reading, session, set } from "./fixtures";
import { setup, type Harness } from "./harness";
import { seedCatalogue } from "./seed";

type Ref = { table: string; id: number };
type Row = Record<string, unknown>;
const NOW = "2026-10-05T07:30:00Z";

/**
 * 50 drafts about Asha, logged by others: 12 food items, 10 portions
 * (each with its draft item), 3 leftover servings (each with its draft
 * item), 2 sessions with 5 sets each (RIR blank: Asha records only),
 * 10 readings and 3 blood draws.
 */
async function mixed(x: Harness): Promise<Ref[]> {
  await seedCatalogue(x);
  const out: Ref[] = [];
  const food = await x.ok("log_intake", {
    member: "Asha", date: "2026-10-04", meal_slot: "lunch",
    items: Array.from({ length: 12 }, (_, i) => ({ source: "food", food: "curd", value: 50 + i, unit: "g", provenance: "weighed", confidence: "high" })),
  });
  for (const item of food.items) out.push({ table: "intake_item", id: item.id });
  const components: number[] = [];
  for (let d = 1; d <= 10; d++) {
    const meal = await x.ok("household_meal", {
      date: `2026-09-${10 + d}`, meal_slot: "dinner",
      cooks: [{ name: `Invented dal ${d}`, lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.3, provenance: "estimated" }] }],
    }, "hritvik");
    out.push({ table: "portion", id: meal.cooks[0].portions.find((p: { member: string }) => p.member === "Asha").id });
    components.push(meal.cooks[0].components[0].id);
  }
  for (const c of components.slice(0, 3)) {
    await x.ok("mark_remainder", { component_id: c, disposition: "leftover", provenance: "estimated", date: "2026-09-20" }, "hritvik");
    const eaten = await x.ok("mark_remainder", { component_id: c, disposition: "eaten", member: "Asha", meal_slot: "snack", fraction: 0.1, provenance: "estimated", date: "2026-10-01" });
    out.push({ table: "leftover_serving", id: eaten.serving.id });
  }
  const ex = exercise(x.t, x.h);
  const g = gym(x.t, x.h);
  for (const day of ["2026-10-01", "2026-10-02"]) {
    const se = session(x.t, x.h.asha, g, { performed_on: day });
    out.push({ table: "session", id: se });
    for (let i = 0; i < 5; i++) out.push({ table: "session_set", id: set(x.t, se, ex) });
  }
  for (let d = 1; d <= 10; d++) {
    out.push({ table: "reading", id: (await x.ok("log_reading", { member: "Asha", date: `2026-09-${10 + d}`, metric: "weight", value: 61 + d / 10, unit: "kg", body_state: "fasted" })).reading.id });
  }
  for (const month of ["06", "07", "08"]) {
    out.push({ table: "blood_draw", id: (await x.ok("log_blood_draw", { member: "Asha", date: `2026-${month}-01`, lab: "Orange", results: [{ marker: "Ferritin", value: 20, unit: "ng/mL" }] })).draw.id });
  }
  return out;
}

const rowOf = (x: Harness, r: Ref) => x.t.get(`SELECT * FROM ${r.table} WHERE id = ?`, r.id) as Row;

/** A record's draft partner, as confirm has always taken it: a share's item, an item's portion (else its serving). */
function partnerOf(x: Harness, r: Ref): Ref | null {
  const draft = (ref: Ref | null) => (ref && rowOf(x, ref)?.state === "draft" ? ref : null);
  if (r.table === "portion" || r.table === "leftover_serving") {
    const item = x.t.get(`SELECT id FROM intake_item WHERE ${r.table === "portion" ? "portion_id" : "leftover_serving_id"} = ?`, r.id) as { id: number } | undefined;
    return draft(item ? { table: "intake_item", id: item.id } : null);
  }
  if (r.table === "intake_item") {
    const row = rowOf(x, r);
    if (row.portion_id !== null) return draft({ table: "portion", id: row.portion_id as number });
    if (row.leftover_serving_id !== null) return draft({ table: "leftover_serving", id: row.leftover_serving_id as number });
  }
  return null;
}

/** confirm's answer as it has always been: each named record, then its draft partner, each once. */
function expectedOrder(x: Harness, named: Ref[]): Ref[] {
  const out: Ref[] = [];
  const seen = new Set<string>();
  const take = (r: Ref | null) => {
    if (r && !seen.has(`${r.table}:${r.id}`)) {
      seen.add(`${r.table}:${r.id}`);
      out.push(r);
    }
  };
  for (const r of named) {
    take(r);
    take(partnerOf(x, r));
  }
  return out;
}

const lastVersion = (x: Harness, r: Ref) =>
  x.t.get("SELECT version, action, data, write_id FROM record_version WHERE table_name = ? AND record_id = ? ORDER BY version DESC LIMIT 1", r.table, r.id) as
    | { version: number; action: string; data: string; write_id: number }
    | undefined;

describe("confirm, set-based", () => {
  it("confirms a mixed batch exactly as before: the answer, every row's state and every version", async () => {
    const x = setup();
    const named = await mixed(x);
    const expected = expectedOrder(x, named);
    const before = new Map(expected.map((r) => [`${r.table}:${r.id}`, { row: rowOf(x, r), version: lastVersion(x, r)?.version ?? 0 }]));
    const body = await x.ok("confirm", { records: named }, "asha");
    expect(body.confirmed).toEqual(expected);
    const writes = new Set<number>();
    for (const r of expected) {
      const { row, version } = before.get(`${r.table}:${r.id}`) as { row: Row; version: number };
      const after = { ...row, state: "confirmed", confirmed_at: NOW, ...(r.table === "session_set" && row.rir_status === null ? { rir_status: "not_recorded" } : {}) };
      expect(rowOf(x, r), `${r.table} ${r.id}`).toEqual(after);
      const v = lastVersion(x, r);
      expect(v, `${r.table} ${r.id}`).toMatchObject({ version: version + 1, action: "confirm" });
      expect(JSON.parse(v?.data as string)).toEqual(after);
      writes.add(v?.write_id as number);
    }
    // One write, and nothing else confirmed by it.
    expect(writes.size).toBe(1);
    expect(x.t.get("SELECT count(*) AS n FROM record_version WHERE write_id = ? AND action = 'confirm'", [...writes][0])).toEqual({ n: expected.length });
  });

  it("confirms a portion named with its own item, or named twice, once each with one version each", async () => {
    const x = setup();
    const named = await mixed(x);
    const portion = named.find((r) => r.table === "portion") as Ref;
    const item = partnerOf(x, portion) as Ref;
    const body = await x.ok("confirm", { records: [portion, item, portion] }, "asha");
    expect(body.confirmed).toEqual([portion, item]);
    for (const r of [portion, item]) {
      expect(x.t.get("SELECT count(*) AS n FROM record_version WHERE table_name = ? AND record_id = ? AND action = 'confirm'", r.table, r.id)).toEqual({ n: 1 });
    }
  });

  it("refuses the whole batch with not_draft and the settled record's index, writing nothing", async () => {
    const x = setup();
    const named = await mixed(x);
    const [a, b, c] = named.filter((r) => r.table === "reading") as [Ref, Ref, Ref];
    await x.ok("confirm", { records: [b] }, "asha");
    const reply = await x.call("confirm", { records: [a, b, c] }, "asha");
    expect([reply.http, reply.body.error.code, reply.body.error.index]).toEqual([409, "not_draft", 1]);
    expect([rowOf(x, a).state, rowOf(x, c).state]).toEqual(["draft", "draft"]);
    expect(lastVersion(x, a)?.action).toBe("create");
  });

  it("stays within the budget: 50 mixed records, and the same count for 13 of them", async () => {
    const x = setup();
    const named = await mixed(x);
    const all = await toolWithinBudget(x, "confirm", { records: named }, "asha");
    expect(all.body.confirmed).toHaveLength(63);
    const y = setup();
    const few = await mixed(y);
    const some = [0, 12, 22, 25, 27, 28, 33, 38, 47, 48, 13, 14, 1].map((i) => few[i] as Ref);
    const run = await toolWithinBudget(y, "confirm", { records: some }, "asha");
    // Every state table the 50 name, in 13 records: the cost is per table, never per record.
    expect(new Set(some.map((r) => r.table)).size).toBe(new Set(named.map((r) => r.table)).size);
    expect(run.statements).toBe(all.statements);
  });
});

describe("one statement for a batch of versions", () => {
  it("versions a 40-result draft draw's results in one statement when it is rejected, as reject's versions() now writes", async () => {
    const x = setup();
    seedGym(x, 40);
    const draw = x.t.insert("blood_draw", { member_id: x.h.asha, drawn_on: "2026-10-01", lab: "Orange", state: "draft" });
    for (let i = 1; i <= 40; i++) x.t.insert("lab_result", { draw_id: draw, marker: `Invented marker ${i}`, value: i, unit: "mg/dL" });
    const run = await toolWithinBudget(x, "reject", { records: [{ table: "blood_draw", id: draw }], reason: "Rejected in the app: not my blood draw" }, "asha");
    // The results' versions in one statement (it was three, 16 a statement), the draw's own in one.
    expect(run.log.filter((l) => l.startsWith("INSERT INTO record_version"))).toHaveLength(2);
    const first = x.t.get("SELECT data FROM record_version WHERE table_name = 'lab_result' AND action = 'reject' ORDER BY record_id LIMIT 1") as { data: string };
    expect(JSON.parse(first.data)).toMatchObject({ draw_id: draw, marker: "Invented marker 1", value: 1, unit: "mg/dL" });
    expect(x.t.get("SELECT count(*) AS n FROM record_version WHERE table_name = 'lab_result' AND action = 'reject'")).toEqual({ n: 40 });
  });
});

describe("the bounds of a batch", () => {
  it("refuses more than 200 records to confirm or reject with a plain 400", async () => {
    const x = setup();
    const records = Array.from({ length: 201 }, (_, i) => ({ table: "reading", id: i + 1 }));
    const confirm = await x.call("confirm", { records }, "asha");
    const reject = await x.call("reject", { records, reason: "invented" }, "asha");
    expect([confirm.http, confirm.body.status, reject.http, reject.body.status]).toEqual([400, "invalid", 400, "invalid"]);
  });

  it("splits a batch whose JSON passes 1.5 MB (100 readings with 20 KB notes) and versions every record", async () => {
    const x = setup();
    const ids = Array.from({ length: 100 }, (_, i) => reading(x.t, x.h.asha, { measured_on: `2026-07-${String((i % 28) + 1).padStart(2, "0")}`, value: 60 + i / 100, note: `Invented note ${i} ${"é".repeat(10_000)}` }));
    const run = await toolWithinBudget(x, "confirm", { records: ids.map((id) => ({ table: "reading", id })) }, "asha");
    expect(run.log.filter((l) => l.startsWith("INSERT INTO record_version"))).toHaveLength(2);
    expect(run.body.confirmed).toHaveLength(100);
    for (const id of ids) {
      const row = rowOf(x, { table: "reading", id });
      expect(row.state).toBe("confirmed");
      const v = lastVersion(x, { table: "reading", id });
      expect(v).toMatchObject({ version: 1, action: "confirm" });
      expect(JSON.parse(v?.data as string)).toEqual(row);
    }
  });

  it("keeps every chunk's UTF-8 under the cap, and a small batch in one", () => {
    const entries = Array.from({ length: 40 }, (_, i) => JSON.stringify({ t: "reading", id: i, data: "é".repeat(1000) }));
    const chunks = chunkJson(entries, 10_000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(new TextEncoder().encode(c).length).toBeLessThanOrEqual(10_000);
    expect(chunks.flatMap((c) => JSON.parse(c) as unknown[])).toEqual(entries.map((e) => JSON.parse(e)));
    expect(chunkJson(entries.slice(0, 2), VERSION_JSON_BYTES)).toHaveLength(1);
  });

  it("refuses a record named twice in one versionsAcross call, with a clear error", () => {
    const tx = new WriteTx({} as Db, 1, NOW);
    const r = { table: "reading", id: 7, data: { id: 7 } };
    expect(() => tx.versionsAcross("confirm", [r, { table: "session", id: 7, data: { id: 7 } }, r])).toThrow("reading 7 is named twice in one versionsAcross call");
  });
});
