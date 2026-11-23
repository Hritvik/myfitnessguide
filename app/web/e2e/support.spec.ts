import { readFileSync } from "node:fs";
import { sep } from "node:path";
import { identityHeaders, newToken } from "../scripts/dev-worker.ts";
import { EMAILS, expect, MEMBERS, test } from "./support/fixtures.ts";
import { expectMukta, offlineFonts, refused } from "./support/fonts.ts";
import { FIXED_DAY, FIXED_NOW } from "../scripts/test-clock.ts";
import { runDir, runToken } from "./support/run.ts";
import { ABSENT, fromAnswer, mayBeAbsent, step, type Probe } from "./support/probes.ts";
import { settle } from "./support/settle.ts";

test.describe("the harness (e2e spec §3)", () => {
  test("each member signs in by the header with this run's token", { tag: "@fast" }, async ({ api, names }) => {
    expect(names).toEqual({ asha: "Asha", kabir: "Kabir", noor: expect.stringMatching(/^Noor /) });
    for (const m of MEMBERS) expect((await api(m).tool("whoami")).body.member).toBe(names[m]);
  });

  test("another run's token, or no token, is refused", { tag: "@fast" }, async ({ playwright, slot }) => {
    // An explicit empty set: a request context left without one inherits the viewer's headers, token included.
    const request = await playwright.request.newContext({ extraHTTPHeaders: {} });
    expect((await request.get(`${slot.origin}/tools`, { headers: identityHeaders(EMAILS.asha, newToken()) })).status()).toBe(401);
    expect((await request.get(`${slot.origin}/tools`, { headers: { "X-Local-Identity": `member:${EMAILS.asha}` } })).status()).toBe(401);
    expect((await request.get(`${slot.origin}/tools`, { headers: identityHeaders(EMAILS.asha, runToken()) })).status()).toBe(200);
    await request.dispose();
  });

  test("the app loads Today as each member", { tag: "@fast" }, async ({ as }) => {
    for (const m of MEMBERS) {
      const page = await as(m);
      await page.goto("/");
      await settle(page);
      await expect(page.getByRole("list", { name: "Meals" })).toBeVisible();
    }
  });

  test("the Worker, the seed and every member's page live on the fixed clock (e2e spec §3, The day)", { tag: "@fast" }, async ({ api, as, today }) => {
    expect(today).toBe(FIXED_DAY);
    for (const m of MEMBERS) {
      expect((await api(m).tool("whoami")).body.today).toBe(FIXED_DAY);
      const page = await as(m);
      await page.goto("/");
      expect(await page.evaluate(() => new Date().toISOString())).toBe(new Date(FIXED_NOW).toISOString());
    }
  });

  test("Mukta comes from the vendored copies (plan review, completeness F1)", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await expectMukta(page);
  });

  test("a page's requests and WebSockets off this machine are refused by the suite's own routes", async ({ page, context }) => {
    await page.goto("/");
    await settle(page);
    const before = refused(context).length;
    // no-cors: were the request to leave, it would resolve (opaque) whatever the host's CORS headers.
    const fetched = await page.evaluate(() => fetch("https://example.com/", { mode: "no-cors" }).then(() => "reached", () => "refused"));
    const socket = await page.evaluate(
      () => new Promise<string>((resolve) => {
        const ws = new WebSocket("wss://example.com/");
        ws.onopen = () => resolve("open");
        ws.onclose = () => resolve("closed");
      }),
    );
    expect(fetched).toBe("refused");
    expect(socket).toBe("closed");
    expect(refused(context).slice(before)).toEqual(["https://example.com/", "wss://example.com/"]);
  });

  test("no host but this machine resolves, whatever the routes miss (preconnects, a bare context)", async ({ playwright, launchOptions, slot }, testInfo) => {
    // A browser of the suite's own launch options, logging its network stack: routing never sees a
    // preconnect (index.html opens two to Google), so the proof is that no name off this machine resolved
    // and no socket went anywhere but 127.0.0.1.
    const netlog = testInfo.outputPath("netlog.json");
    const browser = await playwright.chromium.launch({ ...launchOptions, args: [...(launchOptions.args ?? []), `--log-net-log=${netlog}`] });
    const withFonts = await browser.newContext({ baseURL: slot.origin, extraHTTPHeaders: identityHeaders(EMAILS.asha, runToken()) });
    await offlineFonts(withFonts);
    const page = await withFonts.newPage();
    await page.goto("/");
    await settle(page);
    await expectMukta(page);
    // A context with none of the suite's routes reaches nothing either.
    const bare = await browser.newContext({ extraHTTPHeaders: {} });
    const outside = await (await bare.newPage()).goto("https://example.com/").then(() => "reached", (e: Error) => e.message);
    await browser.close();
    expect(outside).toMatch(/ERR_NAME_NOT_RESOLVED/);
    const { lookups, connects } = readNetLog(netlog);
    // The bare context's lookup is the rule at work: example.com was asked for and mapped to nothing.
    expect(lookups).toContain("~notfound");
    expect(lookups.filter((h) => !["127.0.0.1", "localhost", "~notfound"].includes(h)), "names looked up off this machine").toEqual([]);
    expect(connects.length).toBeGreaterThan(0);
    expect(connects.filter((a) => a !== "127.0.0.1"), "sockets tried off this machine").toEqual([]);
  });

  test("each slot serves its own copy inside the run directory", async ({ slot }) => {
    expect(slot.persist.startsWith(runDir() + sep)).toBe(true);
    expect(slot.persist).toMatch(/[/\\]s\d+-[a-z-]+$/);
  });

  test("a restart from a fresh copy (privacy's cost per test, spec §3)", async ({ slot, api }, info) => {
    const t0 = Date.now();
    await slot.restart();
    const restart_ms = Date.now() - t0;
    info.annotations.push({ type: "restart_ms", description: String(restart_ms) });
    console.log(`restart_ms ${restart_ms}`);
    expect((await api().tool("whoami")).status).toBe(200);
  });
});

