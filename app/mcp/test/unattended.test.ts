// Unattended mode (DECISIONS.md, decision 21): the server stamps every write
// origin `inbox` itself, registers only log_intake, household_meal and
// resolve_inbox_entry, gives each entry one data write and one close under
// fixed keys, and closes only as resolved with records.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, unattendedFrom } from "../src/config.ts";
import { UNATTENDED_WRITES } from "../src/tools.ts";
import { LISTING, connect, startFakeApi, textOf, type FakeApi, type Harness } from "./harness.ts";

let api: FakeApi;
let h: Harness | undefined;

/** A tool in the Worker's describeTools() shape; writes get the common write fields. */
const tool = (name: string, isWrite: boolean, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  name,
  group: "g",
  description: `${name}.`,
  write: isWrite,
  profiles: { remoteMember: name !== "ask_member" && name !== "query", interactiveAgent: true, unattended: !isWrite || KEPT.includes(name) },
  endpoint: `/tools/${name}`,
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      ...properties,
      ...(isWrite
        ? {
            idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
            origin: { type: "string", enum: ["live", "coach", "inbox"] },
            speaker: { type: "string" },
            reason: { type: "string", minLength: 1 },
            resolver_detail: { type: "string" },
          }
        : {}),
    },
    required: [...required, ...(isWrite ? ["idempotency_key"] : [])],
    additionalProperties: false,
  },
});

const KEPT = ["log_intake", "household_meal", "resolve_inbox_entry"];
/** Dropped by the review (C1, C2): they can touch confirmed or stateless records. */
const DROPPED = ["mark_remainder", "log_set", "log_workout", "log_cardio"];
const HIDDEN = [
  ...DROPPED,
  "confirm", "reject", "retract", "amend", "learn_alias", "forget_alias",
  "upsert_food_source", "upsert_recipe", "add_measure", "add_yield", "add_recipe_line", "remove_recipe_line",
  "add_cook_line", "remove_cook_line", "add_workout_line", "remove_workout_line", "create_workout", "save_session_as_workout",
  "start_session", "end_session", "submit_to_inbox", "log_reading", "set_target", "some_write_added_later",
];
const FULL = {
  tools: [
    LISTING.tools[0]!, // day_totals, a read
    LISTING.tools[1]!, // log_set, a write the mode drops
    tool("whoami", false),
    tool("log_intake", true, { member: { type: "string" }, items: { type: "array" } }, ["member", "items"]),
    tool("household_meal", true, { cooks: { type: "array" } }, ["cooks"]),
    tool(
      "resolve_inbox_entry",
      true,
      {
        id: { type: "integer", exclusiveMinimum: 0 },
        status: { type: "string", enum: ["resolved", "rejected"] },
        note: { type: "string", minLength: 1 },
        records: { type: "array", items: { type: "object" } },
      },
      ["id", "status", "note"],
    ),
    ...HIDDEN.filter((n) => n !== "log_set").map((n) => tool(n, true, { records: { type: "array" } })),
  ],
};

const ITEMS = { member: "Hritvik", items: [{ source: "food", food: "FS002", value: 100 }] };
const CLOSE = { id: 12, status: "resolved", note: "drafted by the scheduled run", records: [{ table: "intake_item", id: 5 }], reason: "drafted by the scheduled run" };

/** The pending entries the fake API reports (synthetic). */
let PENDING = [12, 13];
const fake = (req: { method: string; path: string; body: unknown }) =>
  req.method === "GET" && req.path === "/tools"
    ? { body: FULL }
    : req.path === "/tools/inbox_entries"
      ? { body: { status: "ok", entries: PENDING.map((id) => ({ id, status: "pending", text: `synthetic-${id}` })), truncated: false } }
      : { body: { status: "ok", echo: req.body } };

beforeEach(async () => {
  PENDING = [12, 13];
  api = await startFakeApi();
  api.handle(fake);
});

afterEach(async () => {
  await h?.close();
  h = undefined;
  await api.close();
});

/** The calls the model's tool calls made, without the server's own pending-entry checks. */
const posts = () =>
  api.seen.filter((s) => s.method === "POST" && s.path !== "/tools/inbox_entries").map((s) => ({ path: s.path, body: s.body as Record<string, unknown> }));
