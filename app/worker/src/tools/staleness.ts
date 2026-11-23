/**
 * Measurement cadences and staleness: what a member should measure or do
 * how often, and which of those are overdue (the old gap_registry and
 * gymcalc's staleness_top2, now the domain's stalenessTop over data).
 */
import { daysBetween, stalenessTop, type StalenessItem } from "@myfitnessguide/domain";
import { z } from "zod";
import type { Ctx, Member } from "../context";
import { all, first, type Row } from "../db";
import { Clarify } from "../errors";
import { fuzzyRank } from "../fuzzy";
import { readTool, writeTool, type Tool } from "../tool";
import { cadenceStatus, findExercise, type CadenceRow } from "../training";

const GROUP = "health";
const date = z.iso.date();

const SOURCE = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("reading"),
      metric: z.string().min(1).describe("A metric code, e.g. waist_navel or weight."),
      body_state: z.enum(["fasted", "fed", "post_exercise"]).optional().describe("Only readings in this state count (a fasted weight)."),
    })
    .strict(),
  z.object({ kind: z.literal("cardio_hr") }).strict().describe("Any cardio block with a heart rate."),
  z.object({ kind: z.literal("exercise"), exercise: z.string().min(1).describe("Exercise name or alias.") }).strict(),
  z
    .object({ kind: z.literal("manual"), last_done_on: date.optional().describe("When it was last done; nothing in the app records it.") })
    .strict(),
]);

/** Cadences are about a member's readings, so they are owner-only like readings. */
async function ownMember(ctx: Ctx, ref: string): Promise<Member> {
  const member = await ctx.member(ref);
  ctx.assertCanSee("reading", member.id);
  return member;
}

async function describeCadence(ctx: Ctx, c: CadenceRow) {
  let source: Record<string, unknown>;
  if (c.source === "reading") source = { kind: "reading", metric: c.metric, ...(c.body_state ? { body_state: c.body_state } : {}) };
  else if (c.source === "exercise") {
    const e = await first<{ name: string }>(ctx.db, "SELECT name FROM exercise WHERE id = ?", c.exercise_id as number);
    source = { kind: "exercise", exercise: e?.name ?? null };
  } else if (c.source === "manual") source = { kind: "manual", last_done_on: c.last_done_on };
  else source = { kind: c.source };
  return { id: c.id, name: c.name, every_days: c.every_days, source, message: c.message, active: c.active === 1 };
}

const staleness = readTool({
  name: "staleness",
  group: GROUP,
  description:
    "What a member is overdue to measure or do, from their measurement cadences: `raise` holds at most `limit` (default 2) messages worth raising, never-done first, then the most overdue. `cadences` gives each one's last date, days since and days overdue. Owner-only.",
  input: {
    member: z.string().min(1),
    date: date.optional().describe("Today, by default."),
    limit: z.number().int().min(1).max(10).optional(),
  },
  async run(ctx, input) {
    const member = await ownMember(ctx, input.member);
    const today = input.date ?? ctx.today();
    const statuses = await cadenceStatus(ctx, member.id, today);
    const items: StalenessItem[] = [];
    const cadences = [];
    for (const { cadence: c, last } of statuses) {
      items.push({ name: c.name, last, everyDays: c.every_days, message: c.message });
      const daysSince = last === null ? null : daysBetween(last, today);
      cadences.push({
        ...(await describeCadence(ctx, c)),
        last,
        days_since: daysSince,
        overdue_days: daysSince !== null && daysSince > c.every_days ? daysSince - c.every_days : null,
      });
    }
    return { member: member.name, date: today, raise: stalenessTop(items, today, input.limit ?? 2), cadences };
  },
});

const setMeasurementCadence = writeTool({
  name: "set_measurement_cadence",
  group: GROUP,
  description:
    "Create or change one of a member's measurement cadences, by name: how often (every_days), where its last date comes from (a reading of a metric, cardio heart rate, an exercise, or a manual last_done_on), and the message to raise when it's overdue. active: false stops raising it.",
  input: {
    member: z.string().min(1),
    name: z.string().regex(/^[a-z][a-z0-9_]*$/, "lower snake_case").describe("A short key, e.g. waist or fasted_weight."),
    every_days: z.number().int().min(1).max(366),
    source: SOURCE,
    message: z.string().min(1).describe("What to say when it's overdue."),
    active: z.boolean().optional(),
  },
  async run(ctx, input) {
    const member = await ownMember(ctx, input.member);
    ctx.onBehalfOf(member.id);
    const s = input.source;
    let metric: string | null = null;
    let exerciseId: number | null = null;
    if (s.kind === "reading") {
      const codes = (await all<{ code: string }>(ctx.db, "SELECT code FROM metric ORDER BY code")).map((m) => m.code);
      metric = s.metric.trim().toLowerCase();
      if (!codes.includes(metric)) {
        const options = fuzzyRank(s.metric, codes.map((c) => ({ item: c, names: [c, c.replace(/_/g, " ")] })));
        throw new Clarify("unknown_metric", `Which metric is ${s.metric}?`, options.length > 0 ? options : codes, ["source", "metric"]);
      }
    }
    if (s.kind === "exercise") exerciseId = (await findExercise(ctx, s.exercise, ["source", "exercise"])).id;
    const row: Row = {
      member_id: member.id, name: input.name, every_days: input.every_days, source: s.kind, metric,
      body_state: s.kind === "reading" ? (s.body_state ?? null) : null, exercise_id: exerciseId,
      last_done_on: s.kind === "manual" ? (s.last_done_on ?? null) : null, message: input.message, active: input.active === false ? 0 : 1,
    };
    const tx = ctx.txOrThrow;
    const existing = await first<CadenceRow>(ctx.db, "SELECT * FROM measurement_cadence WHERE member_id = ? AND name = ?", member.id, input.name);
    let id: number;
    if (existing) {
      id = existing.id;
      tx.update("measurement_cadence", id, row, { ...existing, ...row });
    } else {
      id = await tx.create("measurement_cadence", row);
    }
    return { action: existing ? "updated" : "created", cadence: await describeCadence(ctx, { id, ...row } as unknown as CadenceRow) };
  },
});

export const STALENESS_TOOLS: Tool[] = [staleness, setMeasurementCadence];
