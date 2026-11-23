import { timingSafeEqual } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseIdentity } from "../src/auth";
import entry, { type DevEnv } from "../src/dev-entry";
import { memberOf, sampleDb, whoamiAt } from "./local-members";

const TOKEN = "0123456789abcdef".repeat(4);
const ASHA = "member:asha@example.com";

// Workers' crypto.subtle has timingSafeEqual; Node's doesn't, so the tests lend it Node's own.
beforeAll(() => {
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => timingSafeEqual(a, b),
    configurable: true,
  });
});
afterAll(() => {
  delete (crypto.subtle as unknown as Record<string, unknown>).timingSafeEqual;
});

const env = (over: Partial<DevEnv> = {}): DevEnv => ({ DB: sampleDb(), LOCAL_DEV_IDENTITY: "header", LOCAL_IDENTITY_TOKEN: TOKEN, ...over });
const ask = async (host: string, headers: Record<string, string>, e: DevEnv = env()) => memberOf(await entry.fetch(whoamiAt(host, headers), e));
/** The household's date on the wall clock, read before and after a request: a run across IST midnight sees either. */
const istToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const signed = (identity: string, token = TOKEN) => ({ "X-Local-Identity": identity, "X-Local-Identity-Token": token });

describe("the dev entry, every lock held (e2e spec §3)", () => {
  it("signs Asha in on 127.0.0.1 and on localhost", async () => {
    expect(await ask("127.0.0.1:8787", signed(ASHA))).toBe("Asha");
    expect(await ask("localhost:8787", signed(ASHA))).toBe("Asha");
  });

  it("reads the header name in any case", async () => {
    expect(await ask("127.0.0.1:8787", { "x-LOCAL-identity": ASHA, "X-Local-Identity-Token": TOKEN })).toBe("Asha");
  });

  it("an email in another case is the same member (the Worker's lookup ignores case)", async () => {
    expect(await ask("127.0.0.1:8787", signed("member:Asha@Example.COM"))).toBe("Asha");
  });
});

describe("lock 1: LOCAL_DEV_IDENTITY must be exactly header", () => {
  it("any other value passes the request unchanged to the shipped entry", async () => {
    expect(await ask("127.0.0.1:8787", signed(ASHA), env({ LOCAL_DEV_IDENTITY: "member:kabir@example.com" }))).toBe("Kabir");
    for (const value of ["Header", "header ", "", "HEADER"]) {
      expect(await ask("127.0.0.1:8787", signed(ASHA), env({ LOCAL_DEV_IDENTITY: value })), JSON.stringify(value)).toBe(401);
    }
    expect(await ask("127.0.0.1:8787", signed(ASHA), env({ LOCAL_DEV_IDENTITY: undefined }))).toBe(401);
  });
});

describe("lock 2: the host", () => {
  it("[::1], a public name and a lookalike are 401", async () => {
    for (const host of ["[::1]:8787", "gym.example.com", "127.0.0.1.example.com", "localhost.example.com"]) {
      expect(await ask(host, signed(ASHA)), host).toBe(401);
    }
  });
});

describe("lock 3: the token", () => {
  it("missing, short, wrong, upper-cased or padded is 401", async () => {
    expect(await ask("127.0.0.1:8787", { "X-Local-Identity": ASHA })).toBe(401);
    // Fetch (and workerd's HTTP parser) strips a value's leading and trailing spaces and tabs, so a padded
    // token reaches the Worker as the token itself; the padding never gets as far as the comparison.
    expect(new Headers({ "X-Local-Identity-Token": `${TOKEN} \t` }).get("X-Local-Identity-Token")).toBe(TOKEN);
    const split = `${TOKEN.slice(0, 32)} ${TOKEN.slice(32)}`;
    for (const token of [TOKEN.slice(0, 63), `${TOKEN.slice(0, 63)} `, TOKEN.slice(0, 32), "f".repeat(64), TOKEN.toUpperCase(), split, `${TOKEN}0`, ""]) {
      expect(await ask("127.0.0.1:8787", signed(ASHA, token)), JSON.stringify(token)).toBe(401);
    }
  });

  it("a LOCAL_IDENTITY_TOKEN that isn't 64 hex characters refuses every request", async () => {
    for (const bad of [undefined, "", "short", "g".repeat(64), "0".repeat(63)]) {
      const e = env({ LOCAL_IDENTITY_TOKEN: bad });
      expect(await ask("127.0.0.1:8787", signed(ASHA, bad ?? ""), e), JSON.stringify(bad)).toBe(401);
    }
  });

  it("without crypto.subtle.timingSafeEqual it refuses rather than compare another way", async () => {
    const saved = (crypto.subtle as unknown as Record<string, unknown>).timingSafeEqual;
    delete (crypto.subtle as unknown as Record<string, unknown>).timingSafeEqual;
    try {
      expect(await ask("127.0.0.1:8787", signed(ASHA))).toBe(401);
    } finally {
      Object.defineProperty(crypto.subtle, "timingSafeEqual", { value: saved, configurable: true });
    }
  });
});

