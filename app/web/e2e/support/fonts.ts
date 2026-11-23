/**
 * Mukta without the network (plan review, completeness F1). index.html loads
 * Mukta 400, 500 and 700 from Google Fonts; every browser context the suite
 * makes answers those requests from the copies vendored in e2e/fixtures/fonts
 * (SIL Open Font License 1.1; OFL.txt beside them) and refuses every other
 * request and WebSocket that would leave this machine, so no shot depends on
 * the network. What it refuses is recorded (`refused`), so a test can prove the
 * refusal happened here rather than somewhere further out. The config's
 * --host-resolver-rules and serviceWorkers: "block" close what routing can't
 * see (preconnects, DNS prefetch, a service worker's fetches).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { WEB } from "./run.ts";

const DIR = join(WEB, "e2e", "fixtures", "fonts");
export const MUKTA = { 400: "Mukta-Regular.ttf", 500: "Mukta-Medium.ttf", 700: "Mukta-Bold.ttf" } as const;
const CSS = Object.entries(MUKTA)
  .map(([weight, file]) => `@font-face{font-family:'Mukta';font-style:normal;font-weight:${weight};font-display:block;src:url(https://fonts.gstatic.com/e2e/${file}) format('truetype');}`)
  .join("\n");
const LOCAL = new Set(["127.0.0.1", "localhost"]);
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

const REFUSED = new WeakMap<BrowserContext, string[]>();

/** The URLs (requests and WebSockets) this context's routes refused, in order. */
export function refused(context: BrowserContext): readonly string[] {
  return REFUSED.get(context) ?? [];
}

const offMachine = (url: URL) => !LOCAL.has(url.hostname);

export async function offlineFonts(context: BrowserContext): Promise<void> {
  const record: string[] = [];
  REFUSED.set(context, record);
  await context.route((url) => url.hostname === "fonts.googleapis.com", (route) => route.fulfill({ status: 200, contentType: "text/css", body: CSS }));
  await context.route((url) => url.hostname === "fonts.gstatic.com", (route) => {
    const file = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    if (!(Object.values(MUKTA) as string[]).includes(file)) {
      record.push(route.request().url());
      return route.abort("blockedbyclient");
    }
    return route.fulfill({ status: 200, contentType: "font/ttf", body: readFileSync(join(DIR, file)) });
  });
  // Registered last, so it is asked first: anything else off this machine is refused.
  await context.route((url) => offMachine(url) && !FONT_HOSTS.has(url.hostname), (route) => {
    record.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  // A WebSocket never goes through route(); an IP literal never asks the resolver.
  await context.routeWebSocket((url) => offMachine(url), (ws) => {
    record.push(ws.url());
    return ws.close({ code: 1008, reason: "off this machine" });
  });
}

/** Every weight the app uses has loaded from the vendored copies (document.fonts). */
export async function expectMukta(page: Page): Promise<void> {
  const loaded = await page.evaluate(async () => {
    await Promise.all([400, 500, 700].map((w) => document.fonts.load(`${w} 16px Mukta`)));
    const faces = [...document.fonts].filter((f) => f.family.replace(/["']/g, "") === "Mukta" && f.status === "loaded").map((f) => f.weight);
    return [400, 500, 700].every((w) => faces.includes(String(w)) && document.fonts.check(`${w} 16px Mukta`));
  });
  expect(loaded, "Mukta 400, 500 and 700 loaded from e2e/fixtures/fonts").toBe(true);
}
