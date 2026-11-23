/**
 * Privacy (e2e spec §5): for every ordered (viewer, owner) pair at both
 * widths, every route to the owner's owner-only data finds nothing of it, in
 * the page or in any response. Each test starts from a fresh copy (the
 * privacy project's freshPerTest). This file holds the API families (5 reads,
 * 6 writes), the UI families (1–4) and the positive control.
 * Privacy tests are never quarantined.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { AMENDABLE, OWNER_ONLY, OWNER_TEXT, RETRACTABLE, STATE_TABLES } from "@myfitnessguide/worker/owner-only";
import { openAllDetails } from "../scripts/states.ts";
import { PRIVACY_TABLE, type Aimed } from "./privacy.table.ts";
import { CANARIES, needle } from "../scripts/canaries.ts";
import { CANARY_MEMBER, found, hiddenNeedlesOf, needlesOf, ownerOf, type Owner } from "./support/canaries.ts";
import { d1 } from "./support/d1.ts";
import { expect, MEMBERS, test, type MemberKey } from "./support/fixtures.ts";
import { ToolLog } from "./support/network.ts";
import { settle } from "./support/settle.ts";
import { region } from "./support/ui.ts";

test.use({ freshPerTest: true });

export const PAIRS: readonly [MemberKey, MemberKey][] = MEMBERS.flatMap((v) => MEMBERS.filter((o) => o !== v).map((o): [MemberKey, MemberKey] => [v, o]));
const WIDTHS = [390, 1440] as const;

interface Answer {
  tool: string;
  input: Record<string, unknown>;
  status: number;
  body: string;
  /** For a call the table expects refused: what the write log and the aimed record's versions held before it, and after. */
  writes?: { before: string; after: string };
}

/** The write log's last id and the aimed record's versions: a refused call must leave both as they were (F10). */
function written(persist: string, r: Aimed): string {
  return JSON.stringify(d1(persist, "SELECT (SELECT max(id) FROM write_log) AS last_write, (SELECT json_group_array(json_array(id, version, action)) FROM (SELECT id, version, action FROM record_version WHERE table_name = ? AND record_id = ? ORDER BY id)) AS versions", r.table, r.id)[0]);
}

/** Every tool of one kind (read or write) in the table, aimed at the owner, from the viewer's own request context. */
async function answersFor(request: APIRequestContext, persist: string, owner: Owner, kind: "read" | "write", writes: ReadonlySet<string>): Promise<Answer[]> {
  const out: Answer[] = [];
  for (const [tool, row] of Object.entries(PRIVACY_TABLE)) {
    if ((kind === "write") !== writes.has(tool)) continue;
    for (const input of row.inputs(owner)) {
      const body = writes.has(tool) ? { ...input, idempotency_key: `privacy-${tool}-${out.length}-${Date.now()}` } : input;
      // One call at a time, so a refused call's before and after are its own.
      const aimed = row.refuses?.(input);
      const before = aimed && written(persist, aimed);
      const r = await request.post(`/tools/${tool}`, { data: body });
      const text = await r.text();
      out.push({ tool, input, status: r.status(), body: text, ...(aimed && before ? { writes: { before, after: written(persist, aimed) } } : {}) });
    }
  }
  return out;
}

/** A refusal: a 403 (not_visible, or not_yours to decide), or a 404 not_found ("no history" reads the same for any id), with its error. */
function refused(a: Answer): boolean {
  return (a.status === 403 || (a.status === 404 && a.body.includes('"not_found"'))) && a.body.includes('"status":"error"');
}

/** What every answer must be: 403 not_visible, or no canary of the owner; one aimed at an owner-only record (the row's `refuses`), refused, with nothing written; a 400 means the row's input never reached the tool. */
function judge(answers: readonly Answer[], owner: MemberKey): string[] {
  const needles = hiddenNeedlesOf(owner);
  return answers.flatMap((a) => {
    const row = PRIVACY_TABLE[a.tool]!;
    if (row.aim === "query") return a.status === 403 && a.body.includes('"not_visible"') ? [] : [`query answered ${a.status}, not 403 not_visible`];
    if (a.writes) {
      if (!refused(a)) return [`${a.tool} ${JSON.stringify(a.input)} → ${a.status}: an owner-only record must be refused`];
      if (a.writes.after !== a.writes.before) return [`${a.tool} ${JSON.stringify(a.input)} → ${a.status}, refused but wrote: ${a.writes.before} then ${a.writes.after}`];
    }
    if (a.status === 403 && a.body.includes('"not_visible"')) return [];
    const leaked = found(a.body, needles);
    if (leaked.length > 0) return [`${a.tool} ${JSON.stringify(a.input)} → ${a.status} leaked ${leaked.join(", ")}`];
    if (a.status === 400 && !row.invalidOk) return [`${a.tool} ${JSON.stringify(a.input)} → 400: correct its row in privacy.table.ts (the input never reached the tool)`];
    return [];
  });
}

