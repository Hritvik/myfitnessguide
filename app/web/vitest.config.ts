import { defineConfig } from "vitest/config";

// Unit tests cover data mapping and state logic only; layout is checked by screenshot.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
