/**
 * Failure journeys (e2e spec §6): offline, an aborted save, one lost before
 * landing, a server error, a refusal, a double tap, a reload mid-edit, and a
 * resize across 1,024 px, on Food amount, Set, Reading, Tell Claude, a
 * catalogue edit and Waiting on you's Confirm N, as Asha at both widths (the
 * resize wide only). Each loses nothing and writes nothing twice.
 *
 * Delta-only rule: these cases run fullyParallel on a worker-scoped slot that
 * is not restarted per test, and which cases share a slot changes whenever the
 * worker or test count does. A case asserts before/after deltas or "the row it
 * wrote", never an absolute state (an empty meal, a first row); a case that
 * needs one restarts its slot first (final review M5).
 */
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { expect, test, type Api } from "./support/fixtures.ts";
import type { ToolLog } from "./support/network.ts";
import { d1 } from "./support/d1.ts";
import { settle } from "./support/settle.ts";
import { catalogueRecord, openSheet, pick, readingValue, region, sheet, tellText, toolPattern, writeAs, writesTo } from "./support/ui.ts";

interface Ctx {
  page: Page;
  api: (m?: "asha" | "kabir" | "noor") => Api;
  today: string;
}

interface FailForm {
  name: string;
  /** The write tool(s) its Save sends. */
  tools: readonly string[];
  /** Offline, the Save says "Not saved: you're offline." and keeps the entry (48), or the button is disabled (24). */
  offline: "message" | "disabled";
  /**
   * What arms the browser's "Leave site?" (useUnsavedGuard, web decision 100): "typing" (Tell Claude's text),
   * "held" (the "+" sheet's other tabs, only while a Save is held for Try again), "none" (the catalogue edit and Confirm N).
   */
  guard: "typing" | "held" | "none";
  /** What the slot's D1 holds for this form's entry now (the latest row's value), as a string. */
  stored(persist: string): string;
  /** What `stored` reads once the entry has landed, given what it read before (the exact value the case typed). */
  landed(before: string): string;
  open(c: Ctx): Promise<void>;
  scope(page: Page): Locator;
  save(page: Page): Locator;
  /**
   * The entry is still there. "open": it can be edited (a refusal unlocks it); "held": a Save is held for Try again,
   * where Tell Claude's text is read-only so the held plan stays what was asked (the other forms stay editable).
   */
  kept(page: Page, state: "open" | "held"): Promise<void>;
  /** The form closed, or reset, as its Save would (74). */
  closed(page: Page): Promise<void>;
}

/** The fibre the catalogue case typed (a worker runs its cases one at a time). */
let fibre = "";
let catalogueRef = "";

