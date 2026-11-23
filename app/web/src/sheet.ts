/**
 * The "+" sheet's state (spec §2): which tab, who the entry is for, the
 * date and the meal. The meal follows the household's clock (whoami.time),
 * never the phone's; the date is the day being viewed.
 */
import type { Who } from "./load";
import type { BodyState } from "./reading";

export type SheetTab = "food" | "workout" | "set" | "reading" | "text";
export const SHEET_TABS: { tab: SheetTab; label: string }[] = [
  { tab: "food", label: "Food" },
  { tab: "workout", label: "Workout" },
  { tab: "set", label: "Set" },
  { tab: "reading", label: "Reading" },
  { tab: "text", label: "Tell Claude" },
];
export const MEAL_SLOTS = ["breakfast", "lunch", "snack", "dinner", "pre_workout", "post_workout"] as const;
export type MealSlot = (typeof MEAL_SLOTS)[number];

export interface SheetTarget {
  tab: SheetTab;
  slot?: MealSlot;
  exercise?: string;
  /** A set's programme session, from a later session's card (click test P2-16). */
  template?: string;
  member?: string;
  date?: string;
  workoutId?: number;
  metric?: string;
  bodyState?: BodyState;
}

export interface SheetState {
  tab: SheetTab;
  forMember: string;
  date: string;
  slot: MealSlot;
  exercise: string | null;
  /** The programme session a set starts, when opened from a later session's card. */
  template: string | null;
  workoutId: number | null;
  metric: string | null;
  bodyState: BodyState | null;
  /** The "for" member an owner-only tab set aside; given back when the sheet leaves that tab. */
  heldFor: string | null;
}

/** Breakfast until 10:30, lunch until 15:00, snack until 18:30, then dinner. */
export function slotForTime(time: string | undefined): MealSlot {
  // Deploy-window fallback: a Worker from before whoami gave `time` sends none. Fall back to breakfast (the slot stays visible and editable) rather than throw.
  const [h, m] = (time ?? "").split(":").map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return "breakfast";
  const minutes = h * 60 + m;
  if (minutes < 10 * 60 + 30) return "breakfast";
  if (minutes < 15 * 60) return "lunch";
  if (minutes < 18 * 60 + 30) return "snack";
  return "dinner";
}

/** Tabs for owner-only records: always the signed-in member's (the API refuses a member's call about another's). */
export const OWN_ONLY_TABS: readonly SheetTab[] = ["reading"];
const ownOnly = (tab: SheetTab) => OWN_ONLY_TABS.includes(tab);

export function openSheet(who: Who, place: { date: string | null }, target: SheetTarget): SheetState {
  const asked = target.member ?? who.member;
  return {
    tab: target.tab,
    forMember: ownOnly(target.tab) ? who.member : asked,
    date: target.date ?? place.date ?? who.today,
    slot: target.slot ?? slotForTime(who.time),
    exercise: target.exercise ?? null,
    template: target.template ?? null,
    workoutId: target.workoutId ?? null,
    metric: target.metric ?? null,
    bodyState: target.bodyState ?? null,
    heldFor: ownOnly(target.tab) && asked !== who.member ? asked : null,
  };
}

/**
 * The "+" opened again (a meal's Add, Train, the strip, Progress, N or
 * Shift+N beside the open panel). A busy sheet (a send held for "Try
 * again", or a save going through) keeps its state, the same object so its
 * tab stays mounted with the plan's keys; the caller only gives focus back
 * to it. Otherwise it opens on the new target.
 */
export function reopenSheet(current: SheetState | null, busy: boolean, next: SheetState): SheetState {
  return current && busy ? current : next;
}

/**
 * Another tab. An owner-only tab is always for the signed-in member, and
 * holds the member it set aside; leaving it gives that member back, so
 * Food for Kabir, Reading, then Food again is for Kabir.
 */
export function switchTab(who: Who, state: SheetState, tab: SheetTab): SheetState {
  const leaving = ownOnly(state.tab);
  const entering = ownOnly(tab);
  if (entering && !leaving) return { ...forMember(state, who.member), tab, heldFor: state.forMember === who.member ? null : state.forMember };
  if (leaving && !entering) return { ...forMember(state, state.heldFor ?? state.forMember), tab, heldFor: null };
  return { ...state, tab };
}

/**
 * Another "for" member, or another day (review P1-1): a set's template
 * from a later session's card belongs to that member's day, so it goes
 * with either change, and a set for Kabir or for yesterday never starts
 * the card's session.
 */
export function forMember(state: SheetState, member: string): SheetState {
  return member === state.forMember ? state : { ...state, forMember: member, template: null };
}

export function forDate(state: SheetState, date: string): SheetState {
  return date === state.date ? state : { ...state, date, template: null };
}

/** The template a Set Save sends: only for today, the day the card's session would start early. */
export function setTemplate(state: SheetState, today: string): string | null {
  return state.template && state.date === today ? state.template : null;
}

/** Said in place of the for chips on an owner-only tab. */
export function ownOnlyNotice(state: SheetState): string | null {
  return ownOnly(state.tab)
    ? "Readings are private, so you log only your own. For someone else's, tell Claude in chat: it becomes their draft for them to confirm."
    : null;
}

export function forChips(who: Who, state: SheetState) {
  return who.members.map((name) => ({ name, selected: name === state.forMember, you: name === who.member }));
}

/** Saves for another member are their drafts (the API decides; the sheet says so). */
export function draftNotice(who: Who, state: SheetState): string | null {
  return state.forMember === who.member ? null : `${state.forMember} will confirm this.`;
}

/**
 * Where the sheet sits (desktop spec §3): the phone's modal bottom sheet,
 * or on a wide screen a side panel over the right column that leaves the
 * page usable (so not aria-modal). The same component either way.
 */
export function sheetPlacement(wide: boolean): { scrim: string; modal: true | undefined } {
  return wide ? { scrim: "sheet-scrim panel", modal: undefined } : { scrim: "sheet-scrim", modal: true };
}

/** The wide panel covers the "+", so it leaves the tab order and the accessibility tree while the panel is open. The phone never hides it. */
export function fabHidden(wide: boolean, isOpen: boolean): boolean {
  return wide && isOpen;
}

/**
 * What to give focus back to: the element the opener handed over (Safari and
 * Firefox on macOS don't focus a button on click, so activeElement is body),
 * else the focused element if it is a real control outside the sheet, else null.
 */
export function pickOpener<T extends { isConnected: boolean }>(from: T | null | undefined, active: T | null, inSheet: boolean, isBody: boolean): T | null {
  if (from) return from;
  return active && !inSheet && !isBody ? active : null;
}

/** Where focus goes on close: the opener while it is still on the page, else the "+". */
export function returnTarget<T extends { isConnected: boolean }>(opener: T | null, fab: T | null): T | null {
  return opener?.isConnected ? opener : fab?.isConnected ? fab : null;
}