const checks = () => api.seen.filter((s) => s.path === "/tools/inbox_entries").map((s) => s.body);
const call = (name: string, args: Record<string, unknown>) => h!.client.callTool({ name, arguments: args });

describe("the unattended setting", () => {
  it("is on only for 1, off when unset, empty or 0, and stops startup on anything else", () => {
    expect(unattendedFrom("1")).toBe(true);
    for (const off of [undefined, "", "0"]) expect(unattendedFrom(off)).toBe(false);
    for (const typo of ["true", "yes", "on", " 1"]) expect(() => unattendedFrom(typo)).toThrow(/MYFITNESSGUIDE_UNATTENDED/);
    expect(loadConfig({ MYFITNESSGUIDE_UNATTENDED: "1" }, "/h").unattended).toBe(true);
    expect(loadConfig({ GYM_TRACKER_UNATTENDED: "1" }, "/h").unattended).toBe(true);
    expect(loadConfig({}, "/h").unattended).toBe(false);
  });

  it("prefers MyFitnessGuide configuration and accepts legacy aliases", () => {
    expect(loadConfig({ MYFITNESSGUIDE_API_URL: "https://new.example", GYM_TRACKER_API_URL: "https://old.example" }, "/h").baseUrl).toBe("https://new.example");
    expect(loadConfig({ GYM_TRACKER_API_URL: "https://old.example" }, "/h").baseUrl).toBe("https://old.example");
    expect(loadConfig({}, "/h").tokenFile).toBe("/h/.config/myfitnessguide/access-service-token.json");
    expect(loadConfig({}, "/h").cacheFile).toBe("/h/.cache/myfitnessguide/tools.json");
  });

  it("rejects conflicting unattended settings during migration", () => {
    expect(() => loadConfig({ MYFITNESSGUIDE_UNATTENDED: "", GYM_TRACKER_UNATTENDED: "1" }, "/h")).toThrow(/conflict/i);
  });

  it("the allow-list is exactly log_intake, household_meal and resolve_inbox_entry", () => {
    expect([...UNATTENDED_WRITES].sort()).toEqual([...KEPT].sort());
  });
});

describe("unattended mode: the tool list", () => {
  it("lists every read and only the three writes; the dropped training and remainder writes are absent", async () => {
    h = await connect({ baseUrl: api.url, unattended: true });
    const names = (await h.client.listTools()).tools.map((t) => t.name);

    expect(names.sort()).toEqual(["day_totals", "whoami", ...KEPT].sort());
    for (const hidden of HIDDEN) expect(names).not.toContain(hidden);
  });

  it("uses the Worker's profile metadata rather than inferring exposure from write status", async () => {
    const hiddenRead = tool("profiled_read_hidden", false);
    hiddenRead.profiles.unattended = false;
    api.handle((req) =>
      req.method === "GET"
        ? { body: { tools: [hiddenRead, { ...tool("profiled_write_allowed", true), profiles: { remoteMember: false, interactiveAgent: true, unattended: true } }] } }
        : { body: { status: "ok" } },
    );
    h = await connect({ baseUrl: api.url, unattended: true });
    expect((await h.client.listTools()).tools.map((entry) => entry.name)).toEqual(["profiled_write_allowed"]);
  });

  it("refuses a call to a hidden or dropped tool, and sends nothing to the API", async () => {
    h = await connect({ baseUrl: api.url, unattended: true });

    for (const name of ["confirm", "learn_alias", "upsert_food_source", "retract", ...DROPPED]) {
      const result = await call(name, { idempotency_key: "inbox-12-write", records: [], origin: "live", speaker: "Hritvik", reason: "x" });
      expect(result.isError, name).toBe(true);
      expect(textOf(result)).toMatch(new RegExp(`No tool named ${name}.*unattended`));
    }
    expect(posts()).toEqual([]);
  });

  it("asks for neither origin nor speaker, only the fixed key, and says drafts confirm after 48 h", async () => {
    h = await connect({ baseUrl: api.url, unattended: true });
    const { tools } = await h.client.listTools();

    for (const t of tools.filter((t) => KEPT.includes(t.name))) {
      const schema = t.inputSchema as { required: string[]; properties: Record<string, { pattern?: string }> };
      expect(Object.keys(schema.properties), t.name).not.toContain("origin");
      expect(Object.keys(schema.properties), t.name).not.toContain("speaker");
      expect(schema.required, t.name).toContain("idempotency_key");
      expect(schema.required, t.name).not.toContain("origin");
      expect(t.description, t.name).toMatch(/origin inbox/);
      expect(t.description, t.name).toMatch(/48 h unless the member confirms, changes or rejects/);
      const pattern = new RegExp(schema.properties.idempotency_key!.pattern!);
      const own = t.name === "resolve_inbox_entry" ? "inbox-12-close" : "inbox-12-write";
      const other = t.name === "resolve_inbox_entry" ? "inbox-12-write" : "inbox-12-close";
      expect(pattern.test(own), t.name).toBe(true);
      expect(pattern.test(other), t.name).toBe(false);
      expect(pattern.test("inbox-12-0"), t.name).toBe(false);
    }
    // Reads are untouched.
    expect(tools.find((t) => t.name === "day_totals")!.inputSchema).toEqual(LISTING.tools[0]!.input_schema);
  });

  it("narrows resolve_inbox_entry's schema to resolved, with at least one record", async () => {
    h = await connect({ baseUrl: api.url, unattended: true });
    const close = (await h.client.listTools()).tools.find((t) => t.name === "resolve_inbox_entry")!;
    const schema = close.inputSchema as { required: string[]; properties: Record<string, Record<string, unknown>> };
    expect(schema.properties.status).toMatchObject({ const: "resolved" });
    expect(schema.properties.records).toMatchObject({ minItems: 1 });
    expect(schema.required).toEqual(expect.arrayContaining(["records", "status", "id"]));
  });
});