test.describe("the tool table", () => {
  test("classifies every tool the Worker lists, and nothing else", { tag: "@fast" }, async ({ request }) => {
    const listed = ((await (await request.get("/tools")).json()) as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
    expect(Object.keys(PRIVACY_TABLE).sort()).toEqual(listed);
  });

  test("aims each records tool at every owner-only table it takes", { tag: "@fast" }, async ({ slot, names, today }) => {
    const owners = MEMBERS.map((m) => ownerOf(slot.persist, m, names[m], today));
    const takes: Record<string, ReadonlySet<string>> = { amend: new Set(Object.keys(AMENDABLE)), confirm: new Set(STATE_TABLES), reject: new Set(STATE_TABLES), retract: new Set(RETRACTABLE) };
    const ownerOnly = [...Object.keys(OWNER_ONLY), ...Object.keys(OWNER_TEXT)];
    for (const [tool, tables] of Object.entries(takes)) {
      const inputs = owners.flatMap((o) => PRIVACY_TABLE[tool]!.inputs(o));
      const aimed = new Set(inputs.map((i) => ((i.record ?? (i.records as unknown[])[0]) as { table: string }).table));
      expect([...aimed].sort(), `${tool}'s rows`).toEqual(ownerOnly.filter((t) => tables.has(t)).sort());
    }
  });
});

for (const [viewer, owner] of PAIRS) {
  for (const width of WIDTHS) {
    test.describe(`${viewer} looking for ${owner}'s data at ${width}`, () => {
      test.use({ viewer, viewport: { width, height: width === 390 ? 844 : 900 } });

      for (const kind of ["read", "write"] as const) {
        const tag = viewer === "asha" && width === 390 ? ["@fast"] : [];
        test(`API ${kind}s: every tool aimed at ${owner}`, { tag }, async ({ page, slot, names, today, request }) => {
          const writes = new Set<string>(((await (await request.get("/tools")).json()) as { tools: { name: string; write: boolean }[] }).tools.filter((t) => t.write).map((t) => t.name));
          const o = ownerOf(slot.persist, owner, names[owner], today);
          const answers = await answersFor(page.context().request, slot.persist, o, kind, writes);
          expect(answers.length).toBeGreaterThan(0);
          expect(judge(answers, owner)).toEqual([]);
        });
      }

    });
  }
}

// ---- the UI families (1–4) ---------------------------------------------------------------

type Family = "pills" | "household" | "history" | "keys";
const FAMILIES: readonly Family[] = ["pills", "household", "history", "keys"];
const startsWith = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

/**
 * Owner/family pairs whose routes show none of that owner's canaries, so the
 * family's own positive check can't hold there (ruling 3); the union test
 * still covers every canary. Add one only from a run that shows it, with why.
 */
const NO_OWN_CANARY: ReadonlySet<string> = new Set<string>([
  // The household routes (/household, and /train?member=Kabir's sessions list, opened and stepped) carry the
  // household's shared view; none of Kabir's owner-only canaries shows there even to Kabir (run: 0 of his needles).
  // The union test still proves each of his canaries is reachable elsewhere.
  "kabir/household",
]);

/** One family's visit as whoever `page` belongs to, looking at `ownerName`: every page's outerHTML and title, then every /tools body. */
async function visit(page: Page, family: Family, ownerName: string, wide: boolean): Promise<string> {
  const log = new ToolLog(page);
  const seen: string[] = [];
  const snap = async () => {
    await settle(page);
    seen.push(await page.evaluate(() => document.documentElement.outerHTML), await page.title());
  };
  const of = (path: string) => `${path}?member=${encodeURIComponent(ownerName)}`;
  switch (family) {
    case "pills": {
      await page.goto("/");
      await settle(page);
      await page.getByRole("navigation", { name: "Whose view" }).getByRole("link", { name: startsWith(ownerName) }).click();
      await snap();
      for (const path of ["/", "/train", "/progress", "/progress/health", "/waiting"]) {
        await page.goto(of(path));
        await snap();
      }
      break;
    }
    case "household": {
      await page.goto("/household");
      await settle(page);
      await openAllDetails(page);
      await snap();
      await page.goto(of("/train"));
      await settle(page);
      if (wide) {
        // The wide session list's rows: data-row buttons in the Sessions region.
        const sessions = region(page, "Sessions").locator("[data-row]");
        const n = await sessions.count();
        for (let i = 0; i < n; i++) {
          await sessions.nth(i).click();
          await snap();
        }
        // J steps through the same sessions from the keyboard.
        if (n > 1) {
          await sessions.first().click();
          for (let i = 1; i < n; i++) {
            await page.keyboard.press("j");
            await snap();
          }
        }
      } else {
        await openAllDetails(page);
        await snap();
      }
      break;
    }
    case "history": {
      for (const path of ["/", "/train", "/progress", "/progress/health"]) {
        await page.goto(of(path));
        await settle(page);
        const links = page.getByRole("button", { name: "history", exact: true });
        const n = await links.count();
        for (let i = 0; i < n; i++) {
          await links.nth(i).click();
          await expect(links.nth(i)).toHaveAttribute("aria-expanded", "true");
        }
        await snap();
      }
      break;
    }
    case "keys": {
      await page.goto(of("/"));
      await settle(page);
      await page.keyboard.press("g");
      await page.keyboard.press("p");
      await snap();
      await page.keyboard.press("g");
      await page.keyboard.press("t");
      await snap();
      const hrefs = new Set<string>();
      for (const path of ["/", "/train"]) {
        await page.goto(of(path));
        await settle(page);
        for (const h of await page.getByRole("main").getByRole("link").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""))) if (h.startsWith("/")) hrefs.add(h);
      }
      for (const h of [...hrefs].slice(0, 25)) {
        await page.goto(h);
        await snap();
      }
      break;
    }
  }
  return [...seen, ...(await log.settled()).map((c) => c.body)].join("\n");
}

