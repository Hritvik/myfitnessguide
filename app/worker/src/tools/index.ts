import type { Tool } from "../tool";
import { ALIAS_TOOLS } from "./aliases";
import { ANALYTICS_TOOLS } from "./analytics";
import { CATALOGUE_TOOLS } from "./catalogue";
import { EQUIPMENT_TOOLS } from "./equipment";
import { FEEDBACK_TOOLS } from "./feedback";
import { HEALTH_TOOLS } from "./health";
import { INPUT_TOOLS } from "./input";
import { QUESTION_TOOLS } from "./questions";
import { NOTE_TOOLS } from "./notes";
import { NUTRITION_TOOLS } from "./nutrition";
import { MEAL_PLANNING_TOOLS } from "./meal-planning";
import { PROGRAMME_TOOLS } from "./programme";
import { PROGRESS_TOOLS } from "./progress";
import { QUERY_TOOLS } from "./query";
import { RECORD_TOOLS } from "./records";
import { SCREEN_TOOLS } from "./screens";
import { STALENESS_TOOLS } from "./staleness";
import { TARGET_TOOLS } from "./targets";
import { TRAINING_TOOLS } from "./training";
import { WORKOUT_TOOLS } from "./workouts";

export const TOOLS: readonly Tool[] = [
  ...ANALYTICS_TOOLS,
  ...NUTRITION_TOOLS,
  ...MEAL_PLANNING_TOOLS,
  ...CATALOGUE_TOOLS,
  ...ALIAS_TOOLS,
  ...EQUIPMENT_TOOLS,
  ...TRAINING_TOOLS,
  ...WORKOUT_TOOLS,
  ...HEALTH_TOOLS,
  ...STALENESS_TOOLS,
  ...TARGET_TOOLS,
  ...RECORD_TOOLS,
  ...NOTE_TOOLS,
  ...PROGRAMME_TOOLS,
  ...PROGRESS_TOOLS,
  ...QUERY_TOOLS,
  ...SCREEN_TOOLS,
  ...INPUT_TOOLS,
  ...QUESTION_TOOLS,
  ...FEEDBACK_TOOLS,
];
