/**
 * The suite's fixtures (e2e spec §3). A worker slot (Playwright's
 * parallelIndex, stable across worker restarts) copies the seeded D1 and
 * runs its own dev-entry Worker on an OS port; read-only projects check at
 * the end that their copy's write log didn't grow. Each member is a browser
 * context whose every request carries that member's identity header and the
 * run's token.
 */
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { identityHeaders, startDevWorker, type DevWorker } from "../../scripts/dev-worker.ts";
import type { StateApi } from "../../scripts/states.ts";
import { FIXED_NOW } from "../../scripts/test-clock.ts";
import { writeCount } from "./d1.ts";
import { offlineFonts } from "./fonts.ts";
import { ToolLog } from "./network.ts";
import { paths, runDir, runToken, TIMEZONE } from "./run.ts";

export { expect };

export type MemberKey = "asha" | "kabir" | "noor";
export const MEMBERS: readonly MemberKey[] = ["asha", "kabir", "noor"];
export const EMAILS: Record<MemberKey, string> = { asha: "asha@example.com", kabir: "kabir@example.com", noor: "noor@example.com" };

/**
 * Every context the suite makes: Mukta from the vendored copies, nothing off this machine, and the
 * page's Date fixed at the test household's instant (e2e spec §3, The day; worker decision 162), the
 * Worker's own (LOCAL_FIXED_NOW). Timers still run; only the clock's reading is fixed.
 */
export async function prepareContext(context: BrowserContext): Promise<void> {
  await offlineFonts(context);
  await context.clock.setFixedTime(new Date(FIXED_NOW));
}

export interface Slot {
  readonly origin: string;
  readonly persist: string;
  /** A fresh copy of the seed and a new Worker (privacy, before each test). */
  restart(): Promise<void>;
}

export interface Api {
  tool(name: string, input?: Record<string, unknown>): Promise<{ status: number; body: any }>;
}

type WorkerFixtures = { readOnly: boolean; slot: Slot; names: Record<MemberKey, string> };
type TestFixtures = {
  viewer: MemberKey;
  freshPerTest: boolean;
  freshCopy: void;
  as: (m: MemberKey) => Promise<Page>;
  observer: (m: MemberKey) => Promise<Page>;
  api: (m?: MemberKey) => Api;
  tools: ToolLog;
  today: string;
  stateApi: StateApi;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  readOnly: [false, { scope: "worker", option: true }],

  slot: [
    async ({ readOnly }, use, info) => {
      const p = paths(runDir());
      const dir = p.slot(info.parallelIndex, info.project.name);
      const state: { worker: DevWorker | null } = { worker: null };
      const copy = () => {
        rmSync(dir, { recursive: true, force: true });
        cpSync(p.seed, dir, { recursive: true });
      };
      const launch = async () => {
        state.worker = await startDevWorker({ persist: dir, token: runToken(), probeEmail: EMAILS.asha, assets: p.dist, log: join(p.logs, `slot-${info.parallelIndex}-${info.project.name}.log`), pidFile: p.pids, fixedNow: FIXED_NOW });
      };
      copy();
      const writesAtStart = readOnly ? writeCount(dir) : 0;
      await launch();
      await use({
        get origin() {
          if (!state.worker) throw new Error("the slot's Worker is not running");
          return state.worker.origin;
        },
        persist: dir,
        async restart() {
          await state.worker?.stop();
          state.worker = null;
          copy();
          await launch();
        },
      });
      await state.worker?.stop();
      if (readOnly) expect(writeCount(dir), `${info.project.name} wrote to its pristine copy`).toBe(writesAtStart);
    },
    { scope: "worker" },
  ],

  names: [
    async ({ slot }, use) => {
      const names = {} as Record<MemberKey, string>;
      for (const m of MEMBERS) {
        const r = await fetch(`${slot.origin}/tools/whoami`, { method: "POST", headers: { "content-type": "application/json", ...identityHeaders(EMAILS[m], runToken()) }, body: "{}", signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(`whoami as ${EMAILS[m]} answered ${r.status}: ${await r.text()}`);
        names[m] = ((await r.json()) as { member: string }).member;
      }
      await use(names);
    },
    { scope: "worker" },
  ],

  viewer: ["asha", { option: true }],
  freshPerTest: [false, { option: true }],
  // A test that sets freshPerTest starts from a fresh copy and a new Worker (spec §3: privacy). baseURL, as and api wait for it.
  freshCopy: [
    async ({ slot, freshPerTest }, use) => {
      if (freshPerTest) await slot.restart();
      await use();
    },
    { auto: true },
  ],
  baseURL: async ({ slot, freshCopy: _fresh }, use) => use(slot.origin),
  // Every context serves Mukta from the vendored copies, reaches nothing off this machine, and reads the fixed clock.
  context: async ({ context }, use) => {
    await prepareContext(context);
    await use(context);
  },
  extraHTTPHeaders: async ({ viewer }, use) => use(identityHeaders(EMAILS[viewer], runToken())),

  as: async ({ browser, slot, viewer, page, viewport, colorScheme, freshCopy: _fresh }, use) => {
    const made = new Map<MemberKey, Page>();
    await use(async (m) => {
      if (m === viewer) return page;
      const known = made.get(m);
      if (known) return known;
      const context = await browser.newContext({
        baseURL: slot.origin, viewport, colorScheme, timezoneId: TIMEZONE, reducedMotion: "reduce",
        extraHTTPHeaders: identityHeaders(EMAILS[m], runToken()),
      });
      await prepareContext(context);
      const opened = await context.newPage();
      made.set(m, opened);
      return opened;
    });
    for (const p of made.values()) await p.context().close();
  },

  observer: async ({ as }, use) => {
    const made = new Map<MemberKey, Page>();
    await use(async (m) => {
      const known = made.get(m);
      if (known) return known;
      const opened = await (await as(m)).context().newPage();
      made.set(m, opened);
      return opened;
    });
  },

  api: async ({ playwright, slot, viewer, freshCopy: _fresh }, use) => {
    const contexts = new Map<MemberKey, Promise<APIRequestContext>>();
    const contextOf = (m: MemberKey) => {
      let c = contexts.get(m);
      if (!c) {
        c = playwright.request.newContext({ baseURL: slot.origin, extraHTTPHeaders: identityHeaders(EMAILS[m], runToken()) });
        contexts.set(m, c);
      }
      return c;
    };
    await use((m = viewer) => ({
      async tool(name, input = {}) {
        const r = await (await contextOf(m)).post(`/tools/${name}`, { data: input });
        return { status: r.status(), body: await r.json().catch(() => null) };
      },
    }));
    for (const c of contexts.values()) await (await c).dispose();
  },

  tools: async ({ page }, use) => use(new ToolLog(page)),
  today: async ({ api }, use) => use(String((await api().tool("whoami")).body.today)),
  stateApi: async ({ api, names }, use) =>
    use({ tool: async (name, input) => (await api("asha").tool(name, input)).body as Record<string, unknown>, viewer: { name: names.asha, email: EMAILS.asha } }),
});
