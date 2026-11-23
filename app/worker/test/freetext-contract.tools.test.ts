// The web's Tell Claude send against the Worker's submit_to_inbox as it
// really is, and the web's food-state list against the API's. Pure web
// functions; no DOM. Members are the harness's own.
import { describe, expect, it } from "vitest";
import { MAX_TEXT, sendInput, sendPlan } from "../../web/src/freetext";
import { setup } from "./harness";
import { MONDAY } from "./input-seed";

describe("Tell Claude's send, to the Worker's submit_to_inbox", () => {
  const send = (text: string) => {
    const made = sendInput("Hritvik", MONDAY, "dinner", text);
    if ("error" in made) throw new Error(made.error);
    return sendPlan(made.input).steps[0]!.input;
  };

  it("lands a whole line with one span, once for one key, and lists it as pending", async () => {
    const x = setup();
    const input = send("  2 eggs, half the dal; ghee 1tsp \u0915\u0947 \u0938\u093e\u0925 ");
    const first = await x.call("submit_to_inbox", { ...input }, "hritvik");
    expect(first.body).toMatchObject({ status: "ok" });
    expect((await x.call("submit_to_inbox", { ...input }, "hritvik")).body).toMatchObject({ status: "ok" });
    const listed = (await x.ok("inbox_entries", { member: "Hritvik", status: "pending" }, "hritvik")) as unknown as { entries: { text: string; spans: unknown[] }[] };
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]!.spans).toHaveLength(1);
  });

  it("takes a text of exactly the cap", async () => {
    const x = setup();
    expect((await x.call("submit_to_inbox", { ...send("a".repeat(MAX_TEXT)) }, "hritvik")).body).toMatchObject({ status: "ok" });
  });
});

describe("one food-state list", () => {
  it("the app's FOOD_STATES (the new-food picker and plainFood) is the API's STATES", async () => {
    const { FOOD_STATES, plainFood } = await import("../../web/src/format");
    const { STATES } = await import("../src/catalogue");
    expect([...FOOD_STATES]).toEqual([...STATES]);
    for (const s of STATES) expect(plainFood(`Invented food (${s}, FS099)`)).toBe(`Invented food (${s.replace(/_/g, " ")})`);
  });
});
