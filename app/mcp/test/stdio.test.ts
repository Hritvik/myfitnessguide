import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CLIENT_ID, SECRET, startFakeApi, tempDir, textOf, type FakeApi } from "./harness.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

let api: FakeApi;
beforeEach(async () => {
  api = await startFakeApi();
});
afterEach(async () => {
  await api.close();
});

it("runs over stdio with config from the environment, keeping stdout for protocol and the secret out of stderr", async () => {
  // HOME points at a temp dir, so the default token path and cache path land inside it.
  const home = tempDir();
  mkdirSync(join(home, ".config", "myfitnessguide"), { recursive: true });
  writeFileSync(
    join(home, ".config", "myfitnessguide", "access-service-token.json"),
    JSON.stringify({ client_id: CLIENT_ID, client_secret: SECRET }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MAIN],
    env: { HOME: home, PATH: process.env.PATH ?? "", MYFITNESSGUIDE_API_URL: api.url },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (c) => (stderr += String(c)));
  const client = new Client({ name: "stdio-test", version: "0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const result = await client.callTool({ name: "day_totals", arguments: { member: "Hritvik" } });
  await client.close();

  expect(tools.map((t) => t.name)).toEqual(["day_totals", "log_set"]);
  expect(JSON.parse(textOf(result))).toEqual({ status: "ok", echo: { member: "Hritvik" } });
  expect(api.seen[0]!.headers["cf-access-client-id"]).toBe(CLIENT_ID);
  expect(stderr).toMatch(/myfitnessguide-mcp/);
  expect(stderr).not.toContain(SECRET);
  const { existsSync } = await import("node:fs");
  expect(existsSync(join(home, ".cache", "myfitnessguide", "tools.json"))).toBe(true);
}, 20_000);
