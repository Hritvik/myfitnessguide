import type { LayoffPolicy } from "../types";

/**
 * How to load a session after time away. Two clocks mean different things:
 * days since ANY training measures detraining; days since THIS session only
 * measures a stale movement pattern. On 23 Sep 2026 Lower B was 43 days
 * stale while legs had trained 8 days earlier: a hold, not a back-off.
 * `daysSinceSession` is null for a session never run, which is calibration.
 */
export function layoffPolicy(daysSinceAny: number, daysSinceSession: number | null): LayoffPolicy {
  if (daysSinceAny < 0 || (daysSinceSession !== null && daysSinceSession < 0)) {
    throw new RangeError("gaps cannot be negative");
  }
  if (daysSinceAny > 21) return "back_off";
  if (daysSinceAny >= 7) return "hold";
  if (daysSinceSession !== null && daysSinceSession > 21) return "hold";
  return "normal";
}
