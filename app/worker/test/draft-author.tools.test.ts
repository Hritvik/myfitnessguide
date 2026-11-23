// Ticket 69: a draft's author may withdraw it (reject) while nobody has
// consented to it; confirm and retract stay its member's. Invented data only.
import { describe, expect, it } from "vitest";
import { toolWithinBudget } from "./budget";
import { setup, type Harness } from "./harness";
import { seedCatalogue, seedTraining } from "./seed";

const DAY = "2026-10-05";
const rice = (value: number) => ({ source: "food", food: "FS002", value, unit: "g", provenance: "weighed", confidence: "high" });

async function ready() {
  const x = setup();
  await seedCatalogue(x);
  return x;
}

/** Hritvik logs an item about Asha (a draft), through the app or the agent. */
async function hisDraftAboutHer(x: Harness, via: "hritvik" | "agent" = "hritvik") {
  const logged = await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "dinner", items: [rice(100)] }, via);
  expect(logged.items[0].state).toBe("draft");
  return { table: "intake_item", id: logged.items[0].id as number };
}

const stateOf = (x: Harness, r: { table: string; id: number }) => x.t.get(`SELECT state, confirmed_at FROM ${r.table} WHERE id = ?`, r.id);
const refusal = async (x: Harness, tool: string, input: Record<string, unknown>, as: Parameters<Harness["call"]>[2]) => {
  const r = await x.call(tool, input, as);
  return [r.http, r.body.error?.code];
};

describe("a draft's author may reject it", () => {
  it("in the app and through the agent talking with them; the write is on behalf of the member it is about", async () => {
    const x = await ready();
    const viaApp = await hisDraftAboutHer(x, "hritvik");
    const body = await x.ok("reject", { records: [viaApp], reason: "wrong food" }, "hritvik");
    expect(body.rejected).toEqual([viaApp]);
    expect(x.t.get("SELECT count(*) AS n FROM intake_item WHERE id = ?", viaApp.id)).toEqual({ n: 0 });
    expect(x.t.get("SELECT on_behalf_of_member_id AS o FROM write_log ORDER BY id DESC LIMIT 1")).toEqual({ o: x.h.asha });

    const viaAgent = await hisDraftAboutHer(x, "agent");
    expect((await x.ok("reject", { records: [viaAgent], reason: "wrong food" })).rejected).toEqual([viaAgent]);
  });

  it("a third member may not, in the app or through the agent", async () => {
    const x = await ready();
    const draft = await hisDraftAboutHer(x);
    expect(await refusal(x, "reject", { records: [draft], reason: "x" }, "kabir")).toEqual([403, "not_yours_to_decide"]);
    expect(await refusal(x, "reject", { speaker: "Kabir", records: [draft], reason: "x" }, "agent")).toEqual([403, "not_yours_to_decide"]);
    expect(stateOf(x, draft)).toEqual({ state: "draft", confirmed_at: null });
  });

  it("the author still cannot confirm it", async () => {
    const x = await ready();
    const draft = await hisDraftAboutHer(x);
    expect(await refusal(x, "confirm", { records: [draft] }, "hritvik")).toEqual([403, "not_yours_to_decide"]);
    expect(await refusal(x, "confirm", { records: [draft] }, "agent")).toEqual([403, "not_yours_to_decide"]);
  });

  it("once its member has confirmed it, the author can neither reject nor retract it", async () => {
    const x = await ready();
    const draft = await hisDraftAboutHer(x);
    await x.ok("confirm", { records: [draft] }, "asha");
    expect(await refusal(x, "reject", { records: [draft], reason: "x" }, "hritvik")).toEqual([403, "not_yours_to_decide"]);
    expect(await refusal(x, "retract", { records: [draft], reason: "x" }, "hritvik")).toEqual([403, "not_yours_to_retract"]);
  });

  it("an Inbox write gains no author's reject, even naming the author as speaker", async () => {
    const x = await ready();
    const draft = await hisDraftAboutHer(x);
    expect(await refusal(x, "reject", { origin: "inbox", speaker: "Hritvik", records: [draft], reason: "x" }, "agent")).toEqual([403, "not_yours_to_decide"]);
  });

  it("rejecting the author's draft portion takes its intake item with it", async () => {
    const x = await ready();
    const meal = await x.ok("household_meal", {
      date: DAY, meal_slot: "dinner",
      cooks: [{ name: "Invented dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [
        { member: "Hritvik", fraction: 0.5, provenance: "estimated" },
        { member: "Asha", fraction: 0.5, provenance: "estimated" },
      ] }],
    }, "hritvik");
    const hers = meal.cooks[0].portions[1];
    expect(hers.state).toBe("draft");
    const item = x.t.get("SELECT id FROM intake_item WHERE portion_id = ?", hers.id) as { id: number };
    await x.ok("reject", { records: [{ table: "portion", id: hers.id }], reason: "she wasn't home" }, "hritvik");
    expect(x.t.get("SELECT count(*) AS n FROM intake_item WHERE id = ?", item.id)).toEqual({ n: 0 });
    expect((await x.ok("history", { table: "intake_item", id: item.id })).versions.at(-1).action).toBe("reject");
  });

  it("stays within the read budget", async () => {
    const x = await ready();
    const draft = await hisDraftAboutHer(x);
    await toolWithinBudget(x, "reject", { records: [draft], reason: "wrong food" }, "hritvik");
  });
});

