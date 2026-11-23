// The invented household for the redesign's Worker tests (redesign-a spec §9): Asha (prescribed), Kabir
// (prescribed) and Noor (record-only), on harness.ts's own seam (R12). The clock starts at the browser suite's
// fixed instant, Wed 7 Oct 2026 10:00 Asia/Kolkata. Invented data only.
import { NOW, type TestDb } from "./db";
import { setup, type SetupOptions } from "./harness";

export interface Invented {
  id: number;
  asha: number;
  kabir: number;
  noor: number;
}

export const WED = "2026-10-07";
/** WED plus n days (n may be negative). */
export const day = (n: number): string => new Date(Date.parse(`${WED}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function inventedHousehold(t: TestDb): Invented {
  const id = t.insert("household", { name: "Sample household", created_at: NOW });
  const member = (name: string, email: string, programming_mode: string) => t.insert("member", { household_id: id, name, email, programming_mode, created_at: NOW });
  return {
    id,
    asha: member("Asha", "asha@example.com", "prescribed"),
    kabir: member("Kabir", "kabir@example.com", "prescribed"),
    noor: member("Noor", "noor@example.com", "record_only"),
  };
}

/** harness.ts's seam on the invented household: the agent speaks with Asha unless an input says otherwise. */
export function invented(options: Omit<SetupOptions<Invented>, "household"> = {}) {
  return setup<Invented>({ household: inventedHousehold, speaker: "Asha", now: "2026-10-07T04:30:00Z", ...options });
}

export type InventedHarness = ReturnType<typeof invented>;

/**
 * Four invented foods (refs FS001–FS004 in this order), each per 100 g with macros that reconcile with its
 * kcal by 4/4/9 within max(10 %, 15 kcal) (domain label.ts; upsert_food_source refuses energy_mismatch, R13):
 * Rice 115.4 of 120, Egg 138.7 of 143, Curd 60.7 of 60, Toor dal 110.8 of 116.
 */
export async function seedFoods(x: InventedHarness): Promise<void> {
  const food = (name: string, state: string, kcal: number, protein_g: number, carbs_g: number, fat_g: number, extra: Record<string, unknown> = {}) =>
    x.ok("upsert_food_source", { name, state, reference_amount: 100, reference_unit: "g", kcal, protein_g, carbs_g, fat_g, ...extra });
  await food("Rice", "cooked", 120, 2.4, 26, 0.2);
  await food("Egg", "shelled", 143, 12.6, 0.7, 9.5, { measures: [{ name: "egg", amount: 50 }] });
  await food("Curd", "as_sold", 60, 3.5, 4.7, 3.1);
  await food("Toor dal", "cooked", 116, 6.8, 20, 0.4);
}
