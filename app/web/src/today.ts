/**
 * Maps the API's answers for one member's day into what the Today screen
 * shows, in DESIGN.md's order. Pure: no fetching, no nutrition maths. The
 * only arithmetic here is display geometry (a track's fill) and rounding.
 */
import { atLeast, atMostWord, day, list, n, pct, plural, qty, sentenceCase, shortUncertainty, slotLabel, unknownCount, unknownTail } from "./format";
import { itemFix, type ItemFix } from "./fixes";
import { hrefOf } from "./route";
import { buildStrip, type Strip } from "./strip";
import type { CookAsk, DayCook, LoggedBy, MealItem, MealSlot, RecordRef, SlotState, TodayData } from "./types";

export interface Part {
  text: string;
  strong?: boolean;
}

export interface MacroColumn {
  key: "kcal" | "protein" | "carbs" | "fat";
  label: string;
  /** What is left, or with `over` how far over. */
  amount: string;
  unit: string;
  over: boolean;
  /** 0..1 of the target eaten, for the track; null when there is no track. */
  fill: number | null;
  caption: string;
  note: string | null;
}

export type SegmentKind = "you" | "other" | "unaccounted" | "leftover" | "discarded" | "eaten";

export interface Segment {
  kind: SegmentKind;
  label: string;
  /** Width as a share of the pot, 0..1. */
  share: number;
}

export interface PotBar {
  componentId: number;
  name: string | null;
  segments: Segment[];
  description: string;
  /** The component's unaccounted remainder, which "Mark the rest leftover" settles. */
  unaccounted: boolean;
}

/** A run of the ask's question; `estimated` runs are shown in --haldi-ink (DESIGN.md). */
export interface QuestionPart {
  text: string;
  estimated?: true;
}

export interface PotAsk {
  question: string;
  parts: QuestionPart[];
  confirm: RecordRef[];
  portionId: number;
  componentId: number;
  sharePercent: number | null;
  canMarkLeftover: boolean;
  /** Your confirmed share someone else edited (ticket 69): keep or undo their change, as a Today item's re-draft. */
  redraft: boolean;
}

export interface PotCard {
  cookId: number;
  title: string;
  meta: string;
  bars: PotBar[];
  legend: string[];
  ask: PotAsk | null;
  /** On your own day with no draft: the components whose rest can still be marked leftover. */
  settle: number[];
}

export interface TierItem {
  id: number;
  name: string;
  amount: string | null;
  provenance: string;
  estimated: boolean;
  /** The item's energy and protein, for a wide tier (wide-layout spec §5): "190 kcal", "P 7 g"; a value nobody knows reads "unknown", never 0 (as the tier header). */
  kcal: string;
  protein: string;
  /**
   * Where a draft is settled: here, on its pot card, or only by the member it is about; on another
   * member's day, your own plain draft is yours to take back until they confirm it (ticket 69). A
   * re-draft (your confirmed record someone else edited) is yours to keep or undo, and `by` is its
   * editor (`edited`).
   */
  draft: { by: string; confirm: RecordRef[]; where: "here" | "pot" | "owner" | "author" | "redraft"; edited: boolean } | null;
  /** Your own confirmed item only: its Edit and Remove (ticket 61). */
  fix?: ItemFix;
}

export interface Tier {
  slot: string;
  label: string;
  state: SlotState;
  meta: string;
  items: TierItem[];
  /** The member's Tell Claude texts for this meal still waiting for Claude, worded: Waiting for Claude: "…" (decision 75). */
  waiting: string[];
}

/** The meal's Tell Claude texts still waiting for Claude on this day (the load keeps only the viewed member's, for the day shown). */
export function waitingFor(data: TodayData, slot: string): string[] {
  return data.waiting.filter((e) => e.meal_slot === slot).map((e) => e.text);
}

export interface FooterRow {
  label: string;
  value: string;
  href: string;
}

export interface TodayView {
  title: string;
  ownDay: boolean;
  /** "Needs you": your own today only; null when nothing is due. */
  strip: Strip | null;
  left: { parts: Part[]; note: string | null };
  /** Quiet notes on the day: imported from Sheets, mostly typed macros. */
  notes: string[];
  macros: MacroColumn[];
  pots: PotCard[];
  tiers: Tier[];
  footer: FooterRow[];
}

