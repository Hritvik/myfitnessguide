import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/tools";
import { TOOL_CAPABILITIES, selectToolsForProfile } from "../src/tool-capabilities";
import { describeTools } from "../src/tool";

describe("the canonical MCP capability manifest", () => {
  it("explicitly classifies every routed tool and no stale tool", () => {
    expect(TOOLS).toHaveLength(120);
    expect(Object.keys(TOOL_CAPABILITIES).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
  });

  it("gives remote members every routed tool except query and ask_member", () => {
    const names = selectToolsForProfile(TOOLS, "remoteMember").map((tool) => tool.name);
    expect(names.sort()).toEqual(TOOLS.map((tool) => tool.name).filter((name) => name !== "query" && name !== "ask_member").sort());
  });

  it("gives interactive service-token agents every routed tool", () => {
    expect(selectToolsForProfile(TOOLS, "interactiveAgent").map((tool) => tool.name).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
  });

  it("gives unattended agents every read plus exactly three writes", () => {
    const selected = selectToolsForProfile(TOOLS, "unattended");
    expect(selected.filter((tool) => tool.write).map((tool) => tool.name).sort()).toEqual([
      "household_meal",
      "log_intake",
      "resolve_inbox_entry",
    ]);
    expect(selected.filter((tool) => !tool.write).map((tool) => tool.name).sort()).toEqual(
      TOOLS.filter((tool) => !tool.write).map((tool) => tool.name).sort(),
    );
  });

  it("fails closed when a routed tool has not been classified", () => {
    expect(() => selectToolsForProfile([...TOOLS, { ...TOOLS[0]!, name: "new_unclassified_tool" }], "remoteMember")).toThrow(
      /new_unclassified_tool.*not classified/i,
    );
  });

  it("publishes the three capability decisions in the API tool description", () => {
    const [described] = describeTools([TOOLS.find((tool) => tool.name === "log_intake")!]) as Array<Record<string, unknown>>;
    expect(described!.profiles).toEqual({ remoteMember: true, interactiveAgent: true, unattended: true });
  });
});