const FORMS: readonly FailForm[] = [
  {
    name: "Food amount",
    stored: (persist) => String(Object.values(d1(persist, "SELECT amount_value FROM intake_item ORDER BY id DESC LIMIT 1")[0] ?? {})[0]),
    landed: () => "41",
    tools: ["log_intake"],
    offline: "message",
    guard: "held",
    async open({ page }) {
      const d = await openSheet(page, "Food");
      await d.getByLabel("Find a food or dish").fill("Ragi");
      await pick(d, /^Ragi/).click();
      await d.getByLabel("How much").fill("41");
    },
    scope: (p) => sheet(p),
    save: (p) => sheet(p).getByRole("button", { name: "Save", exact: true }),
    kept: async (p, _state) => {
      await expect(sheet(p).getByLabel("How much")).toHaveValue("41");
      await expect(sheet(p).getByLabel("How much")).toBeEditable();
    },
    closed: async (p) => {
      await expect(sheet(p).getByLabel("How much")).toHaveCount(0);
    },
  },
  {
    name: "Set",
    stored: (persist) => String(Object.values(d1(persist, "SELECT load_value || 'x' || reps FROM session_set ORDER BY id DESC LIMIT 1")[0] ?? {})[0]),
    landed: () => "35.0x7",
    tools: ["log_set"],
    offline: "message",
    guard: "held",
    async open({ page }) {
      const d = await openSheet(page, "Set");
      await d.getByLabel("Find an exercise").fill("row");
      await d.getByRole("button", { name: /cable row/i }).first().click();
      // The prescription hydrates Cable row's 35 kg suggestion after the exercise is picked.
      // Wait for that real default instead of racing synthetic typing against the hydrator.
      const load = d.getByLabel("Load", { exact: true });
      await expect(load).toHaveValue("35");
      await d.getByLabel("Reps").fill("7");
      await d.getByPlaceholder("2 or 1-2").fill("2");
    },
    scope: (p) => sheet(p),
    save: (p) => sheet(p).getByRole("button", { name: "Save set" }),
    kept: async (p, _state) => {
      await expect(sheet(p).getByLabel("Reps")).toHaveValue("7");
      await expect(sheet(p).getByLabel("Reps")).toBeEditable();
    },
    closed: async (p) => {
      await expect.poll(async () => (await sheet(p).getByLabel("Reps").count()) === 0 || (await sheet(p).getByLabel("Reps").inputValue()) !== "7").toBe(true);
    },
  },
  {
    name: "Reading",
    stored: (persist) => String(Object.values(d1(persist, "SELECT metric || ' ' || value FROM reading ORDER BY id DESC LIMIT 1")[0] ?? {})[0]),
    landed: () => "waist_navel 84.2",
    tools: ["log_reading"],
    offline: "message",
    guard: "held",
    async open({ page }) {
      const d = await openSheet(page, "Reading");
      await d.getByLabel("What you measured").selectOption("waist_navel");
      await readingValue(d).fill("84.2");
    },
    scope: (p) => sheet(p),
    save: (p) => sheet(p).getByRole("button", { name: "Log the reading" }),
    kept: async (p, _state) => {
      await expect(readingValue(sheet(p))).toHaveValue("84.2");
      await expect(readingValue(sheet(p))).toBeEditable();
    },
    closed: async (p) => {
      await expect(readingValue(sheet(p))).toHaveValue("");
    },
  },
  {
    name: "Tell Claude",
    stored: (persist) => String(Object.values(d1(persist, "SELECT text FROM inbox_entry ORDER BY id DESC LIMIT 1")[0] ?? {})[0]),
    landed: () => "A probe: tea and two slices of toast",
    tools: ["submit_to_inbox", "commit_route"],
    offline: "message",
    guard: "typing",
    async open({ page }) {
      const d = await openSheet(page, "Tell Claude");
      await tellText(d).fill("A probe: tea and two slices of toast");
    },
    scope: (p) => sheet(p),
    save: (p) => sheet(p).getByRole("button", { name: "Send to Claude" }),
    kept: async (p, state) => {
      await expect(tellText(sheet(p))).toHaveValue("A probe: tea and two slices of toast");
      if (state === "open") await expect(tellText(sheet(p))).toBeEditable();
    },
    closed: async (p) => {
      // The box clears when the send lands (the plan's after-save). The "Waiting for Claude" list can already be there, so it proves nothing.
      await expect(tellText(sheet(p))).toHaveValue("");
    },
  },
  {
    name: "Catalogue edit",
    stored: (persist) => String(Object.values(d1(persist, "SELECT fibre_g FROM food_source WHERE ref = ?", catalogueRef)[0] ?? {})[0]),
    landed: () => fibre,
    tools: ["amend"],
    offline: "disabled",
    guard: "none",
    async open({ page, api }) {
      catalogueRef = String((await api().tool("catalogue_search", { query: "Ragi", kinds: ["food_source"] })).body.results[0].ref);
      await page.goto(`/catalogue/food/${encodeURIComponent(catalogueRef)}`);
      await settle(page);
      await catalogueRecord(page).getByRole("button", { name: "Edit", exact: true }).click();
      // Fibre, not Energy: a changed kcal can raise the energy_mismatch question instead of saving. One more than
      // the record holds now, because the slot's copy keeps what earlier cases saved and an unchanged value sends nothing.
      const now = Number(await page.getByLabel(/^Fibre/).inputValue());
      fibre = String(Math.round((now + 1) * 10) / 10);
      await page.getByLabel(/^Fibre/).fill(fibre);
      await page.getByLabel("Why the change?").fill("The new pack's label says so.");
    },
    scope: (p) => p.getByRole("form"),
    save: (p) => p.getByRole("form").getByRole("button", { name: "Save", exact: true }),
    kept: async (p, state) => {
      await expect(p.getByLabel(/^Fibre/)).toHaveValue(fibre);
      if (state === "open") await expect(p.getByLabel(/^Fibre/)).toBeEditable();
    },
    closed: async (p) => {
      await expect(p.getByRole("form")).toHaveCount(0);
    },
  },
  {
    name: "Confirm N",
    // The new draft is the newest food row; it is the only thing waiting, so it is the one ticked.
    stored: (persist) => String(Object.values(d1(persist, "SELECT state FROM intake_item ORDER BY id DESC LIMIT 1")[0] ?? {})[0]),
    landed: () => "confirmed",
    tools: ["confirm"],
    offline: "disabled",
    guard: "none",
    async open({ page, api, today }) {
      // Asha's earlier drafts confirmed through the API first, then a fresh one about her, logged by Kabir: the only row to tick.
      const waiting = (await api("asha").tool("household_overview", {})).body.waiting_on_you?.drafts ?? [];
      const mine = (waiting as { table: string; id: number; waits: string | null }[]).filter((d) => d.waits === null).map(({ table, id }) => ({ table, id }));
      if (mine.length > 0) await writeAs(api("asha"), "confirm", { records: mine });
      await writeAs(api("kabir"), "log_intake", { member: "Asha", date: today, meal_slot: "snack", items: [{ source: "food", food: "Ragi", value: 12, unit: "g", provenance: "weighed", confidence: "high" }] });
      await page.goto("/household");
      await settle(page);
      await region(page, "Waiting on you").locator("input[data-row]").first().check();
    },
    scope: (p) => region(p, "Waiting on you"),
    save: (p) => region(p, "Waiting on you").getByRole("button", { name: /^Confirm 1$/ }),
    kept: async (p, state) => {
      await expect(region(p, "Waiting on you").locator("input[data-row]").first()).toBeChecked();
      if (state === "open") await expect(region(p, "Waiting on you").locator("input[data-row]").first()).toBeEnabled();
    },
    closed: async (p) => {
      await expect(region(p, "Waiting on you").getByRole("button", { name: /^Confirm 1$/ })).toHaveCount(0);
    },
  },
];