/**
 * From Chromium's net log: the host of every lookup the browser asked for (a host the resolver rules
 * map away shows as `~notfound`), and every address a socket tried. Event types are numbered per build,
 * so they are read by name from the log's own constants.
 */
function readNetLog(file: string): { lookups: string[]; connects: string[] } {
  // Chromium may leave the events array unclosed when the browser closes.
  let text = readFileSync(file, "utf8").trim();
  if (!text.endsWith("}")) text = `${text.replace(/,\s*$/, "")}]}`;
  const log = JSON.parse(text) as { constants: { logEventTypes: Record<string, number> }; events: { type: number; params?: Record<string, unknown> }[] };
  const lookup = log.constants.logEventTypes.HOST_RESOLVER_MANAGER_REQUEST;
  const attempt = log.constants.logEventTypes.TCP_CONNECT_ATTEMPT;
  const lookups = new Set<string>();
  const connects = new Set<string>();
  for (const e of log.events) {
    const host = e.params?.host;
    const address = e.params?.address;
    if (e.type === lookup && typeof host === "string") lookups.add(new URL(host).hostname);
    if (e.type === attempt && typeof address === "string") connects.add(address.replace(/:\d+$/, ""));
  }
  return { lookups: [...lookups], connects: [...connects] };
}

test.describe("the journey framework's own checks (e2e spec §4, F18)", () => {
  const fixed = (label: string, value: string): Probe => ({ label, read: async () => value });

  test("a same probe that matches nothing fails the step, unless it is marked as allowed to stay absent", async () => {
    const absent = fixed("a locator that matches nothing", ABSENT);
    await expect(step("nothing happens", async () => {}, { same: [absent] })).rejects.toThrow(/a locator that matches nothing matched nothing, so "same" proves nothing/);
    // Opted in, with its reason: "(absent)" before and after is the claim, and the step passes.
    await step("nothing happens", async () => {}, { same: [mayBeAbsent(absent, "the member has no target, so no strip")] });
    // A same probe that reads something still passes when it doesn't move.
    await step("nothing happens", async () => {}, { same: [fixed("a present probe", "Energy 812 kcal")] });
  });

  test("fromAnswer matches the answer's number as a whole token", async () => {
    const answer = async () => ({ v: 12 });
    const twelve = fromAnswer(answer, (a) => a.v);
    const twelveKcal = fromAnswer(answer, (a) => a.v, "kcal");
    await twelve("Energy 12 so far");
    await twelveKcal("Energy 12 kcal so far");
    await expect(Promise.resolve().then(() => twelve("Energy 120 so far"))).rejects.toThrow(/the screen shows 12/);
    await expect(Promise.resolve().then(() => twelve("Energy 112 so far"))).rejects.toThrow(/the screen shows 12/);
    await expect(Promise.resolve().then(() => twelve("Energy 12.5 so far"))).rejects.toThrow(/the screen shows 12/);
    await expect(Promise.resolve().then(() => twelveKcal("Energy 112 kcal so far"))).rejects.toThrow(/the screen shows 12 kcal/);
    const grouped = fromAnswer(async () => ({ v: 1862.4 }), (a) => a.v, "kcal");
    await grouped("Energy over by 1,862 kcal 3,462 of 1,600");
    await expect(Promise.resolve().then(() => grouped("Energy over by 11,862 kcal"))).rejects.toThrow(/the screen shows 1,862 kcal/);
    // A partial total's "+" (web decision 118) is the same number; a "+" doesn't loosen the whole-token rule.
    await grouped("Energy over by 1,862+ kcal 3,462+ of 1,600");
    await twelve("P 12+ so far");
    await expect(Promise.resolve().then(() => grouped("Energy over by 11,862+ kcal"))).rejects.toThrow(/the screen shows 1,862 kcal/);
    await expect(Promise.resolve().then(() => twelve("Energy 12+5 so far"))).rejects.toThrow(/the screen shows 12/);
  });
});