const MACROS = [
  { key: "kcal", label: "Energy", unit: "kcal", nutrient: "kcal" },
  { key: "protein", label: "Protein", unit: "g", nutrient: "protein_g" },
  { key: "carbs", label: "Carbs", unit: "g", nutrient: "carbs_g" },
  { key: "fat", label: "Fat", unit: "g", nutrient: "fat_g" },
] as const;

export function buildToday(data: TodayData): TodayView {
  const ownDay = data.me !== null && data.viewing === data.me;
  return {
    title: day(data.date),
    ownDay,
    strip: ownDay && data.date === data.today && data.needs ? buildStrip(data.needs, data.timeZone) : null,
    left: leftLine(data),
    notes: [
      ...(data.meals.honesty.imported ? ["Imported from Sheets."] : []),
      ...(data.meals.honesty.typed_macros.high && data.meals.honesty.typed_macros.share !== null
        ? [`${pct(data.meals.honesty.typed_macros.share)} of this day's known energy was typed in as macros in Sheets, not from the catalogue.`]
        : []),
    ],
    macros: macroStrip(data),
    pots: data.cooks.cooks.map((c) => potCard(c, ownDay)),
    tiers: tiers(data),
    footer: footer(data, ownDay),
  };
}

// ------------------------------------------------------------------ left

function leftLine(data: TodayData): TodayView["left"] {
  const { totals, meals } = data;
  const when = data.date === data.today ? "today" : `on ${day(data.date)}`;
  // A sum that leaves out unknown items says so (ticket 72, decision 118): so far is at least, left at most.
  const uk = totals.unknown_items?.kcal ?? 0;
  const up = totals.unknown_items?.protein ?? 0;
  const tail = unknownTail(unknownCount(totals.unknown_items));
  let parts: Part[];
  if (totals.left === null) {
    const kcal = totals.so_far.kcal?.value;
    const protein = totals.so_far.protein?.value;
    parts = [
      { text: `So far ${when}: ` },
      { text: kcal === undefined ? "no energy known" : `${atLeast(kcal, uk)} kcal`, strong: true },
      { text: " and " },
      { text: protein === undefined ? "no protein known" : `${atLeast(protein, up)} g protein`, strong: true },
      { text: `${tail}. No target is set for this day.` },
    ];
  } else {
    const k = totals.left.kcal.left;
    const p = totals.left.protein.left;
    if (k >= 0 && p >= 0) {
      parts = [
        { text: `Left ${when}: ${atMostWord(uk)}` },
        { text: `${n(k)} kcal`, strong: true },
        { text: ` and ${atMostWord(up)}` },
        { text: `${n(p)} g protein`, strong: true },
        { text: `${tail}.` },
      ];
    } else {
      const phrase = (left: number, unit: string, unknown: number): Part[] =>
        left >= 0
          ? [{ text: atMostWord(unknown) }, { text: `${n(left)} ${unit}`, strong: true }, { text: " left" }]
          : [{ text: "over by " }, { text: `${atLeast(-left, unknown)} ${unit}`, strong: true }];
      parts = [{ text: `${sentenceCase(when)}: ` }, ...phrase(k, "kcal", uk), { text: ", " }, ...phrase(p, "g protein", up), { text: `${tail}.` }];
    }
  }
  return { parts: merge(parts), note: estimateNote(totals.item_count, meals.estimate) };
}

/** Join adjacent plain parts so the sentence reads as one string per run. */
function merge(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && !last.strong && !p.strong) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

function estimateNote(itemCount: number, e: TodayData["meals"]["estimate"]): string | null {
  if (itemCount === 0) return "Nothing logged yet.";
  if (e.plus_minus_kcal !== null) {
    const d = e.dominant;
    const words = shortUncertainty(d?.description);
    const biggest = !d
      ? ""
      : words
        ? `; the biggest uncertainty is ${words}, ±${n(d.kcal ?? 0)}${d.name ? `, in ${d.name}` : ""}`
        : d.name
          ? `; the biggest uncertainty is in ${d.name}, ±${n(d.kcal ?? 0)}`
          : "";
    const unsized = e.estimated_without_size > 0 ? ` ${plural(e.estimated_without_size, "estimated item has", "estimated items have")} no ± given.` : "";
    return `Estimate ±${n(e.plus_minus_kcal)} kcal${biggest}.${unsized}`;
  }
  if (e.estimated_items > 0) return `${plural(e.estimated_items, "item is", "items are")} estimated, with no ± given.`;
  return "Everything so far is weighed, counted or from a label.";
}

