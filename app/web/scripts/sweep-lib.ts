/**
 * The layout sweep's pure parts (scripts/sweep-layout.ts), apart so tests
 * can import them without starting a browser or a Worker.
 */

/** A catalogue pane's record link, as its list shows it. */
export interface RecordLink {
  href: string;
  text: string;
}

const RECORD = /\/catalogue\/(food|recipe|workouts|exercises|gyms)\/./;

/** The records a pane is swept on (wide-layout spec §7): its first, its longest name and its last, each once. */
export function pickRecords(links: readonly RecordLink[]): string[] {
  const records = links.filter((l) => RECORD.test(l.href));
  const first = records[0];
  const last = records[records.length - 1];
  if (!first || !last) return [];
  const longest = records.reduce((m, l) => (l.text.trim().length > m.text.trim().length ? l : m), first);
  return [...new Set([first.href, longest.href, last.href])];
}

/** The fold (wide-layout spec §1, §7): at 1,920 × 1,080 a state's primary object starts in the top 400 px of the page. */
export const FOLD_PX = 400;
export const FOLD_FROM = 1920;

export interface FoldFlag {
  kind: "fold";
  where: string;
  text: string;
  by: number;
}

/** `top`: the primary object's top edge from the top of the page, or null when it isn't there. */
export function foldFlag(primary: string, top: number | null): FoldFlag | null {
  if (top === null) return { kind: "fold", where: primary, text: "the primary object is not on the page", by: 0 };
  if (top <= FOLD_PX) return null;
  return { kind: "fold", where: primary, text: `starts ${Math.round(top)} px down`, by: Math.round(top - FOLD_PX) };
}

/**
 * The phone check's allow-list (wide-layout spec §7): a state named here, or
 * whose name starts with "<name>-" or ends with "-<name>" (its variants and
 * the sheets over it), may differ; its diff is written for a person to read.
 */
export function allowed(state: string, allow: readonly string[]): boolean {
  return allow.some((a) => state === a || state.startsWith(`${a}-`) || state.endsWith(`-${a}`));
}
