/** Feedback about the app (spec §9): a short sheet, with the context attached automatically. No screenshot in v1. */
import { planStep, type Plan } from "./writes";

export type FeedbackType = "bug" | "idea" | "confusing";
export const FEEDBACK_TYPES: { type: FeedbackType; label: string }[] = [
  { type: "bug", label: "Bug" },
  { type: "idea", label: "Idea" },
  { type: "confusing", label: "Confusing" },
];

/** The Worker caps the route at 300 characters. */
const ROUTE_MAX = 300;

/** Below 700 px wide is a phone. */
export function feedbackContext(c: { path: string; search: string; date: string | null; version: string; width: number; now: Date }): Record<string, unknown> {
  return { route: `${c.path}${c.search}`.slice(0, ROUTE_MAX), date: c.date, version: c.version, viewport: c.width < 700 ? "phone" : "desktop", at: c.now.toISOString() };
}

export function feedbackPlan(type: FeedbackType, text: string, context: Record<string, unknown>): Plan | { error: string } {
  if (!text.trim()) return { error: "Say what happened, or what you'd like." };
  return { steps: [planStep("submit_feedback", { type, text: text.trim(), context })], done: "Sent. It comes up at the next feedback review." };
}