type Hold = "fetch-abort" | "abort" | "503" | "403";

/** The next request of the form's write: landed then cut off, cut off, a 503, or a first-step refusal. */
async function holdOnce(page: Page, form: FailForm, how: Hold): Promise<void> {
  const pattern = new RegExp(`/tools/(${form.tools.join("|")})$`);
  await page.route(pattern, async (route) => {
    if (how === "fetch-abort") {
      await route.fetch();
      await route.abort();
    } else if (how === "abort") {
      await route.abort();
    } else {
      const code = how === "503" ? "busy" : "not_visible";
      await route.fulfill({ status: how === "503" ? 503 : 403, contentType: "application/json", body: JSON.stringify({ status: "error", error: { code, message: how === "503" ? "The app is busy; try again." : "records are visible only to their member" } }) });
    }
  }, { times: 1 });
}

const keysSent = async (tools: ToolLog, form: FailForm) => (await tools.writes(toolPattern(form.tools))).map((c) => String(c.input?.idempotency_key));
const tryAgain = (page: Page, form: FailForm) => form.scope(page).getByRole("button", { name: "Try again" });

/** Reload with the browser's "Leave site?" answered; resolves once the dialog is answered (and, accepted, the page is back). */
async function reloadAnswering(page: Page, answer: "accept" | "dismiss"): Promise<void> {
  const dialog = page.waitForEvent("dialog");
  const reloading = page.reload().catch(() => undefined);
  const d = await dialog;
  expect(d.type()).toBe("beforeunload");
  if (answer === "dismiss") {
    await d.dismiss();
    return;
  }
  await d.accept();
  await reloading;
  await settle(page);
}

