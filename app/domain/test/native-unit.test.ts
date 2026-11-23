import { describe, expect, it } from "vitest";
import { readNativeLoad } from "../src/index";

// A load's native unit is the one that makes it a whole or half number.
describe("readNativeLoad: the unit a load really is in", () => {
  it("a whole or half number in its stated unit stays as stated", () => {
    expect(readNativeLoad(12.5, "kg")).toEqual({ status: "clean", value: 12.5, unit: "kg", converted: false });
    expect(readNativeLoad(35, "lb")).toEqual({ status: "clean", value: 35, unit: "lb", converted: false });
  });

  it("a pound plate written in kg is read back as pounds", () => {
    expect(readNativeLoad(36.29, "kg")).toEqual({ status: "clean", value: 80, unit: "lb", converted: true });
    expect(readNativeLoad(9.07, "kg")).toEqual({ status: "clean", value: 20, unit: "lb", converted: true });
    expect(readNativeLoad(31.75, "kg")).toEqual({ status: "clean", value: 70, unit: "lb", converted: true });
  });

  it("a kilo plate written in pounds is read back as kilos", () => {
    expect(readNativeLoad(33.07, "lb")).toEqual({ status: "clean", value: 15, unit: "kg", converted: true });
  });

  it("an assistance (negative) load keeps its sign", () => {
    expect(readNativeLoad(-36.29, "kg")).toEqual({ status: "clean", value: -80, unit: "lb", converted: true });
  });

  it("zero is zero in any unit", () => {
    expect(readNativeLoad(0, "lb")).toEqual({ status: "clean", value: 0, unit: "lb", converted: false });
  });

  it("clean in both units is ambiguous, offering both", () => {
    // 22 kg is 48.502 lb.
    expect(readNativeLoad(22, "kg")).toEqual({
      status: "ambiguous",
      reason: "clean_in_both",
      options: [
        { value: 22, unit: "kg" },
        { value: 48.5, unit: "lb" },
      ],
    });
  });

  it("clean in neither unit is ambiguous with no options", () => {
    // 13.33 kg is 29.39 lb: not a rounding of any whole or half pound.
    expect(readNativeLoad(13.33, "kg")).toEqual({ status: "ambiguous", reason: "clean_in_neither", options: [] });
    expect(readNativeLoad(7.77, "kg")).toMatchObject({ status: "ambiguous", reason: "clean_in_neither" });
  });

  it("a stated kg value near a pound is not a pound unless it rounds to one", () => {
    // 25 kg is 55.116 lb: clean in kg only.
    expect(readNativeLoad(25, "kg")).toMatchObject({ status: "clean", value: 25, unit: "kg" });
    expect(readNativeLoad(12.5, "kg")).toMatchObject({ status: "clean", unit: "kg" });
  });
});
