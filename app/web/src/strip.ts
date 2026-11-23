/**
 * The "needs you" strip (spec §4): needs_you's cards, in the API's order,
 * each a plain statement with one action. No praise, no red. The ranking
 * is the API's; this only words it.
 */
import { day, pct, plural } from "./format";
import type { BodyState } from "./reading";
import type { NeedsCard, NeedsYou } from "./types";

export type StripAction =
  | { kind: "link"; label: string; href: string }
  | { kind: "leftover"; label: string; componentId: number }
  | { kind: "reading"; label: string; metric: string; bodyState: BodyState | null };

export interface StripCard {
  key: string;
  text: string;
  action: StripAction;
}

export interface Strip {
  cards: StripCard[];
  /** How many cards are beyond the first three ("+N more"). */
  hidden: number;
}

const TRAINING_TABLES = new Set(["session", "session_set"]);

export function deadlineText(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso)).replace(",", "");
}

/** What a draft waits for, in words; `otherwise` is said when it has neither a deadline nor a reason. */
export function waitsText(o: { deadline: string | null; waits: string | null }, timeZone: string, otherwise: string): string {
  if (o.waits === "end_of_session") return "waits for the end of the session";
  if (o.waits === "rir_needed") return "needs RIR";
  return o.deadline ? `confirms by itself ${deadlineText(o.deadline, timeZone)}` : otherwise;
}

/** Where a draft of this kind is shown: readings live on Progress, blood draws on Health, the rest among the day's meals. */
function draftsHref(table: string): string {
  if (table === "reading") return "/progress";
  if (table === "blood_draw") return "/progress/health";
  return "#meals";
}

function card(c: NeedsCard, timeZone: string): StripCard {
  switch (c.rule) {
    case "drafts": {
      const o = c.oldest;
      const when = waitsText(o, timeZone, "waits for you");
      const training = TRAINING_TABLES.has(o.table);
      return {
        key: "drafts",
        text: `${plural(c.count, "draft", "drafts")} about you; the oldest ${when}.`,
        action: training ? { kind: "link", label: "Open Train", href: "/train" } : { kind: "link", label: "Show drafts", href: draftsHref(o.table) },
      };
    }
    case "remainder":
      return {
        key: `remainder:${c.component_id}`,
        text: `${pct(c.fraction)} of ${c.cook}${c.component ? `, ${c.component},` : ""}${c.cooked_on ? ` from ${day(c.cooked_on)}` : ""} isn't accounted for yet.`,
        action: { kind: "leftover", label: "Mark the rest leftover", componentId: c.component_id },
      };
    case "yesterday_open":
      return {
        key: "yesterday",
        text: `Yesterday is still open (${plural(c.items, "item", "items")}). Close it, and mark any meal you skipped.`,
        action: { kind: "link", label: "Open yesterday", href: `/?date=${c.date}` },
      };
    case "load":
      return { key: "load", text: `${plural(c.prescriptions.length, "load", "loads")} to act on in ${c.session}.`, action: { kind: "link", label: "Open Train", href: "/train" } };
    case "flag":
      return {
        key: `flag:${c.flag_id}`,
        text: `${c.subject}: due ${day(c.due_on)}.${c.more > 0 ? ` ${c.more} more due soon.` : ""}`,
        action: { kind: "link", label: "Open Health", href: "/progress/health" },
      };
    case "measurement":
      return {
        key: `measurement:${c.cadence}`,
        text: c.message,
        action: c.metric
          ? { kind: "reading", label: "Log a reading", metric: c.metric, bodyState: (c.body_state ?? null) as BodyState | null }
          : { kind: "link", label: "Open Progress", href: "/progress" },
      };
  }
}

export function buildStrip(needs: NeedsYou, timeZone: string): Strip | null {
  const all = [...needs.cards, ...needs.more];
  if (all.length === 0) return null;
  return { cards: all.map((c) => card(c, timeZone)), hidden: Math.max(0, all.length - 3) };
}
