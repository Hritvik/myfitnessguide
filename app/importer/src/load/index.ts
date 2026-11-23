/** The load stages, in dependency order. */
import { loadCadences } from "../cadences";
import { loadBloods, loadBody, loadGoals } from "./body";
import { loadFoodSources, loadRecipes } from "./catalogue";
import type { Loader } from "./context";
import { loadNutrition } from "./nutrition";
import { loadAudit, loadNotes } from "./notes";
import { loadPeople } from "./people";
import { loadInventory } from "./inventory";
import { loadPhases } from "./phases";
import { loadCardio, loadExercises, loadLog, loadProgrammes } from "./training";

export type Stage = (ld: Loader) => Promise<void>;

export const STAGES: Stage[] = [loadPeople, loadFoodSources, loadRecipes, loadNutrition, loadExercises, loadProgrammes, loadLog, loadCardio, loadInventory, loadBody, loadBloods, loadGoals, loadNotes, loadAudit, loadPhases, loadCadences];
