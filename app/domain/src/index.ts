export * from "./types";
export { roundHalfEven, round1 } from "./rounding";
export { e1rm, volume } from "./training/epley";
export { addDays, dayNumber, daysBetween, fromDayNumber, weekStart, weekdayOf, WEEKDAYS } from "./dates";
export { WEEK1_ANCHOR, weekOf } from "./training/week";
export { DEFAULT_BAR_KG, KG_PER_LB, LB_PER_KG, wholeUnits } from "./training/units";
export { nextInRotation, nextSession, ROTATION } from "./training/schedule";
export { layoffPolicy } from "./training/layoff";
export { E1RM_MAX_REPS, fromKg, implementsSharing, rirAdjustedE1rm, setDerived, toKg, totalLoad } from "./training/load";
export { compositionAmount, hasInventory, inventoryOpen, MAX_PLATES_PER_SIDE, platesKg, producibleLoads, snapToImplement } from "./training/inventory";
export { readNativeLoad } from "./training/native";
export { IMPLAUSIBLE_RATIO, implausibleLoad } from "./training/implausible";
export { NORMAL_STEP, parseRir, progressionCheck } from "./training/progression";
export { checkWeekday, fallbackCoverage, neverPerformedGaps } from "./training/coverage";
export { stalenessTop } from "./staleness";
export { catalogueProblems } from "./nutrition/catalogue";
export { convertUnit, resolveAmount } from "./nutrition/amount";
export { scaleNutrients, scaleTotals, sumNutrients, totalsFrom } from "./nutrition/totals";
export { recomputeCook } from "./nutrition/cook";
export { LABEL_ENERGY_MIN_TOLERANCE_KCAL, LABEL_ENERGY_TOLERANCE_FRACTION, labelEnergyCheck } from "./nutrition/label";
export { recipeIntake, type RecipeSource } from "./nutrition/recipe";
export { belowBmr, dayTotals, KCAL_PER_G, leftToday, resolveTarget } from "./nutrition/day";
export {
  BEHIND_AFTER_WEEKS,
  energyAvailability,
  goalVerdict,
  isRealChange,
  LOW_EA_KCAL_PER_KG_FFM,
  sevenDayAverage,
  trendSegments,
  waistToHeight,
} from "./body/body";
export { implausibleReading, READING_BOUNDS, READING_RATIO, type ImplausibleReading, type ReadingBounds } from "./body/plausible";
