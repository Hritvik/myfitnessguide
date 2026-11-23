/**
 * The Household tab (spec §7): household_overview worded. What is left,
 * deadlines and amounts are the API's; the signs of "over by" and the
 * percent of the pot are formatting.
 */
import { atLeast, atMostWord, day, n, pct, plural, sentenceCase, unknownCount, unknownTail } from "./format";
import type { Who } from "./load";
import { hrefOf } from "./route";
import { waitsText } from "./strip";
import { potCard, type PotCard } from "./today";
import type { HouseholdOverview, UnknownItems } from "./types";

export interface MemberRow {
  name: string;
  you: boolean;
  left: string;
  status: string;
  drafts: string | null;
  last: string | null;
  href: string;
}

export interface LeftoverRow {
  componentId: number;
  /** The leftover's share of the whole pot, for a part eaten. */
  fraction: number;
  title: string;
  amount: string;
  since: string;
  /** Who may be marked as having eaten it: everyone on today's date, no one on a past day (read-only in v1). */
  eaters: string[];
  discardable: boolean;
}

export interface HouseholdView {
  members: MemberRow[];
  meals: { date: string; label: string; pots: PotCard[] }[];
  leftovers: LeftoverRow[];
  waiting: { key: string; text: string }[];
  empty: { meals: string | null; leftovers: string | null; waiting: string | null };
}

const SESSION_WORD: Record<string, string> = { strength: "gym", class: "dance", cardio: "cardio" };

/** A member's left; when their day's sums leave out unknown items, at most what it reads, with the count (ticket 72, decision 118). */
function left(kcal: number | null, protein: number | null, unknown?: UnknownItems): string {
  if (kcal === null || protein === null) return "No target set";
  const uk = unknown?.kcal ?? 0;
  const up = unknown?.protein ?? 0;
  const tail = unknownTail(unknownCount(unknown));
  const p = protein >= 0 ? `${atMostWord(up)}${n(protein)} g protein left` : `over by ${atLeast(-protein, up)} g protein`;
  return kcal >= 0 ? `${sentenceCase(`${atMostWord(uk)}${n(kcal)} kcal and ${p}`)}${tail}` : `Over by ${atLeast(-kcal, uk)} kcal; ${p}${tail}`;
}

export function buildHousehold(o: HouseholdOverview, who: Who): HouseholdView {
  const tz = who.time_zone;
  const members = o.members.map((m) => ({
    name: m.member,
    you: m.you,
    left: left(m.kcal_left, m.protein_left, m.unknown_items),
    status: `Day ${m.day_status}`,
    drafts: m.drafts.oldest
      ? `${plural(m.drafts.count, "draft", "drafts")} waiting on ${m.you ? "you" : m.member}; the oldest ${waitsText(m.drafts.oldest, tz, m.you ? "waits for you" : "waits for them")}.`
      : null,
    last: m.last_session ? `Last session ${day(m.last_session.date)}, ${m.last_session.template ?? SESSION_WORD[m.last_session.session_type] ?? m.last_session.session_type}` : null,
    href: hrefOf({ route: { section: "today", date: null }, member: m.member === who.member ? null : m.member }),
  }));
  const meals = o.meals.map((meal) => ({ date: meal.date, label: day(meal.date), pots: meal.cooks.map((c) => potCard(c, false)) }));
  // A leftover action writes today's date, so a past day's leftovers are read-only.
  const today = o.date === who.today;
  const leftovers = o.leftovers.map((l) => ({
    componentId: l.component_id,
    fraction: l.fraction,
    title: l.component ? `${l.cook}, ${l.component}` : l.cook,
    amount: `${pct(l.fraction)} of the pot${l.kcal === null ? "" : `, about ${n(l.kcal)} kcal`}`,
    since: `Left over since ${day(l.since)}`,
    eaters: today ? who.members : [],
    discardable: today,
  }));
  const waiting = o.waiting.map((w) => ({ key: `${w.table}:${w.id}`, text: `${w.summary} for ${w.about}: ${waitsText(w, tz, "waits for them")}.` }));
  return {
    members,
    meals,
    leftovers,
    waiting,
    empty: {
      meals: meals.length === 0 ? "No shared meals in these three days." : null,
      leftovers: leftovers.length === 0 ? "No leftovers." : null,
      waiting: waiting.length === 0 ? "Nothing you logged is waiting." : null,
    },
  };
}

export interface GlanceRow {
  name: string;
  you: boolean;
  left: string;
  drafts: string;
}

/** Today's wide household column (desktop spec §3): each member's kcal and protein left and the drafts waiting on them, as household_overview gives them. */
export function glanceRows(o: HouseholdOverview): GlanceRow[] {
  return o.members.map((m) => ({ name: m.member, you: m.you, left: left(m.kcal_left, m.protein_left, m.unknown_items), drafts: m.drafts.count === 0 ? "None" : plural(m.drafts.count, "draft", "drafts") }));
}
