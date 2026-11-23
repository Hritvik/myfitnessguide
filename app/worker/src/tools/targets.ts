import { belowBmr, resolveTarget } from "@myfitnessguide/domain";
import { z } from "zod";
import type { Ctx } from "../context";
import { first } from "../db";
import { Clarify, ToolError } from "../errors";
import { domainTarget, loadTarget } from "../nutrition";
import { readTool, writeTool, type Tool } from "../tool";

const GROUP = "body";
const NUTRIENTS = [
  "kcal", "protein_g", "carbs_g", "fat_g", "fibre_g", "sodium_mg", "iron_mg", "b12_ug", "calcium_mg", "magnesium_mg",
  "potassium_mg", "sat_fat_g", "total_sugars_g", "vitamin_c_mg",
] as const;

function resolved(values: { nutrient: string; kind: string; value: number | null }[]) {
  const t = domainTarget(values as never);
  if (!t) return null;
  try {
    return resolveTarget(t);
  } catch (error) {
    throw new ToolError("invalid_target", (error as Error).message, 400);
  }
}

const targets = readTool({
  name: "targets",
  group: GROUP,
  description: "A member's intake target in force on a date (default today): its values, reasoning, and the resolved macros (floors and the remainder macro). The reasoning is owner-only (it cites readings and bloods): another member gets the values without it.",
  input: { member: z.string().min(1), date: z.iso.date().optional() },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    const date = input.date ?? ctx.today();
    const t = await loadTarget(ctx, member.id, date);
    if (!t) return { member: member.name, date, target: null };
    return {
      member: member.name,
      date,
      // The numbers are household-visible (kcal and protein left); the reasoning cites BMR, BIA and bloods (decision 135).
      target: { id: t.row.id, effective_from: t.row.effective_from, provenance: t.row.provenance, ...(ctx.canSee(member.id) ? { reasoning: t.row.reasoning } : {}), values: t.values },
      resolved: resolved(t.values),
    };
  },
});

const setTarget = writeTool({
  name: "set_target",
  group: GROUP,
  description:
    "Create a new effective-dated intake target version for a member, preserving earlier targets. Use this when the member asks to change calories or macros. Give the reasoning and values per nutrient: target, floor, ceiling, remainder (no value: whatever kcal is left), or reference_intake. If a target version already begins on that date, this asks for a different effective date rather than overwriting history. Warns when kcal sits below BMR: bmr_kcal as given, else the member's latest measured BIA BMR. Only the member or the agent sets it.",
  input: {
    member: z.string().min(1),
    effective_from: z.iso.date(),
    provenance: z.enum(["agent", "member", "professional", "import"]),
    reasoning: z.string().min(1),
    values: z
      .array(
        z.object({
          nutrient: z.enum(NUTRIENTS),
          kind: z.enum(["target", "floor", "ceiling", "remainder", "reference_intake"]),
          value: z.number().min(0).optional(),
        }).strict(),
      )
      .min(1),
    bmr_kcal: z.number().positive().optional(),
  },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    // A target is its member's to set, as amend decides (decision 138).
    ctx.assertCanSee("target", member.id);
    ctx.onBehalfOf(member.id);
    const existing = await first<{ id: number }>(ctx.db, "SELECT id FROM target WHERE member_id = ? AND effective_from = ?", member.id, input.effective_from);
    if (existing) {
      throw new Clarify("target_exists", `${member.name} already has a target from ${input.effective_from}; amend it, or pick another date.`, [existing.id], ["effective_from"]);
    }
    for (const [i, v] of input.values.entries()) {
      if ((v.kind === "remainder") !== (v.value === undefined)) {
        throw new Clarify("value_needed", v.kind === "remainder" ? "A remainder has no value." : `What is the ${v.nutrient} ${v.kind}?`, [], ["values", i, "value"]);
      }
    }
    const values = input.values.map((v) => ({ nutrient: v.nutrient, kind: v.kind, value: v.value ?? null }));
    const macros = resolved(values);
    const id = await ctx.txOrThrow.create("target", {
      member_id: member.id, effective_from: input.effective_from, provenance: input.provenance, reasoning: input.reasoning, created_at: ctx.nowIso(),
    });
    for (const v of values) ctx.txOrThrow.raw("target_value", { target_id: id, ...v });
    const kcal = values.find((v) => v.nutrient === "kcal" && v.kind === "target")?.value;
    // BMR: as given, else the member's latest measured BIA BMR on or before the date (the caller is the member or the agent).
    let bmr: { kcal: number; source: "given" | "reading" } | null = input.bmr_kcal !== undefined ? { kcal: input.bmr_kcal, source: "given" } : null;
    if (bmr === null) {
      const latest = await first<{ value: number }>(
        ctx.db,
        "SELECT value FROM reading WHERE member_id = ? AND metric = 'bia_bmr_kcal' AND state = 'confirmed' AND measured_on <= ? ORDER BY measured_on DESC, id DESC LIMIT 1",
        member.id,
        input.effective_from,
      );
      if (latest) bmr = { kcal: latest.value, source: "reading" };
    }
    return {
      target: { id, member: member.name, effective_from: input.effective_from, values },
      resolved: macros,
      below_bmr: bmr !== null && kcal !== undefined && kcal !== null ? { ...belowBmr(kcal, bmr.kcal), bmr_kcal: bmr.kcal, bmr_source: bmr.source } : null,
      state: "confirmed",
    };
  },
});

export const TARGET_TOOLS: Tool[] = [targets, setTarget];