describe("unattended mode: the mode probe", () => {
  it("adds unattended: true to whoami's ok reply, and says so in its description", async () => {
    api.handle((req) =>
      req.method === "GET" ? { body: FULL } : { body: { status: "ok", member: null, members: ["Hritvik"] } },
    );
    h = await connect({ baseUrl: api.url, unattended: true });
    const whoami = (await h.client.listTools()).tools.find((t) => t.name === "whoami")!;
    expect(whoami.description).toMatch(/UNATTENDED.*unattended: true/);

    const result = await call("whoami", {});
    expect(JSON.parse(textOf(result))).toEqual({ status: "ok", member: null, members: ["Hritvik"], unattended: true });
  });

  it("never adds it in interactive mode, nor to an error reply", async () => {
    api.handle((req) => (req.method === "GET" ? { body: FULL } : { body: { status: "ok", member: null } }));
    h = await connect({ baseUrl: api.url });
    expect(JSON.parse(textOf(await call("whoami", {})))).toEqual({ status: "ok", member: null });
    await h.close();

    api.handle((req) => (req.method === "GET" ? { body: FULL } : { status: 500, body: { status: "error", error: { code: "boom", message: "x" } } }));
    h = await connect({ baseUrl: api.url, unattended: true });
    expect(textOf(await call("whoami", {}))).not.toMatch(/unattended/);
  });
});