for (const [viewer, owner] of PAIRS) {
  for (const width of WIDTHS) {
    test.describe(`${viewer} looking for ${owner}'s data in the app at ${width}`, () => {
      test.use({ viewer, viewport: { width, height: width === 390 ? 844 : 900 } });
      for (const family of FAMILIES) {
        test(`${family}: none of ${owner}'s canaries; ${owner}'s own visit shows them`, async ({ page, as, names }) => {
          const wide = width >= 1024;
          const leaked = found(await visit(page, family, names[owner], wide), hiddenNeedlesOf(owner));
          expect(leaked, `${viewer} found ${owner}'s owner-only data`).toEqual([]);
          if (NO_OWN_CANARY.has(`${owner}/${family}`)) return;
          const own = found(await visit(await as(owner), family, names[owner], wide), needlesOf(owner));
          expect(own.length, `the probe sees ${owner}'s canaries on the ${family} routes (positive control)`).toBeGreaterThan(0);
        });
      }
    });
  }
}

/**
 * Canaried fields no read returns to their owner, as "<owner>/<table>.<column>": the value names the read that
 * would show it (a product gap to ticket: written, never readable; the Worker is not changed on this branch).
 * Since ticket 76 (Worker decision 168) the notes an owner-only read selects are returned to their owner, so the
 * former entries — reading.note, blood_draw.note, goal_point.note, hr_zone.basis, session.note, session_set.note,
 * cardio_block.note and load_change.reason — are readable and their keys are gone. Only `legacy_audit_entry.reason`
 * stays: add_legacy_audit_entry records the imported Sheets history, and no read exposes it (a deliberate record,
 * decision 168, not a gap).
 * The stale check below fails when a listed field becomes readable, but only through what PRIVACY_TABLE's inputs
 * reach (their dates and windows); a read that returns it only for other inputs goes unseen.
 */
const UNREAD_FOR_OWNER: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    ["asha", "noor"].flatMap((o) => [[`${o}/legacy_audit_entry.reason`, "an import audit read (none exists)"]]),
  ),
};

/** The needles of an owner's canaried fields listed in UNREAD_FOR_OWNER. */
function unreadNeedles(owner: MemberKey): string[] {
  const own = Object.keys(UNREAD_FOR_OWNER).filter((k) => k.startsWith(`${owner}/`)).map((k) => k.slice(owner.length + 1));
  return CANARIES.filter((c) => c.member === CANARY_MEMBER[owner] && c.kind === "text" && own.includes(`${c.table}.${c.field}`)).map(needle);
}

test.describe("the exemption set", () => {
  test("names only canaries that exist", { tag: "@fast" }, () => {
    const real = new Set(CANARIES.filter((c) => c.kind === "text").map((c) => `${c.member.toLowerCase()}/${c.table}.${c.field}`));
    expect(Object.keys(UNREAD_FOR_OWNER).filter((k) => !real.has(k))).toEqual([]);
  });
});

// ---- the positive control, whole (ruling 3) -----------------------------------------------

for (const owner of MEMBERS) {
  for (const width of WIDTHS) {
    test.describe(`${owner} reaching their own data at ${width}`, () => {
      test.use({ viewer: owner, viewport: { width, height: width === 390 ? 844 : 900 } });
      test(`every canary of ${owner}'s shows in their app visits or their own reads`, async ({ page, names, slot, today, request }) => {
        let seen = "";
        for (const family of FAMILIES) seen += await visit(page, family, names[owner], width >= 1024);
        const writes = new Set<string>(((await (await request.get("/tools")).json()) as { tools: { name: string; write: boolean }[] }).tools.filter((t) => t.write).map((t) => t.name));
        const self = ownerOf(slot.persist, owner, names[owner], today);
        seen += (await answersFor(page.context().request, slot.persist, self, "read", writes)).map((a) => a.body).join("\n");
        const exempt = unreadNeedles(owner);
        const missing = needlesOf(owner).filter((n) => !exempt.includes(n) && found(seen, [n]).length === 0);
        expect(missing, `canaries ${owner} can't reach by any read: a finding to report, never a canary to drop`).toEqual([]);
        expect(found(seen, exempt), `UNREAD_FOR_OWNER fields ${owner} can now read: remove them from the set`).toEqual([]);
      });
    });
  }
}
