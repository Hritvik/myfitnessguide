// Invented training data for the input tools' tests: Hritvik's weekday
// programme (Upper A on Monday, Lower A on Wednesday) at the seed gym, and a
// busy gym of N implements for query budgets. No household data.
import { seedGym } from "./budget";
import type { Harness } from "./harness";
import { setup } from "./harness";
import { seedCatalogue, type seedTraining } from "./seed";

export const MONDAY = "2026-10-05";
/** The seed gym's barbell has no bar weight on record, so per-side loads give theirs. */
export const bar20 = { value: 20, unit: "kg" } as const;

export function seedUpperA(x: Harness, s: ReturnType<typeof seedTraining>) {
  const { t, h } = x;
  const programme = t.insert("programme", { member_id: h.hritvik, name: "Base", schedule_kind: "weekday", active: 1, started_on: "2026-09-01" });
  const upper = t.insert("session_template", { programme_id: programme, name: "Upper A", session_type: "strength" });
  const lower = t.insert("session_template", { programme_id: programme, name: "Lower A", session_type: "strength" });
  t.insert("schedule_slot", { programme_id: programme, weekday: 1, template_id: upper });
  t.insert("schedule_slot", { programme_id: programme, weekday: 3, template_id: lower });
  const rule = (o: object) => JSON.stringify({ kind: "rep_top", target_sets: 3, rep_top: 12, rir_floor: 1, ...o });
  const p = (template: number, position: number, exercise: number, load: Record<string, unknown>, o: object) =>
    t.insert("prescription", {
      template_id: template, position, exercise_id: exercise, sets: 3, rep_low: 8, rep_high: 12, rir_target_low: 1, rir_target_high: 2,
      rest_s: 120, progression_rule: rule(o), ...load,
    });
  const bench = p(upper, 1, s.bench, { load_value: 12.5, load_unit: "lb", load_basis: "per_side", load_implement_id: s.barbell }, { increment: { min: 2.5 } });
  const pulldown = p(upper, 2, s.pulldown, { load_value: 40, load_unit: "kg", load_basis: "total", load_implement_id: s.stack }, { increment: { min: 5 } });
  const curl = p(upper, 3, s.curl, { load_value: 10, load_unit: "kg", load_basis: "per_hand", load_implement_id: s.dumbbells }, { increment: { min: 2.5 } });
  const calf = p(lower, 1, s.calf, { load_value: 10, load_unit: "kg", load_basis: "per_leg", load_implement_id: s.dumbbells }, { increment: { min: 2.5 } });
  return { programme, upper, lower, bench, pulldown, curl, calf };
}

/** A gym of `count` implements (seedGym), Hritvik's programme and the seed catalogue. */
export async function busyInput(count = 40) {
  const x = setup();
  const s = seedGym(x, count);
  const p = seedUpperA(x, s);
  await seedCatalogue(x);
  return { x, s, p };
}
