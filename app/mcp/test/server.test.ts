import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CLIENT_ID, LISTING, SECRET, connect, startFakeApi, textOf, type FakeApi, type FakeResponse, type Harness } from "./harness.ts";

let api: FakeApi;
let h: Harness | undefined;

beforeEach(async () => {
  api = await startFakeApi();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
  await api.close();
});

describe("tool registration", () => {
  it("lists one MCP tool per API tool, with the API's description and input schema", async () => {
    h = await connect({ baseUrl: api.url });
    const { tools } = await h.client.listTools();

    expect(tools.map((t) => t.name)).toEqual(["day_totals", "log_set"]);
    const dayTotals = tools.find((t) => t.name === "day_totals")!;
    expect(dayTotals.description).toContain("Totals for one member's day.");
    expect(dayTotals.inputSchema).toMatchObject({
      type: "object",
      properties: { member: { type: "string" }, date: { type: "string" } },
      required: ["member"],
    });
  });

  it("fails closed when the Worker returns an unclassified tool", async () => {
    api.handle(() => ({ body: { tools: [{ ...LISTING.tools[0], profiles: undefined }] } }));
    await expect(connect({ baseUrl: api.url })).rejects.toThrow(/day_totals.*profiles|profiles.*day_totals/i);
  });
});

describe("tool list cache", () => {
  it("caches the last good listing to the cache file", async () => {
    h = await connect({ baseUrl: api.url });
    expect(JSON.parse(readFileSync(h.cacheFile, "utf8"))).toEqual(LISTING);
  });

  it("starts from the cache when the API is unreachable, and says so on the log", async () => {
    const first = await connect({ baseUrl: api.url });
    await first.close();
    await api.close();

    h = await connect({ baseUrl: api.url, dir: first.dir });
    const { tools } = await h.client.listTools();

    expect(tools.map((t) => t.name)).toEqual(["day_totals", "log_set"]);
    expect(h.logs.join("\n")).toMatch(/unreachable|could not/i);
    expect(h.logs.join("\n")).toMatch(/cache/i);
    api = await startFakeApi(); // for afterEach
  });

  it("starts from the cache when Access refuses GET /tools", async () => {
    const first = await connect({ baseUrl: api.url });
    await first.close();
    api.handle(() => ({ status: 302, headers: { location: "https://late-frog.cloudflareaccess.com/login" }, text: "" }));

    h = await connect({ baseUrl: api.url, dir: first.dir });
    const { tools } = await h.client.listTools();

    expect(tools).toHaveLength(2);
    expect(h.logs.join("\n")).toMatch(/Access refused/);
  });

  it("refuses to start with neither the API nor a cache", async () => {
    await api.close();
    await expect(connect({ baseUrl: api.url })).rejects.toThrow(/no cached tool list/i);
    api = await startFakeApi();
  });
});