// ---------------------------------------------------------------- macros

function macroStrip(data: TodayData): MacroColumn[] {
  const { totals } = data;
  return MACROS.map((m) => {
    const values = totals.target_values.filter((v) => v.nutrient === m.nutrient);
    const floor = values.find((v) => v.kind === "floor")?.value ?? null;
    const isRemainder = values.some((v) => v.kind === "remainder");
    const note = isRemainder ? "the remainder" : floor !== null ? `floor ${n(floor)}` : null;
    // A partial sum (ticket 72, decision 118): eaten is at least, left at most; the left line above carries the count.
    const unknown = totals.unknown_items?.[m.key] ?? 0;
    if (totals.left === null) {
      const so = totals.so_far[m.key];
      return so === undefined
        ? { key: m.key, label: m.label, amount: "unknown", unit: "", over: false, fill: null, caption: "not reported", note: null }
        : { key: m.key, label: m.label, amount: atLeast(so.value, unknown), unit: m.unit, over: false, fill: null, caption: "so far", note: null };
    }
    const line = totals.left[m.key];
    const over = line.left < 0;
    const blank = totals.so_far[m.key] === undefined;
    return {
      key: m.key,
      label: m.label,
      amount: over ? atLeast(-line.left, unknown) : `${unknown > 0 ? "≤" : ""}${n(line.left)}`,
      unit: m.unit,
      over,
      // Nothing of it known (every item unknown): "unknown of 1,600", no track, never a 0 eaten (review P2-1).
      fill: line.goal > 0 && !(blank && unknown > 0) ? Math.min(1, Math.max(0, line.consumed / line.goal)) : null,
      caption: `${blank && unknown > 0 ? "unknown" : atLeast(line.consumed, unknown)} of ${n(line.goal)}`,
      note,
    };
  });
}

/**
 * You logged this plain item yourself (in the app, or the agent or the Inbox naming you), and it was
 * never confirmed, so the Worker lets you reject it (ticket 69). A portion's or a leftover serving's
 * item is decided through its share, so it waits for its member.
 */
function authorOf(i: MealItem, me: string | null): boolean {
  if (me === null || i.ever_confirmed === true || i.portion_id !== null || i.leftover_serving_id != null) return false;
  const by = i.logged_by;
  return by?.kind === "member" ? by.name === me : by?.kind === "agent" && by.speaker === me;
}

/** A draft item's bar: who to name (its editor on a re-draft), and where it is settled. */
function draftOf(i: MealItem, ownDay: boolean, me: string | null): TierItem["draft"] {
  const edited = i.ever_confirmed === true;
  const where = ownDay ? (i.portion_id !== null ? "pot" : edited ? "redraft" : "here") : authorOf(i, me) ? "author" : "owner";
  return { by: sentenceCase(byWhom(edited ? (i.edited_by ?? null) : i.logged_by)), confirm: [{ table: "intake_item", id: i.id }], where, edited };
}

// ----------------------------------------------------------------- pots

function byWhom(by: LoggedBy): string {
  if (!by) return "someone";
  if (by.kind === "member") return by.name;
  if (by.kind === "system") return "the app";
  // The member the agent was talking with logged it; "the agent" only when no one was named.
  if (by.speaker) return by.speaker;
  return by.origin === "inbox" ? "the Inbox" : "the agent";
}

