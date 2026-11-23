// The D1 query-budget helpers (decision 96), shared by query-budget.test.ts
// and the app-input tools' budget tests. LOG_SET_BUDGET, READ_BUDGET, seedGym
// and withinBudget moved here unchanged from query-budget.test.ts;
// toolWithinBudget is new. Invented data only.
import { expect } from "vitest";
import type { As, Harness } from "./harness";
import { seedTraining } from "./seed";

export const LOG_SET_BUDGET = 25;
export const READ_BUDGET = 30;

const KINDS = ["dumbbell", "cable", "machine", "plate_loaded", "kettlebell", "fixed_bar"] as const;

/** seedTraining's 4 implements plus invented ones up to `count`, and the gym's kg and lb plates. */
export function seedGym(x: Harness, count: number) {
  const { t } = x;
  const s = seedTraining(x);
  for (const [unit, values] of [["kg", [1.25, 2.5, 5, 10, 15, 20, 25]], ["lb", [2.5, 5, 10, 25, 35, 45]]] as const) {
    const set = t.insert("plate_set", { gym_id: s.gym, unit, complete: 1 });
    for (const value of values) t.insert("plate", { plate_set_id: set, value, status: "confirmed" });
    t.insert("plate", { plate_set_id: set, value: 0.5, status: "absent" });
  }
  for (let i = 5; i <= count; i++) {
    const kind = KINDS[i % KINDS.length] as (typeof KINDS)[number];
    const plated = kind === "plate_loaded";
    const id = t.insert("implement", {
      gym_id: s.gym, name: `Invented ${kind} ${i}`, kind, unit: i % 4 === 0 ? "lb" : "kg",
      loading: plated ? "per_side" : "total", load_list_complete: i % 3 === 0 ? 0 : 1,
      ...(plated ? { bar_value: 15, bar_unit: "kg" } : {}),
    });
    if (!plated) for (let n = 1; n <= 8; n++) t.insert("implement_load", { implement_id: id, load: n * 5, unit: i % 4 === 0 ? "lb" : "kg" });
    t.insert("implement_load", { implement_id: id, load: 47.5, unit: "kg", status: "absent" });
  }
  return s;
}

/** A budget assertion whose failure lists the statements the call ran. */
export function withinBudget(run: { statements: number; log: string[] }, budget: number) {
  // BUDGET_REPORT=1 prints each count; BUDGET_REPORT=sql adds the statements.
  const report = process.env.BUDGET_REPORT;
  if (report) console.log(`BUDGET ${expect.getState().currentTestName}: ${run.statements}${report === "sql" ? `\n${run.log.join("\n")}` : ""}`);
  expect(run.statements, `${run.statements} statements:\n${run.log.join("\n")}`).toBeLessThanOrEqual(budget);
}

/** Call a tool through the counting adapter and hold it to a budget (READ_BUDGET unless given); returns the run. */
export async function toolWithinBudget(x: { counted: Harness["counted"] }, tool: string, input: Record<string, unknown>, as: As = "agent", budget: number = READ_BUDGET) {
  const run = await x.counted(tool, input, as);
  withinBudget(run, budget);
  return run;
}
