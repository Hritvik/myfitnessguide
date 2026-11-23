/**
 * Reads who is signed in, and everything the Today screen shows for one member's day, in
 * parallel, from existing tools plus the screen tools (whoami, day_meals,
 * day_cooks). needs_you is owner-only, so it is read only
 * on your own today; a footer read that fails leaves that row out. The
 * Tell Claude texts you sent about the member shown, still pending
 * (inbox_entries), are read alongside; a failed read shows none.
 */
import type { Outcome } from "./api";
import { addDays } from "./dates";
import { WAITING_INPUT, waitingAbout } from "./freetext";
import { nutritionFrom, type NutritionData, type NutritionPage } from "./nutrition";
import type { ProgressSummaryData, TrajectoryData } from "./progress";
import { RANGE_DAYS, type Range } from "./route";
import type { TrainData } from "./train";
import type { BloodDraws, BodyTrends, Flags, ProgressSummary, WeekSummary, DayCooks, DayMeals, DayTotals, HouseholdOverview, InboxEntry, InventoryGaps, LiftDetail, LiftTrends, NeedsYou, NextPrescription, NutritionTrends, PrepTaskView, SessionsList, TodayData, WhoAmI } from "./types";

export type Call = (tool: string, input: Record<string, unknown>) => Promise<Outcome>;

/** The signed-in member; an agent identity has none, so the app treats it as signed out. */
export type Who = WhoAmI & { member: string };

type Failure = Exclude<Outcome, { kind: "ok" }>;

export async function loadWho(call: Call): Promise<Outcome<Who>> {
  const who = await call("whoami", {});
  if (who.kind !== "ok") return who as Failure;
  const me = who.data as unknown as WhoAmI;
  if (me.member === null) return { kind: "signed_out", http: 403 };
  return { kind: "ok", data: me as Who };
}

export async function loadToday(call: Call, options: { who: Who; viewing: string; date: string | null }): Promise<Outcome<TodayData>> {
  const { who, viewing } = options;
  const date = options.date ?? who.today;
  const own = viewing === who.member;
  const day = { member: viewing, date };

  const [totals, meals, cooks, prep, needs, next, inbox] = await Promise.all([
    call("day_totals", day),
    call("day_meals", day),
    call("day_cooks", day),
    call("day_prep", day),
    own && date === who.today ? call("needs_you", { member: viewing }) : null,
    call("next_prescription", { member: viewing, date }),
    // Your texts still waiting for Claude (decision 75): the Worker gives only the texts you sent, naming nobody (decision 110).
    call("inbox_entries", { ...WAITING_INPUT }),
  ]);
  const core = [totals, meals, cooks];
  for (const kind of ["signed_out", "offline", "error", "invalid", "needs_clarification"] as const) {
    const failed = core.find((o) => o.kind === kind);
    if (failed) return failed as Failure;
  }
  const optional = <T>(o: Outcome | null): T | null => (o?.kind === "ok" ? (o.data as unknown as T) : null);
  return {
    kind: "ok",
    data: {
      me: who.member,
      members: who.members,
      today: who.today,
      viewing,
      date,
      totals: optional<DayTotals>(totals) as DayTotals,
      meals: optional<DayMeals>(meals) as DayMeals,
      cooks: optional<DayCooks>(cooks) as DayCooks,
      needs: optional<NeedsYou>(needs),
      prep: optional<{ tasks: PrepTaskView[] }>(prep)?.tasks ?? [],
      timeZone: who.time_zone,
      next: optional<NextPrescription>(next),
      waiting: waitingAbout(optional<{ entries: InboxEntry[] }>(inbox)?.entries ?? [], viewing).filter((e) => e.date === date),
    },
  };
}

/** What Today's load depends on: whose day, and which day (the household's today when none is named). */
export const todayKey = (who: Who, viewing: string, date: string | null): string => `today|${viewing}|${date ?? who.today}`;

/** Train: the next session, and on your own view your gym's one open question. */
export async function loadTrain(call: Call, options: { who: Who; viewing: string; from: string | null }): Promise<Outcome<TrainData>> {
  const own = options.viewing === options.who.member;
  const [next, gaps, sessions] = await Promise.all([
    call("next_prescription", { member: options.viewing }),
    own ? call("inventory_gaps", { member: options.viewing }) : null,
    call("sessions", { member: options.viewing, ...(options.from ? { from: options.from } : {}) }),
  ]);
  if (next.kind !== "ok") return next as Failure;
  return {
    kind: "ok",
    data: {
      own,
      viewing: options.viewing,
      next: next.data as unknown as NextPrescription,
      gaps: gaps?.kind === "ok" ? (gaps.data as unknown as InventoryGaps) : null,
      history: sessions.kind === "ok" ? (sessions.data as unknown as SessionsList) : null,
    },
  };
}

/** The eight weeks before `before` (the oldest date already shown), read on their own so the page stays as it is. */
export async function loadEarlierSessions(call: Call, options: { viewing: string; before: string }): Promise<Outcome<SessionsList>> {
  const out = await call("sessions", { member: options.viewing, from: addDays(options.before, -56), to: addDays(options.before, -1) });
  return out.kind === "ok" ? { kind: "ok", data: out.data as unknown as SessionsList } : (out as Failure);
}

