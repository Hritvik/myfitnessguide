// Ticket 78: the MCP server's unattended mode stamps every write origin
// `inbox`, sends no speaker, and leaves the model only log_intake,
// household_meal and resolve_inbox_entry, one data write per entry under
// the key `inbox:inbox-<id>-write` (MCP decision 21). Each data write must
// only create rows: every stateful one a draft, every stateless one a child
// of a draft made in the same write, and no row that existed before touched.
import { describe, expect, it } from "vitest";
import { STATE_TABLES } from "../src/records";
import { setup } from "./harness";
import { MONDAY } from "./input-seed";
import { seedCatalogue } from "./seed";

async function ready() {
  const x = setup();
  await seedCatalogue(x);
  // Confirmed household data the run must not touch: the speaker's own live food, a confirmed
  // household meal on the same day and slot, and a recipe a cook can name.
  await x.ok("upsert_recipe", { name: "Synthetic dal", kind: "dish", servings: 2, lines: [{ food: "peas", value: 400, unit: "g" }] });
  await x.ok("log_intake", { member: "Hritvik", date: MONDAY, meal_slot: "dinner", items: [food("FS002", 80)] });
  await x.ok("household_meal", {
    date: MONDAY, meal_slot: "dinner",
    cooks: [{ name: "Synthetic dal", recipe: "Synthetic dal", portions: [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }] }],
  });
  return x;
}

type X = Awaited<ReturnType<typeof ready>>;

const inbox = { origin: "inbox" } as const;
function food(f: string, value: number) {
  return { source: "food", food: f, value, unit: "g", provenance: "estimated", confidence: "medium", label: "Snack from the Inbox" };
}

/** Tables whose rows are the household's records (not the logs the write itself appends to). */
const LOGS = new Set(["write_log", "record_version", "idempotency_key", "sqlite_sequence", "route_stat", "d1_migrations", "_cf_KV"]);

