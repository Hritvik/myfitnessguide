import { describe, expect, it } from "vitest";
import { countNote, MAX_TEXT, sendInput, sendPlan, WAITING_INPUT, waitingAbout } from "../src/freetext";

describe("Tell Claude's send", () => {
  it("sends the trimmed text whole, with one span over all of it", () => {
    expect(sendInput("Asha", "2026-10-06", "lunch", "  2 eggs and toast \n")).toEqual({
      input: { member: "Asha", date: "2026-10-06", meal_slot: "lunch", text: "2 eggs and toast", spans: [{ text: "2 eggs and toast", start: 0, end: 16 }] },
    });
  });

  it("refuses a blank text, and one over the Worker's cap, instead of cutting it", () => {
    expect(sendInput("Asha", "2026-10-06", "lunch", " \n ")).toEqual({ error: "Write something to send." });
    expect(sendInput("Asha", "2026-10-06", "lunch", "a".repeat(MAX_TEXT + 1))).toMatchObject({ error: expect.stringContaining("too long") });
    expect("input" in sendInput("Asha", "2026-10-06", "lunch", "a".repeat(MAX_TEXT))).toBe(true);
  });

  it("says the limit plainly, and counts the trimmed text in UTF-16 units near it", () => {
    expect(sendInput("Asha", "2026-10-06", "lunch", "a".repeat(MAX_TEXT + 1))).toEqual({ error: "That's too long to send. Up to 5,000 characters." });
    expect(countNote("a".repeat(4499))).toBeNull();
    expect(countNote(" " + "a".repeat(4950) + " ")).toBe("4,950 / 5,000");
    expect(countNote("\u{1F600}".repeat(2500))).toBe("5,000 / 5,000");
  });

  it("is one submit_to_inbox step with its own key, made fresh for each tap", () => {
    const made = sendInput("Asha", "2026-10-06", "lunch", "tea");
    if (!("input" in made)) throw new Error("unexpected");
    const a = sendPlan(made.input);
    const b = sendPlan(made.input);
    expect(a.steps).toHaveLength(1);
    expect(a.steps[0]!.tool).toBe("submit_to_inbox");
    expect(a.steps[0]!.input.idempotency_key).toMatch(/^submit_to_inbox-/);
    expect(a.steps[0]!.input.idempotency_key).not.toBe(b.steps[0]!.input.idempotency_key);
    expect(a.done).toBe("Sent to Claude. It'll be logged when Claude goes through the inbox; you'll see it as waiting until then.");
  });

  it("reads your waiting texts naming nobody, and shows those about the member the sheet is for (decision 110)", () => {
    // The Worker gives a member only the texts they sent and refuses naming another member.
    expect(WAITING_INPUT).toEqual({ status: "pending" });
    const sent = [{ id: 1, member: "Asha" }, { id: 2, member: "Kabir" }, { id: 3, member: "Asha" }];
    expect(waitingAbout(sent, "Asha").map((e) => e.id)).toEqual([1, 3]);
    expect(waitingAbout(sent, "Kabir").map((e) => e.id)).toEqual([2]);
  });
});
