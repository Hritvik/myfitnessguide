import { describe, expect, it } from "vitest";
import { day, foodLabel, longDay, plainFood } from "../src/format";

describe("dates in words", () => {
  it("prints September as Sep whatever the ICU, and other months unchanged", () => {
    expect(day("2026-09-13")).toBe("Sun 13 Sep");
    expect(longDay("2026-09-27")).toBe("27 Sep 2026");
    expect(day("2026-10-06")).toBe("Tue 6 Oct");
    expect(longDay("2027-03-28")).toBe("28 Mar 2027");
  });
});

describe("food labels in the member's words", () => {
  it("never shows a state code or a ref", () => {
    expect(foodLabel("Greek yogurt", "as_sold")).toBe("Greek yogurt (as sold)");
    expect(foodLabel("Egg", "in_shell")).toBe("Egg (in shell)");
    // A name that already says its state doesn't repeat it (click test P2-4).
    expect(foodLabel("White rice, cooked", "cooked")).toBe("White rice, cooked");
    expect(foodLabel("Peanuts in shell", "in_shell")).toBe("Peanuts in shell");
    expect(foodLabel("Cooked-rice mix", "raw")).toBe("Cooked-rice mix (raw)");
    expect(plainFood("White rice, cooked (cooked, FS031)")).toBe("White rice, cooked");
    expect(plainFood("Greek yogurt (as_sold, FS007)")).toBe("Greek yogurt (as sold)");
    expect(plainFood("Ghee (as_sold), 1 tsp")).toBe("Ghee (as sold), 1 tsp");
    expect(plainFood("Roti (cooked)")).toBe("Roti (cooked)");
    // Only a known state is rewritten: a dish's own brackets stay.
    expect(plainFood("Paneer bhurji (home_style)")).toBe("Paneer bhurji (home_style)");
  });
});
