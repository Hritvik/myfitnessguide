import type { Cook, CookResult, NutrientTotals, Portion, RemainderMark } from "../types";
import { scaleNutrients, scaleTotals, sumNutrients } from "./totals";

const DEFAULT_COMPONENT = "main";
/** Shares within this of the whole count as the whole. */
const SHARE_EPS = 1e-9;

/**
 * Recompute a cook from its lines: each component's nutrients, each
 * portion's share of them, and the remainder no portion accounts for.
 * A portion stores only its share, so editing a line, the cooked weight or
 * a share recomputes every eater. Problems are reported, never thrown.
 */
export function recomputeCook(
  cook: Cook,
  portions: readonly Portion[],
  remainderMarks: readonly RemainderMark[] = [],
): CookResult {
  const problems: string[] = [];
  const names: string[] = [];
  for (const c of cook.components ?? []) if (!names.includes(c.name)) names.push(c.name);
  for (const line of cook.lines) {
    const name = line.component ?? DEFAULT_COMPONENT;
    if (!names.includes(name)) names.push(name);
  }

  const components = names.map((name) => {
    const lines = cook.lines.filter((l) => (l.component ?? DEFAULT_COMPONENT) === name);
    const declared = cook.components?.find((c) => c.name === name)?.cookedWeightG;
    const cookedWeightG = declared ?? (names.length === 1 ? cook.cookedWeightG : undefined) ?? null;
    return {
      name,
      cookedWeightG,
      totals: sumNutrients(lines.map((l) => scaleNutrients(l.source.nutrients, l.multiples))),
    };
  });

  const portionResults = portions.map((p) => {
    const name = p.component ?? (names.length === 1 ? (names[0] as string) : DEFAULT_COMPONENT);
    const component = components.find((c) => c.name === name);
    if (!component) {
      problems.push(`${p.member}'s portion is of ${name}, which this cook does not have`);
      return { member: p.member, component: name, fraction: null, nutrients: null };
    }
    let fraction: number | null;
    if ("fraction" in p.share) {
      fraction = p.share.fraction;
    } else if (component.cookedWeightG) {
      fraction = p.share.weighedG / component.cookedWeightG;
    } else {
      problems.push(`${p.member}'s weighed portion of ${name} needs the ${name} cooked weight`);
      fraction = null;
    }
    return {
      member: p.member,
      component: name,
      fraction,
      nutrients: fraction === null ? null : scaleTotals(component.totals, fraction),
    };
  });

  const remainder: CookResult["remainder"] = [];
  for (const component of components) {
    const sharing = portionResults.filter((p) => p.component === component.name && p.fraction !== null);
    const shared = sharing.reduce((sum, p) => sum + (p.fraction as number), 0);
    const left = 1 - shared;
    if (left < -SHARE_EPS) {
      // Each share by its key, so the member can see what made it more than whole (an eaten leftover included).
      const each = sharing.map((p) => `${p.member} ${Math.round((p.fraction as number) * 1000) / 10}%`).join(", ");
      problems.push(`portions of ${component.name} add up to ${shared}, more than the whole cook; shares: ${each}`);
      continue;
    }
    if (left <= SHARE_EPS) continue;
    const mark = remainderMarks.find((m) => m.component === component.name);
    remainder.push({
      component: component.name,
      fraction: left,
      status: mark ? mark.disposition : "unaccounted",
      nutrients: scaleTotals(component.totals, left),
    });
  }

  const totals: NutrientTotals = sumNutrients(components.map((c) => c.totals));
  return { components, totals, portions: portionResults, remainder, problems };
}
