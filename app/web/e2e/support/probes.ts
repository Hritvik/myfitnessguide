/**
 * A journey step's effects (e2e spec §4): each probe names a screen, a
 * locator and the expected change. Before the step every probe is read; after
 * it, each `changes` probe must change (polled: the app refreshes on its own),
 * optionally to a number from the write's own answer, and each `same` probe
 * must read exactly as before.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { settle } from "./settle.ts";
import { escapeRe } from "./ui.ts";

export interface Probe {
  label: string;
  read(): Promise<string>;
  /** Why this probe may read "(absent)" as a `same` probe (mayBeAbsent); without it, "(absent)" fails the step. */
  absentOk?: string;
}

/** What a probe reads when its locator matches nothing. */
export const ABSENT = "(absent)";

/**
 * A `same` probe that may legitimately match nothing before and after (it pins that something stays absent),
 * with the reason. Without this, a `same` probe reading "(absent)" fails: a mistyped locator, or a member
 * without the value, would otherwise prove nothing (F18).
 */
export const mayBeAbsent = (p: Probe, reason: string): Probe => ({ ...p, absentOk: reason });

export function probe(page: Page, path: string, label: string, find: (p: Page) => Locator, prepare?: (p: Page) => Promise<void>): Probe {
  return {
    label,
    async read() {
      await page.goto(path);
      await settle(page);
      if (prepare) await prepare(page);
      const l = find(page);
      if ((await l.count()) === 0) return ABSENT;
      return (await l.allInnerTexts()).join(" | ").replace(/\s+/g, " ").trim();
    },
  };
}

/**
 * A probe of what the screen says to assistive technology rather than shows: each match's accessible name
 * (a pot's bar is a role="img" whose aria-label carries every share and the remainder; PotCard.tsx).
 */
export function nameProbe(page: Page, path: string, label: string, find: (p: Page) => Locator): Probe {
  return {
    label,
    async read() {
      await page.goto(path);
      await settle(page);
      const l = find(page);
      if ((await l.count()) === 0) return ABSENT;
      const names = await l.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
      return names.join(" | ");
    },
  };
}

/** A probe read over HTTP as a member (for a number the screen shows only at one width). */
export function apiProbe(label: string, read: () => Promise<unknown>): Probe {
  return { label, read: async () => JSON.stringify(await read()) };
}

export type Check = (after: string) => void | Promise<void>;

export async function step(label: string, act: () => Promise<void>, effects: { changes?: (Probe | [Probe, Check])[]; same?: Probe[] }): Promise<void> {
  await test.step(label, async () => {
    const changes = (effects.changes ?? []).map((c): [Probe, Check | null] => (Array.isArray(c) ? [c[0], c[1]] : [c, null]));
    const before = new Map<Probe, string>();
    for (const [p] of changes) before.set(p, await p.read());
    for (const p of effects.same ?? []) {
      const read = await p.read();
      if (read === ABSENT && !p.absentOk) throw new Error(`${label}: ${p.label} matched nothing, so "same" proves nothing (mark it mayBeAbsent with a reason if it should stay absent)`);
      before.set(p, read);
    }
    await act();
    for (const [p, check] of changes) {
      await expect.poll(() => p.read(), { message: `${label}: ${p.label} should change`, timeout: 15_000 }).not.toBe(before.get(p));
      if (check) await check(await p.read());
    }
    for (const p of effects.same ?? []) expect(await p.read(), `${label}: ${p.label} should not change`).toBe(before.get(p));
  });
}

/** The app's whole-number format (format.ts `n`): rounded, grouped en-IN, the sign shown by the screen's words. */
const WHOLE = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/**
 * The screen's number comes from the write's own answer (spec §4): the probe
 * shows exactly the field `pick` names, as the app formats it (with its unit),
 * not merely some number the answer holds (F18).
 */
export function fromAnswer(answer: () => Promise<unknown>, pick: (answer: any) => number, unit = ""): Check {
  return async (after) => {
    const number = WHOLE.format(Math.round(Math.abs(pick(await answer()))));
    const want = `${number}${unit ? ` ${unit}` : ""}`;
    // A whole token: no digit, or a grouping or decimal mark, on either side ("12" is not in "120" or "112", "1,862" not in "11,862").
    // A "+" may follow the number: a total that leaves out unknown items says so (web decision 118, "1,862+ kcal").
    const re = `(?<![\\d.,])${escapeRe(number)}\\+?${unit ? ` ${escapeRe(unit)}` : ""}(?![\\d]|[.,+]\\d)`;
    expect(after, `the screen shows ${want}, the write's own answer`).toMatch(new RegExp(re));
  };
}
