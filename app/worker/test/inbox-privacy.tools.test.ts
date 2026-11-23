// An Inbox text is its sender's (Worker decision 157): a member sees only
// the entries they sent (`created_by`), through every read path; naming
// another member is not_visible; the agent still sees everyone's. Texts can
// carry health details, like the free text of decisions 135 and 137.
// Invented data only.
import { describe, expect, it } from "vitest";
import { toolWithinBudget } from "./budget";
import { setup, type Harness } from "./harness";
import { seedCatalogue } from "./seed";
import { busyInput, MONDAY } from "./input-seed";

const HERS = "CANARY-ASHA bp 150/95 after the new pill";
const HERS_ABOUT_HIM = "CANARY-ABOUT-HRITVIK he skipped his statin again";
const HIS = "2 eggs and the green chutney";

const whole = (text: string) => [{ text, start: 0, end: text.length }];
const leaks = (body: unknown) => JSON.stringify(body).includes("CANARY");

/** Hritvik's own text; Asha's about herself; Asha's about Hritvik. */
async function threeTexts(x: Harness) {
  const his = (await x.ok("submit_to_inbox", { member: "Hritvik", date: MONDAY, text: HIS, spans: whole(HIS) }, "hritvik")).entry;
  const hers = (await x.ok("submit_to_inbox", { member: "Asha", date: MONDAY, text: HERS, spans: whole(HERS) }, "asha")).entry;
  const aboutHim = (await x.ok("submit_to_inbox", { member: "Hritvik", date: MONDAY, text: HERS_ABOUT_HIM, spans: whole(HERS_ABOUT_HIM) }, "asha")).entry;
  return { his, hers, aboutHim };
}

describe("inbox_entries: a member sees the texts they sent", () => {
  it("gives a member only their own texts, never one another member sent about them", async () => {
    const x = setup();
    const { his } = await threeTexts(x);
    for (const input of [{}, { member: "Hritvik" }, { status: "all" }, { member: "Hritvik", status: "all" }]) {
      const body = await x.ok("inbox_entries", input, "hritvik");
      expect(body.entries.map((e: { id: number }) => e.id)).toEqual([his.id]);
      expect(leaks(body)).toBe(false);
    }
  });

  it("refuses a member naming another member as not_visible", async () => {
    const x = setup();
    await threeTexts(x);
    for (const status of ["pending", "all"]) {
      const reply = await x.call("inbox_entries", { member: "Asha", status }, "hritvik");
      expect(reply.http).toBe(403);
      expect(reply.body.error.code).toBe("not_visible");
      expect(leaks(reply.body)).toBe(false);
    }
    // Even naming the member whose texts they sent: a member names only themselves.
    expect((await x.call("inbox_entries", { member: "Hritvik" }, "asha")).body.error.code).toBe("not_visible");
  });

  it("gives the agent everyone's, and its member filter is still the member a text is about", async () => {
    const x = setup();
    const { his, hers, aboutHim } = await threeTexts(x);
    expect((await x.ok("inbox_entries", {})).entries.map((e: { id: number }) => e.id)).toEqual([his.id, hers.id, aboutHim.id]);
    expect((await x.ok("inbox_entries", { member: "Hritvik" })).entries.map((e: { id: number }) => e.id)).toEqual([his.id, aboutHim.id]);
  });

  it("gives a member the texts they sent about another member when they name nobody", async () => {
    const x = setup();
    const { hers, aboutHim } = await threeTexts(x);
    const body = await x.ok("inbox_entries", {}, "asha");
    expect(body.entries.map((e: { id: number }) => e.id)).toEqual([hers.id, aboutHim.id]);
    expect(body.entries[1]).toMatchObject({ member: "Hritvik", created_by: "Asha", text: HERS_ABOUT_HIM });
  });

  it("stays within the budget for a member, at three statements or fewer", async () => {
    const { x } = await busyInput(40);
    for (let i = 0; i < 60; i++) await x.ok("submit_to_inbox", { member: i % 2 ? "Asha" : "Hritvik", date: MONDAY, text: HIS, spans: whole(HIS) }, i % 2 ? "asha" : "hritvik");
    const run = await toolWithinBudget(x, "inbox_entries", { status: "all" }, "hritvik");
    expect(run.statements).toBeLessThanOrEqual(3);
    expect(run.body.entries).toHaveLength(30);
  });
});

