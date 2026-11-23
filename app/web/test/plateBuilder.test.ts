import { describe, expect, it } from "vitest";
import { nextBarText, NO_BAR, parseBarValue, addPlate, newBuild, setBar, availablePlates, otherPlatePlan, plateLoad, plateText, removePlate, type PlateBuild } from "../src/plateBuilder";
import type { Inventory } from "../src/types";

const inv: Inventory = {
  gym: "Sample gym", gym_id: 1,
  plates: [
    { unit: "kg", complete: false, note: null, plates: [{ value: 20, status: "confirmed" }, { value: 10, status: "confirmed" }, { value: 2.5, status: "inferred" }, { value: 1.25, status: "absent" }] },
    { unit: "lb", complete: false, note: null, plates: [{ value: 5, status: "confirmed" }, { value: 10, status: "confirmed" }] },
  ],
  implements: [],
};

describe("the plate builder", () => {
  it("offers the gym's plates, kg and lb together, heaviest first, without the absent ones", () => {
    expect(availablePlates(inv)).toEqual([
      { value: 20, unit: "kg" }, { value: 10, unit: "kg" }, { value: 2.5, unit: "kg" }, { value: 10, unit: "lb" }, { value: 5, unit: "lb" },
    ]);
    expect(availablePlates(null)).toEqual([]);
  });

  it("builds one side with mixed units, counting repeats, and never totals it", () => {
    let b: PlateBuild = { bar: { value: 20, unit: "kg" }, plates: [] };
    b = addPlate(b, { value: 10, unit: "kg" });
    b = addPlate(b, { value: 5, unit: "lb" });
    b = addPlate(b, { value: 10, unit: "kg" });
    expect(b.plates).toEqual([{ value: 10, unit: "kg", count: 2 }, { value: 5, unit: "lb", count: 1 }]);
    expect(plateText(b)).toBe("20 kg bar + 2 × 10 kg + 5 lb a side");
    expect(plateLoad(b)).toEqual({ load: { basis: "per_side", plates: [{ value: 10, unit: "kg", count: 2 }, { value: 5, unit: "lb", count: 1 }], bar: { value: 20, unit: "kg" } } });
    b = removePlate(b, 0);
    expect(b.plates[0]).toEqual({ value: 10, unit: "kg", count: 1 });
    expect(removePlate(removePlate(b, 0), 0).plates).toEqual([]);
  });

  it("asks for plates before it makes a load, and leaves an unknown bar to the API", () => {
    expect(plateLoad({ bar: null, plates: [] })).toEqual({ error: "Add the plates on one side." });
    expect(plateLoad({ bar: null, plates: [{ value: 5, unit: "lb", count: 1 }] })).toEqual({ load: { basis: "per_side", plates: [{ value: 5, unit: "lb", count: 1 }] } });
  });

  it("records an other plate the rack has with record_plates", () => {
    expect(otherPlatePlan("Sample gym", { value: 15, unit: "kg" }).steps[0]).toEqual({ tool: "record_plates", input: { gym: "Sample gym", unit: "kg", available: [15], idempotency_key: expect.any(String) } });
  });

  it("starts with no bar named, and the bar control changes only the bar", () => {
    expect(newBuild()).toEqual({ bar: null, plates: [] });
    const b = addPlate(newBuild(), { value: 10, unit: "kg" });
    expect(plateLoad(b)).toEqual({ load: { basis: "per_side", plates: [{ value: 10, unit: "kg", count: 1 }] } });
    const withBar = setBar(b, { value: 15, unit: "lb" });
    expect(plateLoad(withBar)).toEqual({ load: { basis: "per_side", plates: [{ value: 10, unit: "kg", count: 1 }], bar: { value: 15, unit: "lb" } } });
    expect(plateLoad(setBar(withBar, null))).toEqual(plateLoad(b));
  });

  it("reads the bar field as typed, and offers the implement's own bar or no bar", () => {
    expect(["17.5", "7.", "0.5", ".5", " 20 "].map(parseBarValue)).toEqual([17.5, 7, 0.5, 0.5, 20]);
    expect(parseBarValue("")).toBeNull();
    expect(["abc", "1.2.3", "-5", "0"].map(parseBarValue)).toEqual(["bad", "bad", "bad", "bad"]);
    const b = addPlate(newBuild(), { value: 10, unit: "kg" });
    expect(plateLoad(b)).toEqual({ load: { basis: "per_side", plates: [{ value: 10, unit: "kg", count: 1 }] } });
    expect(plateLoad(setBar(b, NO_BAR))).toEqual({ load: { basis: "per_side", plates: [{ value: 10, unit: "kg", count: 1 }], bar: { value: 0, unit: "kg" } } });
  });

  it("keeps the bar field's typing, and resets it when the build's bar changes from outside", () => {
    expect(nextBarText("17.", { value: 17, unit: "kg" })).toBe("17.");
    expect(nextBarText("17.5", { value: 17.5, unit: "kg" })).toBe("17.5");
    expect(nextBarText("17.5", { value: 20, unit: "kg" })).toBe("20");
    expect(nextBarText("17.5", null)).toBe("");
    expect(nextBarText("17.5", NO_BAR)).toBe("");
    expect(nextBarText("", { value: 15, unit: "lb" })).toBe("15");
    expect(nextBarText("abc", { value: 17, unit: "kg" })).toBe("abc");
  });
});