describe("unattended mode: writes", () => {
  it("sends every write as origin inbox with no speaker and the entry's key, whatever the model sends", async () => {
    h = await connect({ baseUrl: api.url, unattended: true, sessionId: "u1" });

    await call("log_intake", { ...ITEMS, idempotency_key: "inbox-12-write", origin: "live", speaker: "Hritvik" });
    await call("household_meal", { cooks: [], idempotency_key: "inbox-13-write", origin: "coach" });
    await call("resolve_inbox_entry", { ...CLOSE, idempotency_key: "inbox-12-close", origin: "app", speaker: "Asha" });
    await call("day_totals", { member: "Hritvik" });

    const sent = posts();
    expect(sent.map((p) => [p.path, p.body.idempotency_key])).toEqual([
      ["/tools/log_intake", "inbox:inbox-12-write"],
      ["/tools/household_meal", "inbox:inbox-13-write"],
      ["/tools/resolve_inbox_entry", "inbox:inbox-12-close"],
      ["/tools/day_totals", undefined],
    ]);
    for (const w of sent.slice(0, 3)) {
      expect(w.body.origin, w.path).toBe("inbox");
      expect(w.body, w.path).not.toHaveProperty("speaker");
    }
    expect(sent[3]!.body).toEqual({ member: "Hritvik" });
  });

  it("sends the same API key for the same entry in every run, so a rerun replays instead of drafting twice", async () => {
    const write = { ...ITEMS, idempotency_key: "inbox-12-write" };
    h = await connect({ baseUrl: api.url, unattended: true, sessionId: "run-1" });
    await call("log_intake", write);
    await h.close();
    h = await connect({ baseUrl: api.url, unattended: true, sessionId: "run-2" });
    await call("log_intake", write);
    await call("household_meal", { cooks: [], idempotency_key: "inbox-12-write" });

    // One key per entry for any data write: the API replays the first and refuses the household_meal
    // as idempotency_key_reused (Worker test: unattended-inbox.tools.test.ts).
    expect(posts().map((p) => p.body.idempotency_key)).toEqual(["inbox:inbox-12-write", "inbox:inbox-12-write", "inbox:inbox-12-write"]);
  });

  it.each([
    ["no key", undefined],
    ["a free key", "a"],
    ["a per-span key", "inbox-12-0"],
    ["a per-run part", "inbox-12-run2"],
    ["the close key on a data write", "inbox-12-close"],
    ["entry 0", "inbox-0-write"],
    ["a non-numeric entry", "inbox-x-write"],
    ["a session-scoped key", "cc:sess:inbox-12-write"],
    ["trailing space", "inbox-12-write "],
    ["upper case", "INBOX-12-WRITE"],
  ])("refuses a data write with %s, sending nothing", async (_name, key) => {
    h = await connect({ baseUrl: api.url, unattended: true });
    const result = await call("log_intake", { ...ITEMS, ...(key === undefined ? {} : { idempotency_key: key }) });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/must be exactly inbox-<entry id>-write.*Nothing was written/);
    expect(posts()).toEqual([]);
  });

  it.each([
    ["the write key", { ...CLOSE, idempotency_key: "inbox-12-write" }, /exactly inbox-<entry id>-close/],
    ["a per-span key", { ...CLOSE, idempotency_key: "inbox-12-0" }, /exactly inbox-<entry id>-close/],
    ["another entry's key", { ...CLOSE, idempotency_key: "inbox-13-close" }, /id must be the entry its key names \(13\)/],
    ["status rejected", { ...CLOSE, status: "rejected", records: undefined, idempotency_key: "inbox-12-close" }, /only closes an entry as resolved/],
    ["no status", { ...CLOSE, status: undefined, idempotency_key: "inbox-12-close" }, /only closes an entry as resolved/],
    ["resolved with no records", { ...CLOSE, records: undefined, idempotency_key: "inbox-12-close" }, /only with the records/],
    ["resolved with an empty records list", { ...CLOSE, records: [], idempotency_key: "inbox-12-close" }, /only with the records/],
  ])("refuses a close with %s, sending nothing", async (_name, args, why) => {
    h = await connect({ baseUrl: api.url, unattended: true });
    const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
    const result = await call("resolve_inbox_entry", clean);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(why);
    expect(textOf(result)).toMatch(/Nothing was written/);
    expect(posts()).toEqual([]);
  });

  it("starts from the cached listing in the same mode, hiding the same tools", async () => {
    const first = await connect({ baseUrl: api.url });
    await first.close();
    await api.close();

    h = await connect({ baseUrl: api.url, dir: first.dir, unattended: true });
    const names = (await h.client.listTools()).tools.map((t) => t.name);

    expect(names.sort()).toEqual(["day_totals", "whoami", ...KEPT].sort());
    api = await startFakeApi();
  });
});

describe("interactive mode (the default)", () => {
  it("still lists every tool, passes origin, speaker and any key through, and allows a rejection", async () => {
    h = await connect({ baseUrl: api.url, sessionId: "i1" });
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(FULL.tools.map((t) => t.name));

    await call("confirm", { records: [], idempotency_key: "k", origin: "live", speaker: "Hritvik" });
    await call("resolve_inbox_entry", { id: 12, status: "rejected", note: "x", idempotency_key: "r", origin: "live", speaker: "Hritvik" });
    expect(posts()[0]!.body).toMatchObject({ origin: "live", speaker: "Hritvik", idempotency_key: "cc:i1:k" });
    expect(posts()[1]!.body).toMatchObject({ status: "rejected", idempotency_key: "cc:i1:r" });
  });
});

