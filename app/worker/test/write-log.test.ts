import { describe, expect, it } from "vitest";
import { NOW, TestDb } from "./db";
import { household, writeLog } from "./fixtures";

describe("write log", () => {
  it("records the resolver, the member written on behalf of, the reason and the origin", () => {
    const t = new TestDb();
    const h = household(t);
    const id = writeLog(t, { on_behalf_of_member_id: h.asha, origin: "inbox", resolver: "claude_code" });
    expect(t.get("SELECT resolver, on_behalf_of_member_id, origin FROM write_log WHERE id = ?", id)).toEqual({
      resolver: "claude_code", on_behalf_of_member_id: h.asha, origin: "inbox",
    });
  });

  it("rejects a write with no reason", () => {
    const t = new TestDb();
    household(t);
    expect(() => writeLog(t, { reason: "  " })).toThrow(/CHECK/);
  });

  it("rejects an unknown origin or resolver", () => {
    const t = new TestDb();
    household(t);
    expect(() => writeLog(t, { origin: "telegram" })).toThrow(/CHECK/);
    expect(() => writeLog(t, { resolver: "gpt" })).toThrow(/CHECK/);
  });

  it("requires the acting member when a member wrote it themselves, and only then", () => {
    const t = new TestDb();
    const h = household(t);
    expect(() => writeLog(t, { resolver: "member", origin: "app" })).toThrow(/CHECK/);
    expect(writeLog(t, { resolver: "member", origin: "app", actor_member_id: h.asha })).toBeGreaterThan(0);
    expect(() => writeLog(t, { resolver: "claude_code", actor_member_id: h.asha })).toThrow(/CHECK/);
  });
});

describe("idempotency keys", () => {
  it("stores the response once per key and refuses the key twice", () => {
    const t = new TestDb();
    household(t);
    const w1 = writeLog(t);
    const w2 = writeLog(t);
    const row = { key: "k-123", tool: "log_set", request_hash: "abc", response: '{"ok":true}', created_at: NOW };
    t.insert("idempotency_key", { ...row, write_id: w1 });
    expect(() => t.insert("idempotency_key", { ...row, write_id: w2 })).toThrow(/UNIQUE/);
  });

  it("rejects a response that is not a JSON object", () => {
    const t = new TestDb();
    household(t);
    const w = writeLog(t);
    expect(() =>
      t.insert("idempotency_key", {
        key: "k", tool: "log_set", request_hash: "abc", response: "not json", created_at: NOW, write_id: w,
      }),
    ).toThrow(/CHECK/);
  });
});

describe("record versions", () => {
  it("keeps every version of an amended record, numbered from 1", () => {
    const t = new TestDb();
    household(t);
    const w = writeLog(t);
    const v = { write_id: w, table_name: "intake_item", record_id: 7, created_at: NOW };
    t.insert("record_version", { ...v, version: 1, action: "create", data: '{"kcal":100}' });
    t.insert("record_version", { ...v, version: 2, action: "amend", data: '{"kcal":120}' });
    expect(() => t.insert("record_version", { ...v, version: 2, action: "amend", data: "{}" })).toThrow(/UNIQUE/);
    expect(() => t.insert("record_version", { ...v, version: 0, action: "create", data: "{}" })).toThrow(/CHECK/);
    expect(() => t.insert("record_version", { ...v, version: 3, action: "overwrite", data: "{}" })).toThrow(/CHECK/);
  });
});

describe("member notes", () => {
  it("are versioned prose about a member or one of their records", () => {
    const t = new TestDb();
    const h = household(t);
    const note = t.insert("member_note", {
      household_id: h.id, member_id: h.asha, topic: "back pain", created_at: NOW,
    });
    const w = writeLog(t);
    t.insert("member_note_version", { note_id: note, version: 1, body: "Surface any recurrence.", write_id: w, created_at: NOW });
    t.insert("member_note_version", { note_id: note, version: 2, body: "Surface any recurrence; ask about sleep.", write_id: w, created_at: NOW });
    expect(() =>
      t.insert("member_note_version", { note_id: note, version: 3, body: "", write_id: w, created_at: NOW }),
    ).toThrow(/CHECK/);
  });

  it("attach to a record only with both its kind and its id", () => {
    const t = new TestDb();
    const h = household(t);
    const base = { household_id: h.id, member_id: h.hritvik, topic: "cue", created_at: NOW };
    expect(() => t.insert("member_note", { ...base, subject_table: "prescription" })).toThrow(/CHECK/);
    expect(() => t.insert("member_note", { ...base, subject_table: "spreadsheet", subject_id: 1 })).toThrow(/CHECK/);
    expect(t.insert("member_note", { ...base, subject_table: "prescription", subject_id: 1 })).toBeGreaterThan(0);
  });
});

describe("legacy Agent Audit rows", () => {
  it("import with a missing time kept as not recorded", () => {
    const t = new TestDb();
    const h = household(t);
    const row = {
      source_file: "hritvik", member_id: h.hritvik, logged_on: "2026-09-24", agent: "claude", action: "append",
      target: "Log!A300:S305", reason: "session", prior_value: null, result: "ok",
    };
    expect(t.insert("legacy_audit_entry", row)).toBeGreaterThan(0);
    expect(() => t.insert("legacy_audit_entry", { ...row, logged_time: "7.30pm" })).toThrow(/CHECK/);
    expect(t.insert("legacy_audit_entry", { ...row, logged_time: "19:30:00" })).toBeGreaterThan(0);
  });
});