describe("calling a tool", () => {
  it("POSTs the arguments to /tools/<name> and returns an ok result as JSON text", async () => {
    const answer = { status: "ok", member: "Hritvik", so_far: { kcal: 1234 }, left: { kcal: 966 } };
    api.handle((req) => (req.method === "GET" ? { body: LISTING } : { body: answer }));
    h = await connect({ baseUrl: api.url });

    const result = await h.client.callTool({ name: "day_totals", arguments: { member: "Hritvik", date: "2026-10-06" } });

    const post = api.seen.find((s) => s.method === "POST")!;
    expect(post.path).toBe("/tools/day_totals");
    expect(post.body).toEqual({ member: "Hritvik", date: "2026-10-06" });
    expect(post.headers["cf-access-client-id"]).toBe(CLIENT_ID);
    expect(post.headers["cf-access-client-secret"]).toBe(SECRET);
    expect(post.headers["user-agent"]).toMatch(/^myfitnessguide-mcp\//);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual(answer);
  });

  it("leads a needs_clarification result with the question and the options to ask, not as an error", async () => {
    api.handle((req) =>
      req.method === "GET"
        ? { body: LISTING }
        : {
            body: {
              status: "needs_clarification",
              reason: "ambiguous_food",
              question: "Which rice did you mean?",
              options: ["rice, dry", "rice, cooked"],
              path: ["lines", 0, "food"],
            },
          },
    );
    h = await connect({ baseUrl: api.url });

    const result = await h.client.callTool({ name: "day_totals", arguments: { member: "Hritvik" } });
    const out = textOf(result);
    const lines = out.split("\n");

    expect(result.isError).toBeFalsy();
    expect(lines[0]).toMatch(/needs clarification/i);
    expect(lines[0]).toMatch(/nothing (was )?written/i);
    expect(lines[1]).toBe("Ask the user: Which rice did you mean?");
    expect(lines[2]).toBe("Options:");
    expect(lines[3]).toBe("  1. rice, dry");
    expect(lines[4]).toBe("  2. rice, cooked");
    expect(out).toContain("lines.0.food");
    expect(out).toMatch(/same idempotency_key/);
  });

  async function callWith(reply: FakeResponse) {
    api.handle((req) => (req.method === "GET" ? { body: LISTING } : reply));
    h = await connect({ baseUrl: api.url });
    return h.client.callTool({ name: "day_totals", arguments: { member: "Hritvik" } });
  }

  it("returns invalid input as an error listing each issue with its field", async () => {
    const result = await callWith({
      status: 400,
      body: {
        status: "invalid",
        issues: [
          { path: ["member"], message: "Invalid input: expected string, received number", code: "invalid_type" },
          { path: [], message: 'Unrecognized key: "membr"', code: "unrecognized_keys" },
        ],
      },
    });

    expect(result.isError).toBe(true);
    const out = textOf(result);
    expect(out).toMatch(/^Invalid input/);
    expect(out).toContain("member: Invalid input: expected string, received number");
    expect(out).toContain('(input): Unrecognized key: "membr"');
  });

  it("returns an API error as an error with its code and message", async () => {
    const result = await callWith({
      status: 404,
      body: { status: "error", error: { code: "not_found", message: "no session 99" } },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Error not_found \(HTTP 404\): no session 99/);
  });

  it("tells the model to pick a new key when an idempotency key was reused for a different request", async () => {
    const result = await callWith({
      status: 409,
      body: { status: "error", error: { code: "idempotency_key_reused", message: "idempotency key k1 was used for a different request" } },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/new idempotency_key/);
  });

  it("returns a non-2xx reply without JSON as an error with the status and the start of the body", async () => {
    const result = await callWith({ status: 500, text: "worker threw: boom" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/HTTP 500.*worker threw: boom/s);
  });

  const ACCESS = "Access refused: check the service token or the Agent policy (must be Service Auth)";

  it("turns an Access login redirect into a clear Access-refused error, without following it", async () => {
    const result = await callWith({
      status: 302,
      headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" },
      text: "",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(ACCESS);
    expect(api.seen.filter((s) => s.method === "POST")).toHaveLength(1);
  });

  it("turns an Access 403 HTML page into the same Access-refused error", async () => {
    const result = await callWith({
      status: 403,
      headers: { "content-type": "text/html; charset=UTF-8" },
      text: "<!DOCTYPE html><html><title>Forbidden | Cloudflare Access</title></html>",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(ACCESS);
    expect(textOf(result)).not.toContain("<html");
  });

  it("gives up on a request that hangs past the timeout, with the same retry advice", async () => {
    api.handle((req) => (req.method === "GET" ? { body: LISTING } : { delayMs: 2_000, body: { status: "ok" } }));
    h = await connect({ baseUrl: api.url, timeoutMs: 200 });

    const result = await h.client.callTool({ name: "day_totals", arguments: { member: "Hritvik" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/timed out/i);
    expect(textOf(result)).toMatch(/same idempotency_key/);
  });

  it("says when the API can't be reached, and to retry with the same idempotency_key", async () => {
    h = await connect({ baseUrl: api.url });
    await api.close();

    const result = await h.client.callTool({ name: "day_totals", arguments: { member: "Hritvik" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/could not reach/i);
    expect(textOf(result)).toMatch(/same idempotency_key/);
    api = await startFakeApi();
  });
});

describe("write tools: idempotency, speaker and origin", () => {
  const SET = { session_id: 7, reps: 8, speaker: "Hritvik", origin: "coach" };

  it("asks the model for an idempotency key, the speaker and a live/coach origin, and says how to use them", async () => {
    h = await connect({ baseUrl: api.url });
    const { tools } = await h.client.listTools();
    const logSet = tools.find((t) => t.name === "log_set")!;
    const schema = logSet.inputSchema as { required: string[]; properties: Record<string, { enum?: string[]; description?: string }> };

    expect(schema.required).toEqual(expect.arrayContaining(["session_id", "idempotency_key", "speaker", "origin"]));
    expect(schema.properties.origin!.enum).toEqual(["live", "coach"]);
    expect(logSet.description).toContain("Log one set.");
    expect(logSet.description).toMatch(/reuse the same idempotency_key/i);
    expect(logSet.description).toMatch(/new idempotency_key for each new write/i);
    expect(logSet.description).toMatch(/speaker/);
    expect(logSet.description).toMatch(/coach.*live|live.*coach/s);
  });

  it("leaves read tools' schemas and descriptions as the API gave them", async () => {
    h = await connect({ baseUrl: api.url });
    const { tools } = await h.client.listTools();
    const dayTotals = tools.find((t) => t.name === "day_totals")!;

    expect(dayTotals.description).toBe("Totals for one member's day.");
    expect(dayTotals.inputSchema).toEqual(LISTING.tools[0]!.input_schema);
  });

  it("sends a retry of the same logical write with the same API key, and passes speaker and origin through", async () => {
    h = await connect({ baseUrl: api.url, sessionId: "abc123" });

    await h.client.callTool({ name: "log_set", arguments: { ...SET, idempotency_key: "bench-set-3" } });
    await h.client.callTool({ name: "log_set", arguments: { ...SET, idempotency_key: "bench-set-3" } });
    await h.client.callTool({ name: "log_set", arguments: { ...SET, idempotency_key: "bench-set-4" } });

    const posts = api.seen.filter((s) => s.method === "POST").map((s) => s.body as Record<string, unknown>);
    expect(posts[0]!.idempotency_key).toBe(posts[1]!.idempotency_key);
    expect(posts[2]!.idempotency_key).not.toBe(posts[0]!.idempotency_key);
    expect(posts[0]).toMatchObject({ session_id: 7, reps: 8, speaker: "Hritvik", origin: "coach" });
  });

  it("scopes the model's key to this server session, so a short key from another session never collides", async () => {
    h = await connect({ baseUrl: api.url, sessionId: "one" });
    await h.client.callTool({ name: "log_set", arguments: { ...SET, idempotency_key: "set-1" } });
    await h.close();
    h = await connect({ baseUrl: api.url, sessionId: "two" });
    await h.client.callTool({ name: "log_set", arguments: { ...SET, idempotency_key: "set-1" } });

    const keys = api.seen.filter((s) => s.method === "POST").map((s) => (s.body as { idempotency_key: string }).idempotency_key);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toContain("set-1");
    for (const k of keys) expect(k.length).toBeLessThanOrEqual(200);
  });

  it("tells the model when the API replayed an earlier write instead of writing again", async () => {
    api.handle((req) =>
      req.method === "GET"
        ? { body: LISTING }
        : { headers: { "idempotent-replay": "true" }, body: { status: "ok", write_id: 41, set_id: 9 } },
    );
    h = await connect({ baseUrl: api.url });

    const result = await h.client.callTool({ name: "log_set", arguments: { ...SET, idempotency_key: "k" } });

    expect(result.isError).toBeFalsy();
    const [first, ...rest] = textOf(result).split("\n");
    expect(first).toMatch(/already applied.*nothing new was written/i);
    expect(JSON.parse(rest.join("\n"))).toEqual({ status: "ok", write_id: 41, set_id: 9 });
  });
});

describe("the service-token secret", () => {
  it("never appears in any log line or tool result, whatever goes wrong", async () => {
    const logs: string[] = [];
    const outputs: string[] = [];
    const call = async (args: Record<string, unknown> = { member: "Hritvik" }) => {
      const r = await h!.client.callTool({ name: "day_totals", arguments: args });
      outputs.push(textOf(r));
    };

    // A good start, then every kind of reply.
    h = await connect({ baseUrl: api.url, logs });
    const replies: FakeResponse[] = [
      { body: { status: "ok", x: 1 } },
      { body: { status: "needs_clarification", question: "Which?", options: ["a"] } },
      { status: 400, body: { status: "invalid", issues: [{ path: ["member"], message: "bad" }] } },
      { status: 403, body: { status: "error", error: { code: "forbidden", message: "not a known service token" } } },
      { status: 302, headers: { location: "https://x.cloudflareaccess.com/login" }, text: "" },
      { status: 403, headers: { "content-type": "text/html" }, text: "<html>Forbidden</html>" },
      { status: 500, text: "boom" },
    ];
    for (const r of replies) {
      api.handle((req) => (req.method === "GET" ? { body: LISTING } : r));
      await call();
    }
    const dir = h.dir;
    await h.close();

    // Access refuses GET /tools: start from the cache.
    api.handle(() => ({ status: 403, headers: { "content-type": "text/html" }, text: "<html>Forbidden</html>" }));
    h = await connect({ baseUrl: api.url, dir, logs });
    await h.close();

    // The API goes away: start from the cache, then a call can't reach it.
    await api.close();
    h = await connect({ baseUrl: api.url, dir, logs });
    await call();
    await h.close();
    h = undefined;

    // Neither API nor cache.
    const err = await connect({ baseUrl: api.url, logs }).catch((e: Error) => e);
    outputs.push(String(err));

    // A malformed token file whose text contains the secret.
    const err2 = await connect({ baseUrl: api.url, logs, tokenText: `{"client_id":"x","client_secret":"${SECRET}"` }).catch((e: Error) => e);
    outputs.push(String(err2));
    // A token file holding only the bare secret (JSON.parse quotes the start of bad input).
    const err3 = await connect({ baseUrl: api.url, logs, tokenText: SECRET }).catch((e: Error) => e);
    outputs.push(String(err3));

    api = await startFakeApi();
    expect(logs.length).toBeGreaterThan(0);
    for (const line of [...logs, ...outputs]) expect(line).not.toContain(SECRET.slice(0, 8));
  });
});

describe("request headers", () => {
  it("sends the service token and a descriptive User-Agent on GET /tools", async () => {
    h = await connect({ baseUrl: api.url });
    const get = api.seen.find((s) => s.method === "GET" && s.path === "/tools")!;

    expect(get.headers["cf-access-client-id"]).toBe(CLIENT_ID);
    expect(get.headers["cf-access-client-secret"]).toBe(SECRET);
    expect(get.headers["user-agent"]).toMatch(/^myfitnessguide-mcp\/0\.1\.0 \(.+\)$/);
  });
});