describe("the identity header", () => {
  it("missing, empty, service:, Member:, or padded is 401, never a default member", async () => {
    expect(await ask("127.0.0.1:8787", { "X-Local-Identity-Token": TOKEN })).toBe(401);
    // A trailing space or tab never reaches the Worker (Fetch strips it, as above); were one to, the single
    // definition of a well-formed identity refuses it.
    expect(new Headers({ "X-Local-Identity": `${ASHA} \t` }).get("X-Local-Identity")).toBe(ASHA);
    for (const padded of [`${ASHA} `, `${ASHA}\t`, ` ${ASHA}`]) expect(parseIdentity(padded), JSON.stringify(padded)).toBeNull();
    for (const value of ["", "service:x", "Member:asha@example.com", "MEMBER:asha@example.com", "member: asha@example.com", `${ASHA}\t,`, "member:", "asha@example.com"]) {
      expect(await ask("127.0.0.1:8787", signed(value)), JSON.stringify(value)).toBe(401);
    }
  });

  it("a duplicated header is 401 (Fetch joins it with a comma and a space)", async () => {
    const headers = new Headers([["X-Local-Identity", ASHA], ["X-Local-Identity", "member:kabir@example.com"], ["X-Local-Identity-Token", TOKEN]]);
    expect(headers.get("X-Local-Identity")).toBe("member:asha@example.com, member:kabir@example.com");
    const request = new Request("http://127.0.0.1:8787/tools/whoami", { method: "POST", body: "{}", headers });
    expect(await memberOf(await entry.fetch(request, env()))).toBe(401);
  });

  it("an email with a comma, a space or a NUL is 401", async () => {
    for (const value of ["member:asha,x@example.com", "member:asha x@example.com", "member:asha\u0000@example.com"]) {
      // Headers refuses a NUL itself, so nothing is sent; only building the request may throw, never the entry.
      let request: Request;
      try {
        request = whoamiAt("127.0.0.1:8787", signed(value));
      } catch {
        expect(value, "only the NUL is refused by Headers").toContain("\u0000");
        continue;
      }
      expect(await memberOf(await entry.fetch(request, env())), JSON.stringify(value)).toBe(401);
    }
  });
});

describe("a well-formed email that isn't an active member", () => {
  it("is 403 forbidden, through the Worker's own member check", async () => {
    for (const email of ["stranger@example.com", "ira@example.com"]) {
      const response = await entry.fetch(whoamiAt("127.0.0.1:8787", signed(`member:${email}`)), env());
      expect(response.status, email).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    }
  });
});

describe("no CORS", () => {
  it("an OPTIONS preflight from another origin gets no Access-Control-Allow-* header", async () => {
    const preflight = new Request("http://127.0.0.1:8787/tools/whoami", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-local-identity, x-local-identity-token" },
    });
    const response = await entry.fetch(preflight, env());
    expect([...response.headers.keys()].filter((k) => k.startsWith("access-control-allow"))).toEqual([]);
  });
});

