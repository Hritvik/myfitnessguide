import { describe, expect, it } from "vitest";
import { buildLearned } from "../src/learned";
import type { Learned } from "../src/types";

const data: Learned = {
  aliases: [
    { id: 4, alias: "dahi", kind: "food_source", target_id: 4, target: "Curd (as_sold, FS004)", created_by: "Kabir", created_at: "2026-10-05T07:30:00Z" },
    { id: 1, alias: "bench", kind: "exercise", target_id: 1, target: "Barbell bench press", created_by: null, created_at: "2026-10-06T00:00:00Z" },
  ],
  router: [
    { member: "Asha", week_of: "2026-10-05", unedited: 13, edited: 5, inbox: 3, pieces: 21, share_unedited: 0.619 },
    { member: "Asha", week_of: "2026-09-28", unedited: 0, edited: 0, inbox: 2, pieces: 2, share_unedited: 0 },
  ],
};

describe("What I've learned", () => {
  it("lists every word with what it means, who taught it and when", () => {
    expect(buildLearned(data).words).toEqual([
      { id: 4, word: "dahi", means: "Curd (as sold)", kind: "food", by: "Kabir", when: "Mon 5 Oct" },
      { id: 1, word: "bench", means: "Barbell bench press", kind: "exercise", by: "set up at the start", when: "Tue 6 Oct" },
    ]);
  });

  it("words the router's measure from the API's share", () => {
    expect(buildLearned(data).measure).toEqual([
      "Asha, week of Mon 5 Oct: 62% saved without Claude (13 of 21 pieces).",
      "Asha, week of Mon 28 Sep: 0% saved without Claude (0 of 2 pieces).",
    ]);
  });
});

describe("one words screen", () => {
  it("has no pre-filled forget any more: forgetting goes through the catalogue's words screen, with a reason", async () => {
    const mod = await import("../src/learned");
    expect("forgetPlan" in mod).toBe(false);
  });
});
