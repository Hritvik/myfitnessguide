import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { OWNER_ONLY, OWNER_TEXT } from "@myfitnessguide/worker/owner-only";
import { describe, expect, it } from "vitest";
import { CANARIES, canariesMissing, canariesOf, EXTRA_FIELDS, HOUSEHOLD_TEXT, KABIR_FIELDS, needle, NOOR_SKIPS, NUMBERS, numbersNotOnce, SENTENCE, SYLLABLE, TEXT_FIELDS, UNCANARIED, type TextCanary } from "../scripts/canaries";
import { stressHousehold } from "./fixtures";

const key = (c: { table: string; field: string }) => `${c.table}.${c.field}`;
const texts = CANARIES.filter((c): c is TextCanary => c.kind === "text");
const fields = TEXT_FIELDS.map(([t, f]) => `${t}.${f}`);

/** The Worker's schema: every migration applied to an empty in-memory database, as the Worker's own tests do. */
function migrated(): DatabaseSync {
  const dir = new URL("../../worker/migrations/", import.meta.url);
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  return db;
}

/** The text columns of a table (SQLite's TEXT affinity, or no declared type). */
function textColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[]).filter((c) => /TEXT/i.test(c.type) || c.type === "").map((c) => `${table}.${c.name}`);
}

describe("the Private shape's canaries (e2e spec §3)", () => {
  it("every OWNER_ONLY table has a text canary (a number canary doesn't count)", () => {
    const tables = new Set(texts.map((c) => c.table));
    expect(Object.keys(OWNER_ONLY).filter((t) => !tables.has(t))).toEqual([]);
  });

  it("every OWNER_TEXT field has its own text canary", () => {
    const have = new Set(texts.map(key));
    const owed = Object.entries(OWNER_TEXT).flatMap(([t, fs]) => fs.map((f) => `${t}.${f}`));
    expect(owed.filter((f) => !have.has(f))).toEqual([]);
  });

  it("every text column of an OWNER_ONLY table has a canary or is listed, with its reason, in UNCANARIED", () => {
    const db = migrated();
    const columns = Object.keys(OWNER_ONLY).flatMap((t) => textColumns(db, t));
    expect(columns.length).toBeGreaterThan(Object.keys(OWNER_ONLY).length);
    expect(columns.filter((c) => !fields.includes(c) && !(c in UNCANARIED))).toEqual([]);
    // No stale entry: each one is a real column, and none also has a canary.
    expect(Object.keys(UNCANARIED).filter((c) => !columns.includes(c) || fields.includes(c))).toEqual([]);
    for (const reason of Object.values(UNCANARIED)) expect(reason.length).toBeGreaterThan(0);
  });

  it("every canaried field is a real text column", () => {
    const db = migrated();
    const tables = new Set(TEXT_FIELDS.map(([t]) => t));
    const columns = [...tables].flatMap((t) => textColumns(db, t));
    expect(fields.filter((f) => !columns.includes(f))).toEqual([]);
  });

  it("each field has its own syllable and sentence, keyed by field, and no others", () => {
    expect(Object.keys(SYLLABLE).sort()).toEqual([...fields].sort());
    expect(Object.keys(SENTENCE).sort()).toEqual([...fields].sort());
  });

  it("canariesMissing names each text canary not stored in its own field of a row its member owns", () => {
    const db = migrated();
    expect(canariesMissing(db)).toHaveLength(texts.length);
    db.exec(`INSERT INTO household (id, name, created_at) VALUES (1, 'H', '2026-01-01T00:00:00Z');
      INSERT INTO member (id, household_id, name, email, programming_mode, created_at) VALUES
        (1, 1, 'Asha', 'asha@example.com', 'prescribed', '2026-01-01T00:00:00Z'), (2, 1, 'Kabir', 'kabir@example.com', 'record_only', '2026-01-01T00:00:00Z');`);
    const asha = texts.find((c) => c.member === "Asha" && key(c) === "feedback.text")!;
    const insert = (member: number, text: string) =>
      db.prepare(`INSERT INTO feedback (member_id, type, text, context, created_at) VALUES (?, 'idea', ?, '{"route":"/"}', '2026-01-01T00:00:00Z')`).run(member, text);
    insert(2, asha.text); // in the right field, but Kabir's row
    expect(canariesMissing(db)).toContain(`Asha feedback.text ${asha.word}`);
    insert(1, asha.text);
    expect(canariesMissing(db)).not.toContain(`Asha feedback.text ${asha.word}`);
    expect(canariesMissing(db)).toHaveLength(texts.length - 1);
  });

  it("the only text beyond OWNER_ONLY and OWNER_TEXT is the write reason, the Inbox text and training's household text (Worker decisions 137, 157, 167)", () => {
    const listed = (t: string, f: string) => t in OWNER_ONLY || (OWNER_TEXT[t] ?? []).includes(f) || HOUSEHOLD_TEXT.has(`${t}.${f}`);
    expect(TEXT_FIELDS.filter(([t, f]) => !listed(t, f)).map(([t, f]) => `${t}.${f}`)).toEqual([...EXTRA_FIELDS]);
    expect(canariesOf("Kabir").filter((c) => c.table === "inbox_entry")).toHaveLength(1);
  });

  it("Asha carries every text field; Kabir only where he stays the empty member; Noor all but her missing programme's", () => {
    const all = TEXT_FIELDS.map(([t, f]) => `${t}.${f}`);
    expect(canariesOf("Asha").filter((c) => c.kind === "text").map(key).sort()).toEqual([...all].sort());
    expect(canariesOf("Kabir").map(key).sort()).toEqual([...KABIR_FIELDS].sort());
    expect(canariesOf("Noor").filter((c) => c.kind === "text").map(key).sort()).toEqual(all.filter((f) => !NOOR_SKIPS.has(f)).sort());
  });

  it("each word is unique to its member and field, sits in its sentence, and no word contains another", () => {
    const words = texts.map((c) => c.word.toLowerCase());
    expect(new Set(words).size).toBe(words.length);
    for (const c of texts) expect(c.text).toContain(c.word);
    for (const a of words) for (const b of words) if (a !== b) expect(a.includes(b), `${a} contains ${b}`).toBe(false);
  });

  it("the owner-only numbers: a fasted weight, a waist and a marker for Asha and Noor, each shown distinct", () => {
    expect(NUMBERS.map((n) => `${n.member} ${n.what}`).sort()).toEqual(["Asha fasted weight", "Asha marker", "Asha waist", "Noor fasted weight", "Noor marker", "Noor waist"]);
    expect(new Set(NUMBERS.map(needle)).size).toBe(NUMBERS.length);
  });

  it("numbersNotOnce names a number missing from the dump or in it twice", () => {
    const once = NUMBERS.map((n) => `INSERT INTO reading VALUES (${n.shown});`).join("\n");
    expect(numbersNotOnce(once)).toEqual([]);
    expect(numbersNotOnce(`${once}\nINSERT INTO intake_item VALUES (${NUMBERS[0]!.shown});`)).toEqual([`${NUMBERS[0]!.member} ${NUMBERS[0]!.what} ${NUMBERS[0]!.shown}: 2 times`]);
    expect(numbersNotOnce("")).toHaveLength(NUMBERS.length);
    // A longer number that merely contains it doesn't count.
    expect(numbersNotOnce(`${once}\n1${NUMBERS[0]!.shown}5`)).toEqual([]);
  });

  it("stressHousehold() lists the same canaries the seed writes", () => {
    expect(stressHousehold().canaries).toBe(CANARIES);
  });
});