/** Every record row, by table and id: what existed before a write. */
function snapshot(x: X): Map<string, string> {
  const tables = (x.t.all("SELECT name FROM sqlite_master WHERE type = 'table'") as { name: string }[]).map((r) => r.name).filter((n) => !LOGS.has(n));
  const rows = new Map<string, string>();
  for (const t of tables) {
    for (const [i, r] of (x.t.all(`SELECT * FROM "${t}"`) as Record<string, unknown>[]).entries()) {
      rows.set(`${t}:${String(r.id ?? `#${i}:${JSON.stringify(r)}`)}`, JSON.stringify(r));
    }
  }
  return rows;
}

/**
 * The write is an Inbox write with nobody spoken with; every version it
 * made is a create; every stateful row it made is a draft; and every row
 * that existed before is unchanged. Returns the tables it created rows in.
 */
async function expectOnlyNewDrafts(x: X, run: () => Promise<{ write_id: number }>): Promise<string[]> {
  const before = snapshot(x);
  const body = await run();
  expect(x.t.get("SELECT origin, speaker_member_id FROM write_log WHERE id = ?", body.write_id)).toEqual({ origin: "inbox", speaker_member_id: null });
  const versions = x.t.all(
    "SELECT table_name AS \"table\", record_id AS id, action, json_extract(data, '$.state') AS state FROM record_version WHERE write_id = ?",
    body.write_id,
  ) as { table: string; id: number; action: string; state: string | null }[];
  expect(versions.filter((v) => v.action !== "create")).toEqual([]);
  expect(versions.filter((v) => before.has(`${v.table}:${v.id}`))).toEqual([]);
  const stateful = versions.filter((v) => (STATE_TABLES as readonly string[]).includes(v.table));
  expect(stateful.length).toBeGreaterThan(0);
  expect(stateful.filter((v) => v.state !== "draft")).toEqual([]);
  const after = snapshot(x);
  for (const [k, v] of before) expect(after.get(k), k).toBe(v);
  return [...new Set(versions.map((v) => v.table))].sort();
}

async function entry(x: X, text = "synthetic snack words") {
  const sent = await x.ok("submit_to_inbox", { member: "Hritvik", date: MONDAY, text, spans: [{ text: text.slice(10), start: 10, end: text.length }] }, "hritvik");
  return sent.entry.id as number;
}

describe("the unattended run's data writes (origin inbox, no speaker)", () => {
  it("log_intake creates only draft items, even for the entry's own member, and touches nothing that existed", async () => {
    const x = await ready();
    const tables = await expectOnlyNewDrafts(x, () =>
      x.ok("log_intake", { ...inbox, member: "Hritvik", date: MONDAY, meal_slot: "snack", items: [food("FS002", 100), food("curd", 50)] }),
    );
    expect(tables).toEqual(["intake_item"]);
  });

  it("household_meal creates a draft meal, cooks and portions with their components and lines, and direct draft items, touching nothing that existed", async () => {
    const x = await ready();
    const tables = await expectOnlyNewDrafts(x, () =>
      x.ok("household_meal", {
        ...inbox, date: MONDAY, meal_slot: "dinner",
        cooks: [
          { name: "Synthetic dal", recipe: "Synthetic dal", portions: [{ member: "Hritvik", fraction: 0.25, provenance: "estimated" }] },
          { name: "Synthetic peas", lines: [{ food: "peas", value: 300, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.5, provenance: "estimated" }] },
        ],
        items: [{ ...food("curd", 40), member: "Asha" }],
      }),
    );
    // component and cook_line are stateless children of the draft cook made in the same write.
    expect(tables).toEqual(["component", "cook", "cook_line", "household_meal", "intake_item", "portion"]);
  });
});

describe("one data write per entry, under the entry's key", () => {
  const key = (id: number, part: "write" | "close") => `inbox:inbox-${id}-${part}`;

  it("a rerun after a crash replays the entry's write and drafts nothing twice", async () => {
    const x = await ready();
    const id = await entry(x);
    const write = () => ({ ...inbox, idempotency_key: key(id, "write"), member: "Hritvik", date: MONDAY, meal_slot: "snack", items: [food("FS002", 100)] });
    const count = () => [x.t.get("SELECT count(*) AS n FROM intake_item"), x.t.get("SELECT count(*) AS n FROM write_log")];

    const first = await x.ok("log_intake", write()); // the run dies before closing the entry
    const before = count();
    const again = await x.ok("log_intake", write()); // the next run: same entry, same key
    expect(again.write_id).toBe(first.write_id);
    expect(count()).toEqual(before);
  });

  it("refuses a second, different data write for the same entry, by either tool, and writes nothing", async () => {
    const x = await ready();
    const id = await entry(x);
    await x.ok("log_intake", { ...inbox, idempotency_key: key(id, "write"), member: "Hritvik", date: MONDAY, meal_slot: "snack", items: [food("FS002", 100)] });
    const before = snapshot(x);
    const logs = x.t.get("SELECT count(*) AS n FROM write_log");

    const more = await x.call("log_intake", { ...inbox, idempotency_key: key(id, "write"), member: "Hritvik", date: MONDAY, meal_slot: "snack", items: [food("curd", 50)] });
    const meal = await x.call("household_meal", {
      ...inbox, idempotency_key: key(id, "write"), date: MONDAY, meal_slot: "snack",
      cooks: [{ name: "Synthetic peas", lines: [{ food: "peas", value: 300, unit: "g", provenance: "weighed" }], portions: [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }] }],
    });
    for (const r of [more, meal]) expect([r.http, r.body.error?.code]).toEqual([409, "idempotency_key_reused"]);
    expect(snapshot(x)).toEqual(before);
    expect(x.t.get("SELECT count(*) AS n FROM write_log")).toEqual(logs);
  });

  it("a write that asks a question writes nothing and leaves the key unused for the next run", async () => {
    const x = await ready();
    const id = await entry(x);
    const before = snapshot(x);
    // Rice with no state: the API asks dry or cooked.
    const asked = await x.call("log_intake", {
      ...inbox, idempotency_key: key(id, "write"), member: "Hritvik", date: MONDAY, meal_slot: "snack",
      items: [{ source: "food", food: "rice", value: 100, unit: "g", provenance: "estimated", confidence: "medium" }],
    });
    expect(asked.body.status).toBe("needs_clarification");
    expect(snapshot(x)).toEqual(before);
    expect(x.t.get("SELECT count(*) AS n FROM idempotency_key WHERE key = ?", key(id, "write"))).toEqual({ n: 0 });
  });

  it("resolve_inbox_entry closes the entry with the drafted records, logged on the member's behalf, and replays on a rerun", async () => {
    const x = await ready();
    const id = await entry(x);
    const logged = await x.ok("log_intake", { ...inbox, idempotency_key: key(id, "write"), member: "Hritvik", date: MONDAY, meal_slot: "snack", items: [food("FS002", 100)] });
    const close = {
      ...inbox, idempotency_key: key(id, "close"), id, status: "resolved", note: "drafted by the scheduled run: 100 g as a snack draft",
      records: [{ table: "intake_item", id: logged.items[0].id }], reason: "drafted by the scheduled run",
    };
    const closed = await x.ok("resolve_inbox_entry", close);
    expect(closed.entry).toMatchObject({ status: "resolved" });
    expect(x.t.get("SELECT origin, speaker_member_id, on_behalf_of_member_id FROM write_log WHERE id = ?", closed.write_id)).toEqual({
      origin: "inbox", speaker_member_id: null, on_behalf_of_member_id: x.h.hritvik,
    });
    expect((await x.ok("resolve_inbox_entry", close)).write_id).toBe(closed.write_id);
  });
});