/**
 * Progress: the unified summary (progress_summary, spec §Unified Progress read
 * model). Owner-only through the Worker; the range doubles as the model's
 * period, since both name the same five spans.
 */export async function loadProgressSummary(call: Call, options: { who: Who; viewing: string; range: Range }): Promise<Outcome<ProgressSummaryData>> {
  const { who, viewing, range } = options;
  if (viewing !== who.member) return { kind: "ok", data: { private: true, message: `Progress is private to ${viewing}.` } };
  const out = await call("progress_summary", { member: viewing, period: range, as_of: who.today });
  if (out.kind !== "ok") return out as Failure;
  return { kind: "ok", data: { private: false, today: who.today, range, summary: out.data as unknown as ProgressSummary } };
}

/**
 * Progress: Trajectory. Private for anyone but you, with no calls at all.
 * Two reads in parallel: the headline (body_trends resolves which metric
 * leads, with its direction, in the same call) and the 7-day weight.
 */
export async function loadTrajectory(call: Call, options: { who: Who; viewing: string; range: Range }): Promise<Outcome<TrajectoryData>> {
  const { who, viewing, range } = options;
  if (viewing !== who.member) return { kind: "ok", data: { private: true, message: `Progress is private to ${viewing}.` } };
  const from = range === "all" ? null : addDays(who.today, 1 - RANGE_DAYS[range]);
  const span = from ? { from, to: who.today } : { to: who.today };
  const [lead, weight] = await Promise.all([
    call("body_trends", { member: viewing, metric: "headline", ...span }),
    call("body_trends", { member: viewing, metric: "weight", ...span }),
  ]);
  if (lead.kind !== "ok") return lead as Failure;
  return {
    kind: "ok",
    data: { private: false, today: who.today, range, from, lead: lead.data as unknown as BodyTrends, weight: weight.kind === "ok" ? (weight.data as unknown as BodyTrends) : null },
  };
}

const privateTo = (viewing: string) => ({ kind: "ok" as const, data: { private: true as const, message: `Progress is private to ${viewing}.` } });

export async function loadWeek(call: Call, options: { who: Who; viewing: string; week: string | null }): Promise<Outcome<{ private: true; message: string } | { private: false; today: string; summary: WeekSummary }>> {
  if (options.viewing !== options.who.member) return privateTo(options.viewing);
  const out = await call("week_summary", { member: options.viewing, ...(options.week ? { week: options.week } : {}) });
  if (out.kind !== "ok") return out as Failure;
  return { kind: "ok", data: { private: false, today: options.who.today, summary: out.data as unknown as WeekSummary } };
}

export async function loadHealth(call: Call, options: { who: Who; viewing: string }): Promise<Outcome<{ private: true; message: string } | { private: false; draws: BloodDraws; flags: Flags }>> {
  if (options.viewing !== options.who.member) return privateTo(options.viewing);
  const [draws, flags] = await Promise.all([call("blood_draws", { member: options.viewing }), call("flags", { member: options.viewing, status: "open" })]);
  if (draws.kind !== "ok") return draws as Failure;
  if (flags.kind !== "ok") return flags as Failure;
  return { kind: "ok", data: { private: false, draws: draws.data as unknown as BloodDraws, flags: flags.data as unknown as Flags } };
}

export async function loadHousehold(call: Call, options: { date: string | null }): Promise<Outcome<HouseholdOverview>> {
  const out = await call("household_overview", options.date ? { date: options.date } : {});
  if (out.kind !== "ok") return out as Failure;
  return { kind: "ok", data: out.data as unknown as HouseholdOverview };
}

/** Load the requested range once, then fetch exactly the older pages the Worker returns. */
export async function loadNutrition(call: Call, options: { who: Who; viewing: string; range: Range }): Promise<Outcome<NutritionData>> {
  const from = nutritionFrom(options.range, options.who.today);
  const first = await call("nutrition_trends", { member: options.viewing, ...(from ? { from } : {}) });
  if (first.kind !== "ok") return first as Failure;
  const data = first.data as unknown as NutritionTrends;
  const pages = await Promise.all(data.pages.map(async (page): Promise<NutritionPage> => {
    const out = await call("nutrition_trends", { member: options.viewing, from: page.from, to: page.to });
    return out.kind === "ok" ? { from: page.from, to: page.to, data: out.data as unknown as NutritionTrends } : { from: page.from, to: page.to, failed: true };
  }));
  return { kind: "ok", data: { viewing: options.viewing, today: options.who.today, range: options.range, first: data, pages } };
}

export interface LiftsData { list: LiftTrends; detail: LiftDetail | null }

/** Lifts are household-visible. The index and optional detail are independent Worker projections loaded together. */
export async function loadLifts(call: Call, options: { viewing: string; exerciseId: number | null }): Promise<Outcome<LiftsData>> {
  const [list, detail] = await Promise.all([
    call("lift_trends", { member: options.viewing }),
    options.exerciseId === null ? null : call("lift_trends", { member: options.viewing, exercise_id: options.exerciseId }),
  ]);
  if (list.kind !== "ok") return list as Failure;
  if (detail && detail.kind !== "ok") return detail as Failure;
  return { kind: "ok", data: { list: list.data as unknown as LiftTrends, detail: detail ? detail.data as unknown as LiftDetail : null } };
}
