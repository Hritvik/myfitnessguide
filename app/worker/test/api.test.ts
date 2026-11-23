import { describe, expect, it } from "vitest";
import { setup } from "./harness";

describe("the HTTP surface", () => {
  it("GET /tools lists every tool with its JSON schema, so the MCP server can be generated", async () => {
    const { raw } = setup();
    const reply = await raw("/tools", { method: "GET" });
    expect(reply.http).toBe(200);
    const names = reply.body.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("upsert_food_source");
    const tool = reply.body.tools.find((t: { name: string }) => t.name === "upsert_food_source");
    expect(tool.endpoint).toBe("/tools/upsert_food_source");
    expect(tool.write).toBe(true);
    expect(tool.input_schema.type).toBe("object");
    expect(tool.input_schema.required).toContain("idempotency_key");
  });

  it("refuses a request with no Access identity", async () => {
    const { call, raw } = setup();
    expect((await call("catalogue_search", { query: "rice" }, "nobody")).http).toBe(401);
    expect((await raw("/tools", { method: "GET", as: "nobody" })).http).toBe(401);
  });

  it("refuses an identity that is neither a member nor a known service token", async () => {
    const { call, raw } = setup();
    expect((await call("catalogue_search", { query: "rice" }, "stranger")).http).toBe(403);
    expect((await call("catalogue_search", { query: "rice" }, "unknown_token")).http).toBe(403);
    expect((await raw("/tools", { method: "GET", as: "stranger" })).http).toBe(403);
    expect((await raw("/tools", { method: "GET", as: "unknown_token" })).http).toBe(403);
  });

  it("validates inputs against the tool's schema", async () => {
    const { call } = setup();
    const reply = await call("upsert_food_source", { ref: "FS001", name: "Rice" });
    expect(reply.http).toBe(400);
    expect(reply.body.status).toBe("invalid");
    expect(reply.body.issues.length).toBeGreaterThan(0);
  });

  it("answers 404 for an unknown tool", async () => {
    const { call } = setup();
    expect((await call("no_such_tool", {})).http).toBe(404);
  });
});
