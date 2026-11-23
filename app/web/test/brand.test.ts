import { describe, expect, it } from "vitest";
import { brandedTitle, PRODUCT_NAME } from "../src/brand";

describe("product branding", () => {
  it("uses the product name on its own", () => {
    expect(PRODUCT_NAME).toBe("MyFitnessGuide");
    expect(brandedTitle()).toBe("MyFitnessGuide");
  });

  it("keeps the current page visible in the browser title", () => {
    expect(brandedTitle("Nutrition")).toBe("Nutrition · MyFitnessGuide");
  });
});
