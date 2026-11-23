import type { Tool } from "./tool";

export type ToolProfile = "remoteMember" | "interactiveAgent" | "unattended";

export interface ToolProfiles {
  remoteMember: boolean;
  interactiveAgent: boolean;
  unattended: boolean;
}

const capability = (remoteMember: boolean, unattended: boolean): ToolProfiles => Object.freeze({
  remoteMember,
  interactiveAgent: true,
  unattended,
});

/**
 * The single, fail-closed capability manifest for every routed Worker tool.
 * Each entry is an intentional product/security decision; adding a tool to
 * TOOLS without adding it here makes every profile selector reject the list.
 */
export const TOOL_CAPABILITIES: Readonly<Record<string, ToolProfiles>> = Object.freeze({
  analytics: capability(true, true),
  household_meal: capability(true, true),
  preview_meal: capability(true, true),
  household_planning_context: capability(true, true),
  preview_meal_plan: capability(true, true),
  save_meal_plan: capability(true, false),
  meal_plan: capability(true, true),
  set_meal_plan_archived: capability(true, false),
  log_intake: capability(true, true),
  correct_intake: capability(true, false),
  day_totals: capability(true, true),
  day_items: capability(true, true),
  set_day_status: capability(true, false),
  what_if: capability(true, true),
  mark_remainder: capability(true, false),
  add_cook_line: capability(true, false),
  remove_cook_line: capability(true, false),
  catalogue_search: capability(true, true),
  catalogue_list: capability(true, true),
  catalogue_lookup: capability(true, true),
  upsert_food_source: capability(true, false),
  add_measure: capability(true, false),
  add_yield: capability(true, false),
  upsert_recipe: capability(true, false),
  update_recipe: capability(true, false),
  set_recipe_archived: capability(true, false),
  add_recipe_line: capability(true, false),
  remove_recipe_line: capability(true, false),
  catalogue_dependents: capability(true, true),
  learn_alias: capability(true, false),
  forget_alias: capability(true, false),
  learned: capability(true, true),
  start_session: capability(true, false),
  active_session: capability(true, true),
  log_set: capability(true, false),
  log_workout: capability(true, false),
  preview_set: capability(true, true),
  end_session: capability(true, false),
  update_set: capability(true, false),
  revalidate_set: capability(true, false),
  revalidate_session: capability(true, false),
  validate_session: capability(true, true),
  get_set_history: capability(true, true),
  next_prescription: capability(true, true),
  check_progression: capability(true, true),
  substitute: capability(true, true),
  lift_history: capability(true, true),
  last_trained: capability(true, true),
  log_cardio: capability(true, false),
  create_gym: capability(true, false),
  create_implement: capability(true, false),
  update_implement: capability(true, false),
  set_implement_archived: capability(true, false),
  inventory: capability(true, true),
  add_implement_load: capability(true, false),
  remove_implement_load: capability(true, false),
  record_plates: capability(true, false),
  inventory_gaps: capability(true, true),
  workouts: capability(true, true),
  create_workout: capability(true, false),
  update_workout: capability(true, false),
  set_workout_archived: capability(true, false),
  add_workout_line: capability(true, false),
  remove_workout_line: capability(true, false),
  save_session_as_workout: capability(true, false),
  log_reading: capability(true, false),
  body_trends: capability(true, true),
  reading_metrics: capability(true, true),
  log_blood_draw: capability(true, false),
  blood_draws: capability(true, true),
  heart_rate_zones: capability(true, true),
  health_drafts: capability(true, true),
  flags: capability(true, true),
  raise_flag: capability(true, false),
  resolve_flag: capability(true, false),
  set_goal_point: capability(true, false),
  staleness: capability(true, true),
  set_measurement_cadence: capability(true, false),
  targets: capability(true, true),
  set_target: capability(true, false),
  amend: capability(true, false),
  confirm: capability(true, false),
  reject: capability(true, false),
  retract: capability(true, false),
  history: capability(true, true),
  member_notes: capability(true, true),
  write_member_note: capability(true, false),
  programme: capability(true, true),
  create_programme: capability(true, false),
  update_programme: capability(true, false),
  set_programme_archived: capability(true, false),
  upsert_phase: capability(true, false),
  set_phase_archived: capability(true, false),
  programme_change: capability(true, false),
  query: capability(false, true),
  whoami: capability(true, true),
  day_meals: capability(true, true),
  day_cooks: capability(true, true),
  needs_you: capability(true, true),
  week_summary: capability(true, true),
  nutrition_trends: capability(true, true),
  progress_summary: capability(true, true),
  household_overview: capability(true, true),
  sessions: capability(true, true),
  lift_trends: capability(true, true),
  waiting: capability(true, true),
  recent_items: capability(true, true),
  route_text: capability(true, true),
  commit_route: capability(true, false),
  submit_to_inbox: capability(true, false),
  inbox_entries: capability(true, true),
  resolve_inbox_entry: capability(true, true),
  ask_member: capability(false, false),
  answer_question: capability(true, false),
  submit_feedback: capability(true, false),
  feedback_list: capability(true, true),
  triage_feedback: capability(true, false),
});

export function profilesForTool(name: string): ToolProfiles {
  const profiles = TOOL_CAPABILITIES[name];
  if (!profiles) throw new Error(`Tool ${name} is not classified in TOOL_CAPABILITIES.`);
  return profiles;
}

export function selectToolsForProfile(tools: readonly Tool[], profile: ToolProfile): Tool[] {
  return tools.filter((tool) => profilesForTool(tool.name)[profile]);
}