describe("no other route gives a member another member's Inbox text", () => {
  it("history of an entry is not_visible to a member who didn't send it, even the member it is about", async () => {
    const x = setup();
    const { his, hers, aboutHim } = await threeTexts(x);
    for (const id of [hers.id, aboutHim.id]) {
      const reply = await x.call("history", { table: "inbox_entry", id }, "hritvik");
      expect(reply.http).toBe(403);
      expect(reply.body.error.code).toBe("not_visible");
      expect(leaks(reply.body)).toBe(false);
    }
    expect((await x.ok("history", { table: "inbox_entry", id: his.id }, "hritvik")).versions[0].data.text).toBe(HIS);
    expect((await x.ok("history", { table: "inbox_entry", id: aboutHim.id }, "asha")).versions[0].data.text).toBe(HERS_ABOUT_HIM);
    expect((await x.ok("history", { table: "inbox_entry", id: hers.id })).versions[0].data.text).toBe(HERS);
  });

  it("resolve_inbox_entry never hands a member a text they didn't send: not_visible, and the entry stays pending", async () => {
    const x = setup();
    const { aboutHim } = await threeTexts(x);
    const reply = await x.call("resolve_inbox_entry", { id: aboutHim.id, status: "rejected", note: "not mine", reason: "r" }, "hritvik");
    expect(reply.http).toBe(403);
    expect(reply.body.error.code).toBe("not_visible");
    expect(leaks(reply.body)).toBe(false);
    expect(x.t.get("SELECT status FROM inbox_entry WHERE id = ?", aboutHim.id)).toEqual({ status: "pending" });
    // The agent closes it as before.
    expect((await x.ok("resolve_inbox_entry", { id: aboutHim.id, status: "rejected", note: "dup", reason: "r" })).entry.text).toBe(HERS_ABOUT_HIM);
  });

  it("Today's reads, needs_you and the household views carry no other member's Inbox text", async () => {
    const x = setup();
    await threeTexts(x);
    const reads: [string, Record<string, unknown>][] = [
      ["whoami", {}],
      ["household_overview", { date: MONDAY }],
      ["needs_you", { member: "Hritvik", date: MONDAY }],
      ["day_totals", { member: "Hritvik", date: MONDAY }],
      ["day_meals", { member: "Hritvik", date: MONDAY }],
      ["day_cooks", { member: "Hritvik", date: MONDAY }],
      ["day_totals", { member: "Asha", date: MONDAY }],
      ["day_meals", { member: "Asha", date: MONDAY }],
      ["inbox_entries", { status: "pending" }],
      ["inbox_entries", { member: "Hritvik", status: "pending" }],
    ];
    for (const [tool, input] of reads) {
      const reply = await x.call(tool, input, "hritvik");
      expect(reply.http, `${tool} ${JSON.stringify(input)}`).toBe(200);
      expect(leaks(reply.body), `${tool} ${JSON.stringify(input)}`).toBe(false);
    }
  });

  it("after the agent resolves another member's text into his records, in its own words, his reads carry none of it", async () => {
    const x = setup();
    await seedCatalogue(x);
    const { aboutHim } = await threeTexts(x);
    // The gym-inbox rule (decision 157): another sender's words never go into the subject's records.
    const item = (await x.ok("log_intake", {
      speaker: "Asha", member: "Hritvik", date: MONDAY, meal_slot: "snack", reason: "from an Inbox entry",
      items: [{ source: "food", food: "FS002", value: 80, unit: "g", provenance: "estimated", confidence: "low", label: "Snack from the Inbox" }],
    })).items[0];
    const note = "CANARY-NOTE logged as his snack draft";
    await x.ok("resolve_inbox_entry", { id: aboutHim.id, status: "resolved", note, records: [{ table: "intake_item", id: item.id }], reason: "resolved in the inbox skill" });
    const reads: [string, Record<string, unknown>][] = [
      ["day_meals", { member: "Hritvik", date: MONDAY }],
      ["day_totals", { member: "Hritvik", date: MONDAY }],
      ["needs_you", { member: "Hritvik", date: MONDAY }],
      ["household_overview", { date: MONDAY }],
      ["history", { table: "intake_item", id: item.id }],
      ["inbox_entries", { status: "all" }],
    ];
    for (const [tool, input] of reads) {
      const reply = await x.call(tool, input, "hritvik");
      expect(reply.http, `${tool} ${JSON.stringify(input)}`).toBe(200);
      expect(leaks(reply.body), `${tool} ${JSON.stringify(input)}`).toBe(false);
    }
    expect(JSON.stringify((await x.ok("day_meals", { member: "Hritvik", date: MONDAY }, "hritvik")))).toContain("Snack from the Inbox");
    // The closed entry, its note included, stays the sender's.
    for (const [tool, input] of [["history", { table: "inbox_entry", id: aboutHim.id }], ["resolve_inbox_entry", { id: aboutHim.id, status: "rejected", note: "x", reason: "r" }]] as const) {
      const reply = await x.call(tool, input, "hritvik");
      expect([reply.http, reply.body.error.code]).toEqual([403, "not_visible"]);
      expect(leaks(reply.body)).toBe(false);
    }
    expect((await x.ok("inbox_entries", {}, "asha")).entries.length).toBe(1);
    expect((await x.ok("inbox_entries", { status: "all" }, "asha")).entries.find((e: { id: number }) => e.id === aboutHim.id).note).toBe(note);
  });
});
