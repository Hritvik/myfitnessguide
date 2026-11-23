/** One spec per journey, run for each listed member at 390 and 1,440 px (e2e spec §4). */
import type { Page } from "@playwright/test";
import { test, type Api, type MemberKey, type Slot } from "./fixtures.ts";
import type { ToolLog } from "./network.ts";

export const JOURNEY_WIDTHS = [390, 1440] as const;

export interface J {
  me: MemberKey;
  other: MemberKey;
  width: number;
  wide: boolean;
  page: Page;
  as(m: MemberKey): Promise<Page>;
  observer(m: MemberKey): Promise<Page>;
  api(m?: MemberKey): Api;
  names: Record<MemberKey, string>;
  tools: ToolLog;
  today: string;
  yesterday: string;
  slot: Slot;
}

/**
 * Every journey that writes calls this: after each of its runs the slot gets a fresh copy of the seed and a new
 * Worker, so the next test on this worker (the file's other width, or another file) starts from the seed, as the
 * worker's first test does. Retries run on a new worker, which copies the seed too. A journey that writes nothing
 * (J13, J19, J23) leaves the seed as it was and needs no restart.
 */
export function fromTheSeed(): void {
  test.afterEach(async ({ slot }) => slot.restart());
}

export function journey(
  id: string,
  title: string,
  runs: readonly (MemberKey | readonly [MemberKey, MemberKey])[],
  body: (j: J) => Promise<void>,
  opts: { fast?: readonly MemberKey[] } = {},
): void {
  for (const width of JOURNEY_WIDTHS) {
    for (const run of runs) {
      const [me, other] = typeof run === "string" ? [run, run === "asha" ? ("kabir" as const) : ("asha" as const)] : run;
      test.describe(`${id} at ${width}, ${me}${typeof run === "string" ? "" : ` and ${other}`}`, () => {
        test.use({ viewer: me, viewport: { width, height: width === 390 ? 844 : 900 } });
        const fast = width === 390 && (opts.fast ?? []).includes(me);
        test(`${id} ${title}`, { tag: fast ? ["@fast"] : [] }, async ({ page, as, observer, api, names, tools, today, slot }) => {
          const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
          await body({ me, other, width, wide: width >= 1024, page, as, observer, api, names, tools, today, yesterday, slot });
        });
      });
    }
  }
}