describe("a draft's author and the records that go with it (review P0-1)", () => {
  /** Hritvik starts a session for Asha through the agent: a draft he logged. */
  async function hisSessionForHer(x: Harness) {
    const s = seedTraining(x);
    const session = (await x.ok("start_session", { member: "Asha", date: DAY, session_type: "strength", gym: s.gym })).session;
    expect(session.state).toBe("draft");
    const lift = (as: "agent" | "asha") => x.ok("log_set", { session_id: session.id, exercise: "lat pulldown", reps: 10, rir: { low: 1, high: 2 }, load: { value: 40, unit: "kg", basis: "total", implement: s.stack } }, as);
    return { ref: { table: "session", id: session.id as number }, lift };
  }

  it("may not reject a draft session holding sets its member logged herself; they stay", async () => {
    const x = await ready();
    const { ref, lift } = await hisSessionForHer(x);
    const hers = (await lift("asha")).set;
    expect(hers.state).toBe("confirmed");
    const r = await x.call("reject", { records: [ref], reason: "x" });
    expect([r.http, r.body.error.code]).toEqual([403, "not_yours_to_decide"]);
    expect(r.body.error.message).toMatch(/Asha has logged sets in it/);
    expect(x.t.get("SELECT count(*) AS n FROM session_set WHERE id = ?", hers.id)).toEqual({ n: 1 });
    // She still can.
    expect((await x.ok("reject", { records: [ref], reason: "not today" }, "asha")).rejected).toEqual([ref]);
  });

  it("may not reject a draft session holding a block someone else logged", async () => {
    const x = await ready();
    const { ref } = await hisSessionForHer(x);
    x.t.insert("cardio_block", { session_id: ref.id, position: 1, kind: "steady", activity: "walk", duration_s: 600 });
    expect(await refusal(x, "reject", { records: [ref], reason: "x" }, "agent")).toEqual([403, "not_yours_to_decide"]);
  });

  it("may reject a draft session holding only draft sets they logged, all together", async () => {
    const x = await ready();
    const { ref, lift } = await hisSessionForHer(x);
    const his = (await lift("agent")).set;
    expect(his.state).toBe("draft");
    expect((await x.ok("reject", { records: [ref], reason: "wrong member" })).rejected).toEqual([ref]);
    expect(x.t.get("SELECT count(*) AS n FROM session_set WHERE id = ?", his.id)).toEqual({ n: 0 });
  });

  it("refuses a batch that names someone else's draft too, naming its index, and removes nothing", async () => {
    const x = await ready();
    const mine = await hisDraftAboutHer(x);
    const theirs = (await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "lunch", items: [rice(80)] }, "kabir")).items[0];
    const r = await x.call("reject", { records: [mine, { table: "intake_item", id: theirs.id }], reason: "x" }, "hritvik");
    expect([r.http, r.body.error.code, r.body.error.index]).toEqual([403, "not_yours_to_decide", 1]);
    expect(x.t.get("SELECT count(*) AS n FROM intake_item")).toEqual({ n: 2 });
  });

  it("may reject a draft created through the Inbox naming them (only an Inbox-routed reject is refused)", async () => {
    const x = await ready();
    const viaInbox = (await x.ok("log_intake", { origin: "inbox", speaker: "Hritvik", member: "Asha", date: DAY, meal_slot: "lunch", items: [rice(80)] })).items[0];
    expect((await x.ok("reject", { records: [{ table: "intake_item", id: viaInbox.id }], reason: "wrong food" }, "hritvik")).rejected).toHaveLength(1);
  });
});
