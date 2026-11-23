// Small builders for valid rows, so each test states only what it varies.
import { NOW, TestDb } from "./db";

export interface Household {
  id: number;
  hritvik: number;
  asha: number;
  kabir: number;
}

export function writeLog(t: TestDb, over: Record<string, unknown> = {}): number {
  return t.insert("write_log", {
    at: NOW,
    resolver: "claude_code",
    origin: "live",
    tool: "test",
    reason: "test write",
    ...over,
  });
}

type Over = Record<string, unknown>;
let seq = 0;

export function gym(t: TestDb, h: Household, over: Over = {}): number {
  return t.insert("gym", { household_id: h.id, name: `Gym ${++seq}`, ...over });
}

export function implement(t: TestDb, gymId: number, over: Over = {}): number {
  return t.insert("implement", {
    gym_id: gymId, name: `Dumbbells ${++seq}`, kind: "dumbbell", unit: "kg", loading: "total",
    load_list_complete: 1, ...over,
  });
}

export function exercise(t: TestDb, h: Household, over: Over = {}): number {
  return t.insert("exercise", {
    household_id: h.id, name: `Exercise ${++seq}`, implement_kind: "cable", ...over,
  });
}

export function alias(t: TestDb, h: Household, kind: "food_source" | "recipe" | "exercise" | "workout", targetId: number, word: string, over: Over = {}): number {
  return t.insert("alias", { household_id: h.id, alias: word, kind, target_id: targetId, created_at: NOW, ...over });
}

export function programme(t: TestDb, memberId: number, over: Over = {}): number {
  return t.insert("programme", {
    member_id: memberId, name: `Programme ${++seq}`, schedule_kind: "rotation", active: 1, started_on: "2026-07-26",
    ...over,
  });
}

export function template(t: TestDb, programmeId: number, over: Over = {}): number {
  return t.insert("session_template", {
    programme_id: programmeId, name: `Template ${++seq}`, session_type: "strength", ...over,
  });
}

export function prescription(t: TestDb, templateId: number, exerciseId: number, over: Over = {}): number {
  return t.insert("prescription", {
    template_id: templateId, position: ++seq, exercise_id: exerciseId, sets: 3, rep_low: 8, rep_high: 12,
    rir_target_low: 1, rir_target_high: 2, rest_s: 120, ...over,
  });
}

export function session(t: TestDb, memberId: number, gymId: number | null, over: Over = {}): number {
  return t.insert("session", {
    member_id: memberId, performed_on: "2026-10-05", gym_id: gymId, session_type: "strength", state: "draft",
    ...over,
  });
}

export function set(t: TestDb, sessionId: number, exerciseId: number, over: Over = {}): number {
  return t.insert("session_set", {
    session_id: sessionId, exercise_id: exerciseId, set_number: ++seq, set_type: "working", reps: 10,
    load_status: "none", state: "draft", ...over,
  });
}

export function foodSource(t: TestDb, h: Household, over: Over = {}): number {
  const n = ++seq;
  return t.insert("food_source", {
    household_id: h.id, ref: `FS9${n}`, name: `Food ${n}`, state: "as_sold", reference_amount: 100,
    reference_unit: "g", kcal: 100, protein_g: 10, carbs_g: 10, fat_g: 2, ...over,
  });
}

export function recipe(t: TestDb, h: Household, over: Over = {}): number {
  const n = ++seq;
  return t.insert("recipe", {
    household_id: h.id, ref: `R9${n}`, name: `Recipe ${n}`, kind: "dish", servings: 1, manual_macros: 0, ...over,
  });
}

export function reading(t: TestDb, memberId: number, over: Over = {}): number {
  return t.insert("reading", {
    member_id: memberId, metric: "weight", measured_on: "2026-10-05", value: 78.4, unit: "kg",
    body_state: "fasted", measurer: "self", suspect: 0, state: "draft", ...over,
  });
}

export function household(t: TestDb): Household {
  const id = t.insert("household", { name: "Demo household", created_at: NOW });
  const member = (name: string, email: string, programming_mode: string) =>
    t.insert("member", { household_id: id, name, email, programming_mode, created_at: NOW });
  return {
    id,
    hritvik: member("Hritvik", "hritvik@example.com", "prescribed"),
    asha: member("Asha", "asha@example.com", "record_only"),
    kabir: member("Kabir", "kabir@example.com", "prescribed"),
  };
}