export function potCard(cook: DayCook, ownDay: boolean): PotCard {
  const multi = cook.components.length > 1;
  const bars: PotBar[] = cook.components.map((c) => {
    const segments: Segment[] = c.shares
      .filter((s) => s.fraction !== null)
      .map((s) => ({ kind: s.you ? "you" : "other", label: `${s.you ? "You" : s.member} ${pct(s.fraction as number)}`, share: s.fraction as number }));
    // A leftover someone has eaten is part of the pot too (click test P1-7): without it the shares leave a gap
    // and a share change is refused for no visible reason.
    const eaten = (c.leftovers ?? []).filter((l) => l.fraction !== null);
    for (const l of eaten) segments.push({ kind: l.you ? "you" : "other", label: `${l.you ? "You" : l.member} ${pct(l.fraction as number)} (leftover)`, share: l.fraction as number });
    if (c.remainder) {
      const r = c.remainder;
      segments.push({ kind: r.status, label: r.status === "unaccounted" ? pct(r.fraction) : `${r.status} ${pct(r.fraction)}`, share: r.fraction });
    }
    const said = [
      ...c.shares.map((s) => `${s.member} ${s.fraction === null ? "share unknown" : pct(s.fraction)}`),
      ...eaten.map((l) => `${l.member} ${pct(l.fraction as number)} as a leftover on ${day(l.eaten_on)}`),
      ...(c.remainder ? [`${pct(c.remainder.fraction)} ${c.remainder.status === "unaccounted" ? "not yet accounted for" : c.remainder.status}`] : []),
      ...cook.absent.map((a) => `${a} not present`),
    ];
    return {
      componentId: c.component_id,
      name: multi ? c.name : null,
      segments,
      description: `${multi ? `${c.name}: ` : ""}${said.join(", ")}`,
      unaccounted: c.remainder?.status === "unaccounted",
    };
  });

  const legend: string[] = [];
  if (cook.absent.length > 0) {
    legend.push(`${list(cook.absent)} ${cook.absent.length === 1 ? "wasn't" : "weren't"} there, so no portion`);
  }
  for (const c of cook.components) {
    for (const l of c.leftovers ?? []) {
      if (l.fraction !== null) legend.push(`${pct(l.fraction)}${multi ? ` of the ${c.name}` : ""} eaten as a leftover by ${l.member} on ${day(l.eaten_on)}`);
    }
    if (!c.remainder) continue;
    const of = multi ? ` of the ${c.name}` : "";
    const what = { unaccounted: "not yet accounted for", leftover: "kept as leftover", discarded: "discarded", eaten: "eaten" }[c.remainder.status];
    legend.push(`${pct(c.remainder.fraction)}${of} ${what}`);
  }

  const ask = cook.ask ? potAsk(cook, cook.ask) : null;
  const settle = ownDay && !ask ? bars.filter((b) => b.unaccounted).map((b) => b.componentId) : [];
  return {
    cookId: cook.cook_id,
    title: cook.name,
    meta: `${slotLabel(cook.meal_slot).toLowerCase()}, logged by ${byWhom(cook.logged_by)}`,
    bars,
    legend,
    ask,
    settle,
  };
}

function potAsk(cook: DayCook, a: CookAsk): PotAsk {
  const redraft = a.ever_confirmed === true;
  const share = a.fraction === null ? "your share" : `your ${pct(a.fraction)}`;
  const lead = redraft ? `Edited by ${byWhom(a.edited_by ?? null)}: ${share}` : `${sentenceCase(byWhom(a.logged_by))} logged ${share}`;
  const tail = redraft ? ". Keep their change?" : ". Is that right?";
  let parts: QuestionPart[];
  if (a.kcal === null) parts = [{ text: `${lead}${tail}` }];
  else if (a.provenance !== "estimated") parts = [{ text: `${lead} (about ${n(a.kcal)} kcal, ${a.provenance})${tail}` }];
  else {
    // The share's ± and what it is mostly about, both stored on the portion.
    const size = a.plus_minus_kcal !== null ? ` ±${n(a.plus_minus_kcal)}${shortUncertainty(a.uncertainty) ? `, mostly ${shortUncertainty(a.uncertainty)}` : ""}` : "";
    parts = [{ text: `${lead} (about ${n(a.kcal)} kcal, ` }, { text: `estimated${size}`, estimated: true }, { text: `)${tail}` }];
  }
  const component = cook.components.find((c) => c.component_id === a.component_id);
  return {
    question: parts.map((p) => p.text).join(""),
    parts,
    confirm: a.records,
    portionId: a.portion_id,
    componentId: a.component_id,
    sharePercent: a.fraction === null ? null : Math.round(a.fraction * 100),
    canMarkLeftover: component?.remainder?.status === "unaccounted",
    redraft,
  };
}

// ---------------------------------------------------------------- tiers

const PROVENANCE_WORDS: Record<string, string> = {
  weighed: "weighed",
  counted: "counted",
  label: "label",
  estimated: "estimated",
  inferred: "inferred",
  reconstructed: "reconstructed",
};