describe("LOCAL_FIXED_NOW: the test household's fixed clock (worker decision 162)", () => {
  const FIXED = "2026-10-07T04:30:00.000Z"; // Wed 7 Oct 2026, 10:00 in Asia/Kolkata
  const call = async (tool: string, body: Record<string, unknown>, e: DevEnv) =>
    entry.fetch(new Request(`http://127.0.0.1:8787/tools/${tool}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...signed(ASHA) } }), e);

  it("today and every write's time read the fixed instant, in the household's zone", async () => {
    const e = env({ LOCAL_FIXED_NOW: FIXED });
    expect(((await (await call("whoami", {}, e)).json()) as { today: string }).today).toBe("2026-10-07");
    // 20:00Z is already 01:30 the next day in Asia/Kolkata.
    expect(((await (await call("whoami", {}, env({ LOCAL_FIXED_NOW: "2026-10-07T20:00:00Z" }))).json()) as { today: string }).today).toBe("2026-10-08");
    const r = await call("submit_feedback", { type: "idea", text: "A fixed clock", idempotency_key: "fixed-1" }, e);
    expect(r.status).toBe(200);
    const db = e.DB as unknown as { test: { db: { prepare(sql: string): { get(): unknown } } } };
    expect(db.test.db.prepare("SELECT created_at FROM feedback").get()).toEqual({ created_at: "2026-10-07T04:30:00Z" });
    expect(db.test.db.prepare("SELECT at FROM write_log ORDER BY id DESC LIMIT 1").get()).toEqual({ at: "2026-10-07T04:30:00Z" });
  });

  it("unset, the clock is the wall clock, as before", async () => {
    const before = istToday();
    const today = ((await (await call("whoami", {}, env())).json()) as { today: string }).today;
    expect([before, istToday()]).toContain(today);
  });

  it("a value that isn't an ISO instant refuses every request rather than run on the wall clock", async () => {
    for (const bad of ["", "yesterday", "2026-10-07", "2026-13-40T00:00:00Z"]) {
      const r = await call("whoami", {}, env({ LOCAL_FIXED_NOW: bad }));
      expect(r.status, JSON.stringify(bad)).toBe(500);
      expect(await r.text()).toContain("LOCAL_FIXED_NOW");
    }
  });

  it("the cron's auto-confirm runs at the fixed instant, not the trigger's wall-clock time", async () => {
    const db = sampleDb();
    // 49 h before the fixed instant, Kabir logs a yogurt for Asha: a draft about another member.
    const before = env({ DB: db, LOCAL_FIXED_NOW: "2026-10-05T03:30:00.000Z" });
    const as = (who: string, tool: string, body: Record<string, unknown>) =>
      entry.fetch(new Request(`http://127.0.0.1:8787/tools/${tool}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...signed(`member:${who}@example.com`) } }), before);
    const food = await as("asha", "upsert_food_source", { name: "Yogurt", state: "as_sold", reference_amount: 100, reference_unit: "g", kcal: 100, protein_g: 10, carbs_g: 6, fat_g: 3, idempotency_key: "f-1" });
    expect(food.status, await food.clone().text()).toBe(200);
    const logged = await as("kabir", "log_intake", { member: "Asha", date: "2026-10-05", meal_slot: "snack", items: [{ source: "food", food: "Yogurt", value: 100, unit: "g", provenance: "label", confidence: "high" }], idempotency_key: "i-1" });
    expect(logged.status, await logged.clone().text()).toBe(200);
    const sql = (db as unknown as { test: { db: { prepare(q: string): { get(): unknown } } } }).test.db;
    expect(sql.prepare("SELECT state FROM intake_item").get()).toEqual({ state: "draft" });
    let ran: Promise<unknown> = Promise.resolve();
    await entry.scheduled({ scheduledTime: Date.parse("2030-01-01T00:00:00Z"), cron: "0 * * * *" }, env({ DB: db, LOCAL_FIXED_NOW: FIXED }), { waitUntil: (p) => void (ran = p) });
    await ran;
    expect(sql.prepare("SELECT state FROM intake_item").get()).toEqual({ state: "confirmed" });
    expect(sql.prepare("SELECT origin, at FROM write_log ORDER BY id DESC LIMIT 1").get()).toEqual({ origin: "auto_confirm", at: "2026-10-07T04:30:00Z" });
  });

  it("the shipped entry's mode ignores it: LOCAL_FIXED_NOW is honoured only in header mode", async () => {
    // Lock 1 hands the request to the shipped entry, which has no fixed clock.
    const e = env({ LOCAL_DEV_IDENTITY: "member:asha@example.com", LOCAL_FIXED_NOW: FIXED });
    const before = istToday();
    const today = ((await (await entry.fetch(whoamiAt("127.0.0.1:8787"), e)).json()) as { today: string }).today;
    expect([before, istToday()]).toContain(today);
    expect(today).not.toBe("2026-10-07");
  });
});