describe("unattended mode: the data write's entry must be pending (review N1)", () => {
  it("reads the pending entries once before each data write, and not before a close or a read", async () => {
    h = await connect({ baseUrl: api.url, unattended: true });
    await call("log_intake", { ...ITEMS, idempotency_key: "inbox-12-write" });
    await call("household_meal", { cooks: [], idempotency_key: "inbox-13-write" });
    await call("resolve_inbox_entry", { ...CLOSE, idempotency_key: "inbox-12-close" });
    await call("day_totals", { member: "Hritvik" });

    expect(checks()).toEqual([{ status: "pending" }, { status: "pending" }]);
    expect(posts().map((p) => p.path)).toEqual(["/tools/log_intake", "/tools/household_meal", "/tools/resolve_inbox_entry", "/tools/day_totals"]);
  });

  it("refuses a data write keyed to an entry that isn't pending (another entry's id, or one already closed), writing nothing", async () => {
    h = await connect({ baseUrl: api.url, unattended: true });
    for (const id of [99999, 14]) {
      const result = await call("log_intake", { ...ITEMS, idempotency_key: `inbox-${id}-write` });
      expect(result.isError, String(id)).toBe(true);
      expect(textOf(result)).toMatch(new RegExp(`entry ${id} is not a pending Inbox entry`));
      expect(textOf(result)).toMatch(/Leave the entry pending\. Nothing was written\./);
    }
    // Entry 12 is closed between runs: it leaves the pending list, and its write is refused too.
    PENDING = [13];
    const closed = await call("household_meal", { cooks: [], idempotency_key: "inbox-12-write" });
    expect(closed.isError).toBe(true);
    expect(textOf(closed)).toMatch(/entry 12 is not a pending Inbox entry/);
    expect(posts()).toEqual([]);
  });

  it("refuses the write when the pending entries can't be read, writing nothing", async () => {
    api.handle((req) => (req.path === "/tools/inbox_entries" ? { status: 500, text: "boom" } : fake(req)));
    h = await connect({ baseUrl: api.url, unattended: true });
    const result = await call("log_intake", { ...ITEMS, idempotency_key: "inbox-12-write" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/could not read the pending Inbox entries to check entry 12.*Nothing was written/s);
    expect(posts()).toEqual([]);
  });

  it("never reads the pending entries in interactive mode", async () => {
    h = await connect({ baseUrl: api.url });
    await call("log_intake", { ...ITEMS, idempotency_key: "k", origin: "live", speaker: "Hritvik" });
    expect(checks()).toEqual([]);
  });
});

describe("unattended mode: the hints", () => {
  it("on idempotency_key_reused says the entry was written: no new key, leave it pending and stop", async () => {
    api.handle((req) =>
      req.path === "/tools/log_intake"
        ? { status: 409, body: { status: "error", error: { code: "idempotency_key_reused", message: "idempotency key inbox:inbox-12-write was used for a different request" } } }
        : fake(req),
    );
    h = await connect({ baseUrl: api.url, unattended: true });
    const out = textOf(await call("log_intake", { ...ITEMS, idempotency_key: "inbox-12-write" }));
    expect(out).toContain("This entry was already written. Do not retry under another key; leave it pending and stop.");
    expect(out).not.toMatch(/new idempotency_key/);
  });

  it("on needs_clarification says nobody can be asked: leave the entry pending", async () => {
    api.handle((req) =>
      req.path === "/tools/log_intake" ? { body: { status: "needs_clarification", question: "Dry or cooked?", options: ["dry", "cooked"] } } : fake(req),
    );
    h = await connect({ baseUrl: api.url, unattended: true });
    const out = textOf(await call("log_intake", { ...ITEMS, idempotency_key: "inbox-12-write" }));
    expect(out).toMatch(/nothing was written.*leave this entry pending/s);
    expect(out).not.toMatch(/ask the user/i);
  });

  it("keeps the interactive hints in interactive mode", async () => {
    api.handle((req) =>
      req.path === "/tools/log_intake"
        ? { status: 409, body: { status: "error", error: { code: "idempotency_key_reused", message: "x" } } }
        : fake(req),
    );
    h = await connect({ baseUrl: api.url });
    expect(textOf(await call("log_intake", { ...ITEMS, idempotency_key: "k", origin: "live", speaker: "Hritvik" }))).toMatch(/new idempotency_key/);
  });
});