function amountText(i: MealItem): string | null {
  const a = i.amount;
  if (i.source_kind === "manual" || !a) return i.source_kind === "manual" ? null : i.label;
  // The member's own words ("2 medium") read best, unless the label is a long note that repeats the name.
  // A draft the agent logged shows its structured amount: its words were the agent's paraphrase of a
  // message ("provilac milk 280ml"), and they stay in its history (click test P2-26).
  const agentDraft = i.state === "draft" && i.logged_by?.kind === "agent";
  if (i.label && !agentDraft && i.label.length <= 24 && !(i.name && i.label.toLowerCase().includes(i.name.toLowerCase()))) return i.label;
  if (a.fraction !== undefined && a.fraction !== null) return `${pct(a.fraction)} of the pot`;
  if (a.weighed_g !== undefined) return `${n(a.weighed_g)} g`;
  if (a.servings !== undefined) return a.servings === 1 ? "1 serving" : `${qty(a.servings)} servings`;
  if (a.unit === "measure" && a.measure) return `${qty(a.value ?? 0)} ${a.measure}`;
  if (a.value !== undefined && a.unit) return `${qty(a.value)} ${a.unit === "piece" ? "pc" : a.unit}`;
  return null;
}

/**
 * A meal's or an item's energy as Today words it: "1,194 kcal", or "kcal unknown" when nobody knows it, never 0;
 * a sum that leaves out `unknown` items reads "1,194+ kcal" (ticket 72).
 */
export function kcalWords(v: number | null | undefined, unknown = 0): string {
  return v == null ? "kcal unknown" : `${atLeast(v, unknown)} kcal`;
}

/** A meal's or an item's protein as Today words it: "P 42 g", "P 42+ g" for a partial sum, or "P unknown". */
export function proteinWords(v: number | null | undefined, unknown = 0): string {
  return v == null ? "P unknown" : `P ${atLeast(v, unknown)} g`;
}

/** A meal's header: its kcal and protein, and how many items a partial sum leaves out (ticket 72, decision 118). */
function mealTotalWords(t: MealSlot["totals"]): string {
  const uk = t?.unknown_items?.kcal ?? 0;
  const up = t?.unknown_items?.protein ?? 0;
  // A count only beside a number it qualifies: a meal nobody can value reads "kcal unknown, P unknown".
  const shown = t?.kcal != null || t?.protein != null;
  return `${kcalWords(t?.kcal, uk)}, ${proteinWords(t?.protein, up)}${shown ? unknownTail(unknownCount(t?.unknown_items)) : ""}`;
}

function tiers(data: TodayData): Tier[] {
  const ownDay = data.me !== null && data.viewing === data.me;
  return data.meals.slots.map((s) => {
    const waiting = waitingFor(data, s.slot);
    // A meal with a text waiting for Claude is not empty: it never says "nothing yet" or "not recorded".
    const meta =
      s.state === "eaten"
        ? mealTotalWords(s.totals)
        : s.state !== "skipped" && waiting.length > 0
          ? "sent to Claude"
          : { skipped: "skipped", nothing_yet: "nothing yet", not_recorded: "not recorded" }[s.state];
    return {
      slot: s.slot,
      label: slotLabel(s.slot),
      state: s.state,
      meta,
      waiting: waiting.map((t) => `Waiting for Claude: "${t}"`),
      items: s.items.map((i) => {
        const estimated = i.provenance === "estimated";
        const word = i.provenance === null ? "provenance not recorded" : (PROVENANCE_WORDS[i.provenance] ?? i.provenance);
        return {
          id: i.id,
          name: i.name ?? "Unnamed item",
          amount: amountText(i),
          provenance: estimated ? (i.plus_minus_kcal !== null ? `estimated ±${n(i.plus_minus_kcal)}` : "estimated, no ± recorded") : word,
          estimated,
          kcal: kcalWords(i.kcal, i.partial?.kcal ? 1 : 0),
          protein: proteinWords(i.protein, i.partial?.protein ? 1 : 0),
          draft:
            i.state === "draft"
              ? draftOf(i, ownDay, data.me)
              : null,
          ...(ownDay && i.state === "confirmed" ? { fix: itemFix(i, s.slot, data.date, amountText(i), data.me) } : {}),
        };
      }),
    };
  });
}

// ---------------------------------------------------------------- footer

function footer(data: TodayData, ownDay: boolean): FooterRow[] {
  const href = hrefOf({ route: { section: "train", view: "session" }, member: ownDay ? null : data.viewing });
  const next = data.next;
  if (next?.session && next.date) return [{ label: "Next session", value: `${next.session}, ${day(next.date)}`, href }];
  if (next?.programming_mode === "record_only") return [{ label: "Sessions", value: "trainer-led", href }];
  return [];
}