for (const width of [390, 1440] as const) {
  for (const form of FORMS) {
    test.describe(`${form.name} at ${width}`, () => {
      test.use({ viewer: "asha", viewport: { width, height: width === 390 ? 844 : 900 } });

      test("offline: nothing is lost, and back online it writes once", async ({ page, context, api, today, slot }) => {
        await form.open({ page, api, today });
        const before = writesTo(slot.persist, form.tools);
        const was = form.stored(slot.persist);
        await (context as BrowserContext).setOffline(true);
        expect(await page.evaluate(() => navigator.onLine)).toBe(false);
        if (form.offline === "message") {
          await expect(page.getByText(/^Offline[.:]/).first()).toBeVisible();
          await form.save(page).click();
          await expect(form.scope(page).getByText("Not saved: you're offline.")).toBeVisible();
          await form.kept(page, "held");
        } else {
          await expect(form.save(page)).toBeDisabled();
          await form.kept(page, "held");
        }
        await context.setOffline(false);
        if (form.offline === "message") {
          await expect(page.getByText(/^Offline[.:]/)).toHaveCount(0);
          await tryAgain(page, form).click();
        } else await form.save(page).click();
        await form.closed(page);
        expect(writesTo(slot.persist, form.tools)).toBe(before + 1);
        expect(form.stored(slot.persist), "the exact value typed is what was stored").toBe(form.landed(was));
      });

      test("aborted after it landed: Try again sends the same key, one row", { tag: form.name === "Food amount" && width === 390 ? ["@fast"] : [] }, async ({ page, api, today, slot, tools }) => {
        await form.open({ page, api, today });
        const before = writesTo(slot.persist, form.tools);
        const was = form.stored(slot.persist);
        await holdOnce(page, form, "fetch-abort");
        await form.save(page).click();
        await expect(form.scope(page).getByText(/the server didn't answer/i)).toBeVisible();
        await form.kept(page, "held");
        await tryAgain(page, form).click();
        await form.closed(page);
        const keys = await keysSent(tools, form);
        expect(keys).toHaveLength(2);
        expect(new Set(keys).size, "Try again sends the same idempotency_key (web decision 68)").toBe(1);
        expect(writesTo(slot.persist, form.tools)).toBe(before + 1);
        expect(form.stored(slot.persist), "the exact value typed is what was stored").toBe(form.landed(was));
      });

      test("lost before landing: Try again writes once", async ({ page, api, today, slot }) => {
        await form.open({ page, api, today });
        const before = writesTo(slot.persist, form.tools);
        const was = form.stored(slot.persist);
        await holdOnce(page, form, "abort");
        await form.save(page).click();
        await expect(tryAgain(page, form)).toBeVisible();
        await tryAgain(page, form).click();
        await form.closed(page);
        expect(writesTo(slot.persist, form.tools)).toBe(before + 1);
        expect(form.stored(slot.persist), "the exact value typed is what was stored").toBe(form.landed(was));
      });

      test("server error: the plan is held for Try again (64)", async ({ page, api, today, slot, tools }) => {
        await form.open({ page, api, today });
        const before = writesTo(slot.persist, form.tools);
        const was = form.stored(slot.persist);
        await holdOnce(page, form, "503");
        await form.save(page).click();
        await expect(tryAgain(page, form)).toBeVisible();
        await form.kept(page, "held");
        expect(writesTo(slot.persist, form.tools)).toBe(before);
        expect(form.stored(slot.persist), "nothing stored").toBe(was);
        await tryAgain(page, form).click();
        await form.closed(page);
        expect(new Set(await keysSent(tools, form)).size).toBe(1);
        expect(writesTo(slot.persist, form.tools)).toBe(before + 1);
        expect(form.stored(slot.persist), "the exact value typed is what was stored").toBe(form.landed(was));
      });

      test("refusal: not held, and the entry unlocks (64)", async ({ page, api, today, slot }) => {
        await form.open({ page, api, today });
        const before = writesTo(slot.persist, form.tools);
        const was = form.stored(slot.persist);
        await holdOnce(page, form, "403");
        await form.save(page).click();
        await expect(form.scope(page).getByText(/^Not saved/)).toBeVisible();
        await expect(tryAgain(page, form)).toHaveCount(0);
        await form.kept(page, "open");
        expect(writesTo(slot.persist, form.tools)).toBe(before);
        expect(form.stored(slot.persist), "nothing stored").toBe(was);
      });

      test("double tap: one request per key, one row", async ({ page, api, today, slot, tools }) => {
        await form.open({ page, api, today });
        const before = writesTo(slot.persist, form.tools);
        await form.save(page).dblclick();
        await form.closed(page);
        await form.open({ page, api, today });
        // Two clicks about 30 ms apart: two animation frames, no clock.
        await form.save(page).evaluate((b: HTMLElement) => new Promise<void>((done) => {
          b.click();
          requestAnimationFrame(() => requestAnimationFrame(() => {
            b.click();
            done();
          }));
        }));
        await form.closed(page);
        const keys = await keysSent(tools, form);
        expect(keys).toHaveLength(2);
        expect(new Set(keys).size).toBe(2);
        expect(writesTo(slot.persist, form.tools)).toBe(before + 2);
      });

      test("reload mid-edit: dismiss keeps the entry, accept writes nothing; a held write landed once", async ({ page, api, today, slot }) => {
        await form.open({ page, api, today });
        const before = writesTo(slot.persist, form.tools);
        const was = form.stored(slot.persist);
        if (form.guard === "typing") {
          await reloadAnswering(page, "dismiss");
          await form.kept(page, "open");
          await reloadAnswering(page, "accept");
        } else {
          await page.reload();
          await settle(page);
        }
        expect(writesTo(slot.persist, form.tools)).toBe(before);
        expect(form.stored(slot.persist), "nothing stored").toBe(was);
        await form.open({ page, api, today });
        const again = writesTo(slot.persist, form.tools); // after open: Confirm N's open confirms what was waiting
        await holdOnce(page, form, "fetch-abort");
        await form.save(page).click();
        await expect(tryAgain(page, form)).toBeVisible();
        if (form.guard !== "none") await reloadAnswering(page, "accept");
        else {
          await page.reload();
          await settle(page);
        }
        expect(writesTo(slot.persist, form.tools), "the held write landed once, never twice").toBe(again + 1);
        expect(form.stored(slot.persist), "the exact value typed is what was stored").toBe(form.landed(was));
      });

      if (width === 1440) {
        test("resize across 1,024 px and the layout thresholds: entry, held status and key kept (69)", async ({ page, api, today, slot, tools }) => {
          // FINDING (task 13): crossing 1,024 px remounts Waiting on you (it moves between the phone's stack and the wide
          // column) and its own useWrites and ticks go with it, so the held Confirm and the tick are lost, against decision 69.
          // Expected to fail until the app keeps them; when it does, this annotation fails the run: delete it.
          test.fail(form.name === "Confirm N", "decision 69: a held plan survives the breakpoint; Waiting on you's own useWrites and ticks do not");
          await form.open({ page, api, today });
          const before = writesTo(slot.persist, form.tools);
          const was = form.stored(slot.persist);
          await holdOnce(page, form, "503");
          await form.save(page).click();
          await expect(tryAgain(page, form)).toBeVisible();
          const [held] = await keysSent(tools, form);
          // 900 (phone), about 1,400 and 1,800 (either side of the 1,150 and 1,500 px screens), back to 1,440.
          for (const w of [900, 1400, 1800, 1440]) {
            await page.setViewportSize({ width: w, height: 900 });
            await settle(page); // the media query's change has re-rendered
            await form.kept(page, "held");
            await expect(tryAgain(page, form)).toBeVisible();
          }
          await tryAgain(page, form).click();
          await form.closed(page);
          const keys = await keysSent(tools, form);
          expect(keys.at(-1), "Try again after the resize sends the held key").toBe(held);
          expect(writesTo(slot.persist, form.tools)).toBe(before + 1);
          expect(form.stored(slot.persist), "the exact value typed is what was stored").toBe(form.landed(was));
        });
      }
    });
  }
}
