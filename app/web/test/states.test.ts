import { describe, expect, it } from "vitest";
import { STATE_NAMES, stateNamed, states, type StateApi } from "../scripts/states";

const api: StateApi = {
  tool: async () => ({ today: "2026-10-08", members: ["Asha", "Kabir", "Noor Fatima Venkataraman-Siddiqui"] }),
  viewer: { name: "Asha", email: "asha@example.com" },
};

describe("the sweep's states (e2e spec §2)", () => {
  it("STATE_NAMES lists every state states() makes, in order, so tests can be listed before a Worker runs", async () => {
    expect((await states(api)).map((s) => s.name)).toEqual(STATE_NAMES);
  });

  it("names are unique, and the other members' views are named by first name", () => {
    expect(new Set(STATE_NAMES).size).toBe(STATE_NAMES.length);
    expect(STATE_NAMES).toContain("today-as-Kabir");
    expect(STATE_NAMES).toContain("household-as-Noor");
    expect(STATE_NAMES.filter((n) => n.startsWith("record-") || n.startsWith("edit-"))).toEqual([
      "record-catalogue-0", "edit-catalogue-0", "record-catalogue-1", "edit-catalogue-1", "record-catalogue-2", "edit-catalogue-2",
      "record-workouts-0", "record-workouts-1", "record-workouts-2", "record-exercises-0", "record-exercises-1", "record-exercises-2",
      "record-gyms-0", "record-gyms-1", "record-gyms-2",
    ]);
  });

  it("stateNamed finds one, and refuses a name it doesn't know", async () => {
    expect((await stateNamed(api, "week")).path).toBe("/progress?week=2026-10-07");
    await expect(stateNamed(api, "nope")).rejects.toThrow(/no state named nope/);
  });
});
