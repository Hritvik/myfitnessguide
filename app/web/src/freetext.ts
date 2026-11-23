/**
 * Tell Claude: one box of free words, sent whole to the household's inbox
 * (submit_to_inbox) for Claude to log. The app reads nothing itself.
 */
import { planStep, type Plan } from "./writes";

/** The Worker's cap on an inbox text. */
export const MAX_TEXT = 5000;

/** Characters shown against the limit once the trimmed text is near it; null before then. UTF-16 units, as the Worker counts. */
export function countNote(raw: string): string | null {
  const n = raw.trim().length;
  return n >= MAX_TEXT - 500 ? `${n.toLocaleString("en-US")} / ${MAX_TEXT.toLocaleString("en-US")}` : null;
}

/** What a send gives submit_to_inbox: the trimmed text, with one span over all of it. */
export function sendInput(member: string, date: string, slot: string, raw: string): { input: Record<string, unknown> } | { error: string } {
  const text = raw.trim();
  if (text === "") return { error: "Write something to send." };
  if (text.length > MAX_TEXT) return { error: `That's too long to send. Up to ${MAX_TEXT.toLocaleString("en-US")} characters.` };
  return { input: { member, date, meal_slot: slot, text, spans: [{ text, start: 0, end: text.length }] } };
}

/** One step, one idempotency key, made once per tap; "Try again" replays this plan. */
export function sendPlan(input: Record<string, unknown>): Plan {
  return { steps: [planStep("submit_to_inbox", input)], done: "Sent to Claude. It'll be logged when Claude goes through the inbox; you'll see it as waiting until then." };
}

/**
 * What the app asks inbox_entries for: your pending texts, naming nobody.
 * The Worker gives a member only the texts they sent, and refuses naming
 * another member (Worker decision 157; decision 110).
 */
export const WAITING_INPUT = { status: "pending" } as const;

/** Your waiting texts about one member (the one the sheet is for, or the day shown). */
export function waitingAbout<T extends { member: string }>(entries: readonly T[], member: string): T[] {
  return entries.filter((e) => e.member === member);
}
