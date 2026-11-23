import { describe, expect, it } from "vitest";
import { buildStrip } from "../src/strip";
import { needs } from "./fixtures";

const TZ = "Asia/Kolkata";

describe("buildStrip", () => {
  it("states each card plainly with one action, in the API's order, and counts what is beyond three", () => {
    const strip = buildStrip(needs(), TZ);
    expect(strip?.hidden).toBe(3);
    expect(strip?.cards.map((c) => [c.text, c.action.label])).toEqual([
      ["2 drafts about you; the oldest confirms by itself Wed 13:00.", "Show drafts"],
      ["28% of Masoor dal isn't accounted for yet.", "Mark the rest leftover"],
      ["Yesterday is still open (4 items). Close it, and mark any meal you skipped.", "Open yesterday"],
      ["2 loads to act on in Upper A.", "Open Train"],
      ["Repeat the iron panel: due Sat 10 Oct. 1 more due soon.", "Open Health"],
      ["Waist is overdue.", "Open Progress"],
    ]);
    expect(strip?.cards[1]?.action).toEqual({ kind: "leftover", label: "Mark the rest leftover", componentId: 21 });
    expect(strip?.cards[2]?.action).toEqual({ kind: "link", label: "Open yesterday", href: "/?date=2026-10-05" });
  });

  it("gives a draft that never auto-confirms its reason, never a deadline, and sends training drafts to Train", () => {
    const coach = buildStrip(needs({ cards: [{ rule: "drafts", count: 1, oldest: { table: "session_set", id: 9, deadline: null, waits: "end_of_session" }, message: "m" }], more: [] }), TZ);
    expect(coach?.cards[0]).toMatchObject({ text: "1 draft about you; the oldest waits for the end of the session.", action: { label: "Open Train", href: "/train" } });
    const rir = buildStrip(needs({ cards: [{ rule: "drafts", count: 1, oldest: { table: "session_set", id: 9, deadline: null, waits: "rir_needed" }, message: "m" }], more: [] }), TZ);
    expect(rir?.cards[0]?.text).toBe("1 draft about you; the oldest needs RIR.");
  });

  it("sends a reading draft to Progress, a blood draw to Health and a meal draft to the meals", () => {
    const href = (table: string) => {
      const strip = buildStrip(needs({ cards: [{ rule: "drafts", count: 1, oldest: { table, id: 9, deadline: null, waits: null }, message: "m" }], more: [] }), TZ);
      return (strip?.cards[0]?.action as { href: string }).href;
    };
    expect(href("reading")).toBe("/progress");
    expect(href("blood_draw")).toBe("/progress/health");
    expect(href("intake_item")).toBe("#meals");
  });

  it("names a remainder's pot day, now that the strip lists the last three days' pots (redesign-a plan, R5)", () => {
    const strip = buildStrip({ member: "Asha", date: "2026-10-07", cards: [{ rule: "remainder", cook_id: 1, cook: "Toor dal", cooked_on: "2026-10-05", component_id: 4, component: null, fraction: 0.35, message: "" }], more: [] }, "Asia/Kolkata");
    expect(strip?.cards[0]?.text).toBe("35% of Toor dal from Mon 5 Oct isn't accounted for yet.");
  });

  it("is absent when nothing is due", () => {
    expect(buildStrip(needs({ cards: [], more: [] }), TZ)).toBeNull();
  });

  it("turns a due prep card into a link to the Prep strip, never an undefined card", () => {
    const prep = buildStrip(needs({ cards: [{ rule: "prep", count: 2, tasks: [{ task_id: 1, action: "Soak", due_on: "2026-10-06" }], message: "2 prep tasks due now: Soak." }], more: [] }), TZ);
    expect(prep?.cards[0]).toEqual({ key: "prep", text: "2 prep tasks due now: Soak.", action: { kind: "link", label: "See prep", href: "#prep" } });
  });

  it("opens the Reading tab from a reading cadence's card, on its metric and body state; any other cadence opens Progress", () => {
    const weigh = buildStrip(needs({ cards: [{ rule: "measurement", cadence: "fasted_weight", metric: "weight", body_state: "fasted", last: null, message: "Log a fasted weight." }], more: [] }), TZ);
    expect(weigh?.cards[0]).toEqual({ key: "measurement:fasted_weight", text: "Log a fasted weight.", action: { kind: "reading", label: "Log a reading", metric: "weight", bodyState: "fasted" } });
    const manual = buildStrip(needs({ cards: [{ rule: "measurement", cadence: "bp_cuff", metric: null, body_state: null, last: null, message: "Check the BP cuff's battery." }], more: [] }), TZ);
    expect(manual?.cards[0]?.action).toEqual({ kind: "link", label: "Open Progress", href: "/progress" });
  });
});
