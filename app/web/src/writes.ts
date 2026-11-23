/**
 * The Today screen's writes as plans: the tool calls one tap makes, each
 * with its own idempotency key fixed when the plan is made, so retrying a
 * failed plan replays any step that already landed instead of writing it
 * twice. Running a plan yields the write status shown next to the thing
 * written.
 */
import { newKey, NO_ANSWER, type Outcome } from "./api";
import type { CheckOffer, RecordRef } from "./types";
import { typedNumber } from "./typed";

export interface Step {
  tool: string;
  input: Record<string, unknown> & { idempotency_key: string };
}

export interface Plan {
  steps: Step[];
  /** What the status line says once every step has landed. */
  done: string;
}

export type WriteStatus =
  | { state: "pending"; message: string }
  | { state: "saved"; message: string }
  /** A question writes nothing, so it holds nothing: `reason` and `path` say what it is about (commit_route's path names the piece). */
  | { state: "question"; message: string; reason?: string; path?: (string | number)[]; options?: unknown[] }
  /**
   * `rejected`: the API refused the input before anything in the plan was
   * written (an invalid first step, or a first step's definitive 4xx
   * refusal, `refusedOutright`), so nothing is held for "Try again" and a
   * changed entry is a new plan. Offline, 5xx and a reused key may have
   * landed, so they are held.
   */
  | { state: "failed"; message: string; rejected?: true }
  | { state: "signed_out"; message: string };

export type Call = (tool: string, input: Record<string, unknown>) => Promise<Outcome>;

export const planStep = (tool: string, input: Record<string, unknown>): Step => ({ tool, input: { ...input, idempotency_key: newKey(tool) } });

export function confirmPlan(records: RecordRef[]): Plan {
  return { steps: [planStep("confirm", { records })], done: "Confirmed." };
}

export function rejectPlan(records: RecordRef[]): Plan {
  return { steps: [planStep("reject", { records, reason: "Rejected in the app: not eaten" })], done: "Removed." };
}

/** Someone else's edit of your confirmed record turned down (ticket 69): a reject, which the Worker answers by restoring what you confirmed. */
export function undoChangePlan(records: RecordRef[]): Plan {
  return { steps: [planStep("reject", { records, reason: "Undone in the app: not their change" })], done: "Undone." };
}

/** Your own draft about another member, taken back before they confirm it (ticket 69): a reject by who logged it. */
export function withdrawPlan(records: RecordRef[]): Plan {
  return { steps: [planStep("reject", { records, reason: "Withdrawn in the app by who logged it" })], done: "Taken back." };
}

/**
 * Amending a draft portion confirms it (the member's own edit is
 * acceptance), and the API confirms its intake item in the same write.
 */
export function changeSharePlan(ask: { portionId: number }, percent: string): Plan | { error: string } {
  const value = typedNumber(percent);
  if (percent.trim() === "" || !Number.isFinite(value) || value < 1 || value > 100) return { error: "Enter your share as a percent from 1 to 100." };
  const steps = [planStep("amend", { record: { table: "portion", id: ask.portionId }, changes: { fraction: value / 100 }, reason: "Changed my share in the app" })];
  return { steps, done: `Share changed to ${value}%.` };
}

export function leftoverPlan(componentId: number): Plan {
  return {
    steps: [planStep("mark_remainder", { component_id: componentId, disposition: "leftover", provenance: "estimated" })],
    done: "Marked the rest leftover.",
  };
}

/** Plain words for the questions the app's writes (and route_text's pieces) can raise; any other comes through as the API says it. */
const QUESTIONS: Record<string, string> = {
  portions_exceed_whole: "With the others' shares, that comes to more than the whole pot. Enter a smaller share.",
  nothing_unaccounted: "Nothing of this pot is unaccounted any more.",
  not_unaccounted: "The rest of this pot is already marked as leftover, eaten or thrown out, so it can't take a new share. Log a helping of leftovers on the Household screen, or send it to Claude.",
  // The API says "a portion of whole; amend it": the component's internal name and the agent's verb.
  duplicate_portion: "You already have a share of this pot. Change it on the pot card on Today, or send it to Claude.",
  // Only a fallback: the Worker's own question names the pot's cook in the member's words (and, on amend and mark_remainder, another member's share).
  cooked_weight_needed: "This pot has no cooked weight yet, so a share in grams can't be worked out. Give the share in %, or weigh the whole pot first.",
  session_choice: "There is more than one strength session on this day now. Read it again to choose which one these sets are in.",
  // A rename (amend, Worker decision 127) or a new record onto another's name; the API's words carry its ref.
  duplicate_food_source: "Another food already has this name in this state. Choose another name, or open that food from the list.",
  duplicate_recipe: "Another recipe already has this name. Choose another name, or open that recipe from the list.",
};

/** The API's energy question names its own input (energy_override_reason); the member answers in the field below instead. */
const ENERGY_ASK = /\s*If the label really says this, give energy_override_reason\.?\s*$/;
const ENERGY_PLAIN = " If the label really says this, say why below and save again.";

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A question in plain words: the app's own copy for a reason it knows, else the API's question as it asks it.
 * cooked_weight_needed is the API's own words whenever it gave any, since it names the member in question.
 */
export const plainQuestion = (reason: string, question: string): string => {
  const q = question.trim();
  if (reason === "cooked_weight_needed" && q !== "") return sentence(q);
  // The server names every share, the eaten leftover included (click test P1-7): say them, so the refusal has a visible reason.
  const shares = reason === "portions_exceed_whole" ? /; shares: (.+?)\.? What is right\?$/.exec(q)?.[1] : undefined;
  if (shares) return `With the others' shares, that comes to more than the whole pot: ${shares}. Enter a smaller share.`;
  // energy_mismatch keeps the API's numbers; only its last sentence, which names an input field, is said plainly.
  if (reason === "energy_mismatch" && q !== "") return sentence(q.replace(ENERGY_ASK, "")) + ENERGY_PLAIN;
  return QUESTIONS[reason] ?? sentence(question);
};

/**
 * A refusal that wrote nothing: an error code the API raised (not a proxy's `http_NNN`) with a 4xx status,
 * except a timeout or rate limit (408, 429: transient) and `idempotency_key_reused` (409: a write with
 * that key landed), which stay held.
 */
export function refusedOutright(out: { code: string; http: number }): boolean {
  if (out.http < 400 || out.http >= 500 || out.http === 408 || out.http === 429) return false;
  return !out.code.startsWith("http_") && out.code !== "idempotency_key_reused";
}

/** A message as one sentence: the API's own words may or may not already end in a full stop. */
const endsOnce = (message: string): string => message.trim().replace(/[.\s]+$/, "");

/**
 * A failed write's words. A held failure is followed by a "Try again" button, so its copy never says
 * "try again" itself; a refusal (not held, no button) says what to do.
 */
export function errorCopy(out: { code: string; message: string; http: number }): string {
  if (out.code === NO_ANSWER) return "Not saved: the server didn't answer.";
  const refused = refusedOutright(out);
  return `Not saved: ${endsOnce(out.message)}. Refresh to see the latest${refused ? ", then try again" : ""}.`;
}

/** Run a plan's steps in order; each step's answer comes back with the status (the steps that landed, when one fails). */
export async function runPlanResults(plan: Plan, call: Call): Promise<{ status: WriteStatus; results: Record<string, unknown>[] }> {
  const results: Record<string, unknown>[] = [];
  for (const s of plan.steps) {
    const out = await call(s.tool, s.input);
    switch (out.kind) {
      case "ok":
        results.push(out.data);
        continue;
      case "needs_clarification":
        return {
          status: {
            state: "question", message: plainQuestion(out.reason, out.question), reason: out.reason,
            ...(out.path ? { path: out.path } : {}), ...(out.options.length > 0 ? { options: out.options } : {}),
          },
          results,
        };
      case "invalid":
        // Rejected only when no earlier step landed: a later step's refusal leaves the plan held, so a retry replays what landed with its own keys.
        return { status: { state: "failed", message: `Not saved: ${endsOnce(out.message)}. Change the value and try again.`, ...(results.length === 0 ? { rejected: true as const } : {}) }, results };
      case "error":
        // A definitive first-step refusal (a 4xx the API raised: not_visible, not_draft, not_pending, ...) wrote
        // nothing, so it is rejected like invalid; a 5xx, a proxy's page or a reused key may have landed: held.
        return {
          status: { state: "failed", message: errorCopy(out), ...(results.length === 0 && refusedOutright(out) ? { rejected: true as const } : {}) },
          results,
        };
      case "offline":
        return { status: { state: "failed", message: "Not saved: you're offline." }, results };
      case "signed_out":
        return { status: { state: "signed_out", message: "Your sign-in has expired." }, results };
    }
  }
  return { status: { state: "saved", message: plan.done }, results };
}

/** A failed plan is held for "Try again" with its own keys unless the API rejected it before anything landed. */
export function holdsForRetry(status: WriteStatus | null | undefined): boolean {
  return status?.state === "failed" && status.rejected !== true;
}

/**
 * A status that has said its piece once the member moves on (Cancel, Keep,
 * or opening the row's Edit or Remove again): a question, a refusal or a
 * saved line. A write going through, or held for "Try again", stays.
 */
export function clearsOnLeave(status: WriteStatus | null | undefined): boolean {
  return !!status && status.state !== "pending" && !holdsForRetry(status);
}

/** A Save's status and each step's answer (log_workout's progression, say). */
export interface WriteResult {
  status: WriteStatus;
  results: Record<string, unknown>[];
}

/**
 * What a form does with its Save's result (close, reset, show what was
 * logged). It is kept with the plan, so "Try again" runs it too: a retried
 * Save that lands closes the form exactly as the first tap would have, and
 * a second tap can never make new keys for a write that landed (decision 74).
 */
export type AfterSave = (result: WriteResult) => void;

/**
 * A form's after-save that closes it once the plan lands, from its own Save or from "Try again" (decision 74).
 * `close` is handed what was saved, so the list the form goes back to can say it (decision 91).
 */
export const closeOnSaved = (close: (saved: string) => void): AfterSave => (out) => {
  if (out.status.state === "saved") close(out.status.message);
};

export interface WriteBook {
  /** Sends the plan under `key`, holding it (and `after`) for "Try again" until it lands. */
  run(key: string, plan: Plan, after?: AfterSave): Promise<WriteResult>;
  /** Resends the key's held plan with the same keys and its own `after`; null when nothing is held. */
  retry(key: string): Promise<WriteResult | null>;
  /**
   * Answers the key's question: its held plan again, with `value` set at `path` in the `tool` step, under the
   * same keys (answerPlan). `current` is what the form would send for that step now: unless it is still the
   * entry that was asked about (`matches`), nothing is sent, so an answer never confirms an older entry
   * (review round). Null when nothing is sent.
   */
  answer(key: string, tool: string, path: AnswerPath, value: unknown, current: Record<string, unknown> | null): Promise<WriteResult | null>;
  /** Whether the form's current entry for `tool` is still the held plan's (so its question may be answered). */
  matches(key: string, tool: string, current: Record<string, unknown> | null): boolean;
  holds(key: string): boolean;
}

export type AnswerPath = (string | number)[];

/** A value with its object keys sorted, for comparing entries (`idempotency_key` left out at the top). */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Whether two tool inputs are the same entry, whatever their key order and idempotency keys. */
export function sameInput(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const { idempotency_key: _a, ...x } = a;
  const { idempotency_key: _b, ...y } = b;
  return canonicalJson(x) === canonicalJson(y);
}

/** `input` with `value` set at `path` (objects and arrays copied along the way, never mutated). */
function setAt(input: unknown, path: AnswerPath, value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path as [string | number, ...AnswerPath];
  if (Array.isArray(input)) {
    const copy = [...input];
    copy[Number(head)] = setAt(copy[Number(head)], rest, value);
    return copy;
  }
  const obj = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return { ...obj, [head]: setAt(obj[head], rest, value) };
}

/**
 * The asked plan with the member's answer set at the question's `path` in
 * its `tool` step (load.implement, sets.3.load.implement, gym), every key
 * kept: a question wrote nothing, so the API takes the corrected call under
 * the key it asked under, and a held Save never gains new keys.
 */
export function answerPlan(plan: Plan, tool: string, path: AnswerPath, value: unknown): Plan {
  return { ...plan, steps: plan.steps.map((s) => (s.tool === tool ? { tool: s.tool, input: setAt(s.input, path, value) as Step["input"] } : s)) };
}

export interface Choice {
  label: string;
  path: AnswerPath;
  value: unknown;
}

/**
 * A question's options as one-tap answers (ticket 63's gym chips, made
 * general by click test P1-6): every string or number option of a question
 * that says where its answer goes (`path`), "Which gym?" and "Which cable?"
 * alike. None for any other status.
 */
/**
 * The questions whose options are themselves answers at the question's path,
 * each checked end to end against the Worker (fixes-contract): the gyms for
 * `gym`, the gym's implements for `load.implement`. Any other question
 * (load_needed's "not_recorded", unit_unclear's "50 kg", position_past_end's
 * "4") stays a plain question: its options are words for the member, not values.
 */
const ANSWERED_BY_OPTION: ReadonlySet<string> = new Set(["gym_needed", "implement_needed"]);

export function questionChoices(status: WriteStatus | null): Choice[] {
  if (status?.state !== "question" || !status.path || status.path.length === 0 || !status.reason) return [];
  const path = status.path;
  // An implausible reading (click test P1-2) is confirmed, not chosen: one chip resends it as typed.
  if (status.reason === "implausible_reading") return [{ label: "Yes, it's right", path, value: true }];
  if (!ANSWERED_BY_OPTION.has(status.reason)) return [];
  return (status.options ?? []).filter((o): o is string | number => typeof o === "string" || typeof o === "number").map((o) => ({ label: String(o), path, value: o }));
}

/**
 * The plans held per key, outside React so it can be tested: each attempt
 * reports its status, a saved plan is dropped (the next Save is a new plan)
 * and calls `saved`, a sign-out calls `signedOut`, and then the plan's
 * `after` runs, on the first tap and on every "Try again" alike.
 */
export function writeBook(
  call: Call,
  on: { status(key: string, status: WriteStatus): void; saved(): void; signedOut(): void; track?<T>(work: () => Promise<T>): Promise<T> },
): WriteBook {
  const held = new Map<string, { plan: Plan; after?: AfterSave }>();
  const matches = (key: string, tool: string, current: Record<string, unknown> | null): boolean => {
    const step = held.get(key)?.plan.steps.find((s) => s.tool === tool);
    return step !== undefined && current !== null && sameInput(step.input, current);
  };
  const run = async (key: string, plan: Plan, after?: AfterSave): Promise<WriteResult> => {
    held.set(key, after ? { plan, after } : { plan });
    on.status(key, { state: "pending", message: "Saving…" });
    const send = () => runPlanResults(plan, call);
    const result = await (on.track ? on.track(send) : send());
    on.status(key, result.status);
    if (result.status.state === "saved") {
      held.delete(key);
      on.saved();
    }
    if (result.status.state === "signed_out") on.signedOut();
    after?.(result);
    return result;
  };
  return {
    run,
    retry: async (key) => {
      const h = held.get(key);
      return h ? run(key, h.plan, h.after) : null;
    },
    answer: async (key, tool, path, value, current) => {
      const h = held.get(key);
      if (!h || !matches(key, tool, current)) return null;
      return run(key, answerPlan(h.plan, tool, path, value), h.after);
    },
    matches,
    holds: (key) => held.has(key),
  };
}

export async function runPlan(plan: Plan, call: Call): Promise<WriteStatus> {
  return (await runPlanResults(plan, call)).status;
}

/** The member confirms inferred reps were as logged: one amend per set, so a retry replays the ones that landed. */
export function confirmRepsPlan(setIds: number[]): Plan {
  return {
    steps: setIds.map((id) => planStep("amend", { record: { table: "session_set", id }, changes: { reps_inferred: false }, reason: "Reps confirmed as logged, in the app" })),
    done: "Reps confirmed.",
  };
}

/** An unverified step on a listed implement, answered at the gym. Plate offers need the plates themselves, so they go to chat (null). */
export function checkStepPlan(offer: CheckOffer, there: boolean): Plan | null {
  const side = there ? offer.if_exists : offer.if_not;
  if (side.tool !== "add_implement_load" && side.tool !== "remove_implement_load") return null;
  const input: Record<string, unknown> = { implement_id: side.implement_id, loads: side.loads };
  if (!there) input.reason = "Not at the gym (checked in the app)";
  return { steps: [planStep(side.tool, input)], done: there ? "Recorded: it's there." : "Recorded: it isn't there." };
}

/** The plates the member saw on the rack are available; the others asked about are absent. */
export function platesPlan(member: string, unit: "kg" | "lb", values: number[], seen: number[]): Plan {
  return {
    steps: [planStep("record_plates", { member, unit, available: values.filter((v) => seen.includes(v)), absent: values.filter((v) => !seen.includes(v)) })],
    done: "Plates saved.",
  };
}

export function resolveFlagPlan(flagId: number, resolution: string): Plan | { error: string } {
  const why = resolution.trim();
  if (why === "") return { error: "Say how it was resolved." };
  return { steps: [planStep("resolve_flag", { flag_id: flagId, resolution: why })], done: "Resolved." };
}

/**
 * How much of a leftover was eaten, as typed: empty (or all that is left) is
 * all of it; else a share of the whole pot from 1% to what is left (click
 * test P2-27). `left` is the leftover's fraction of the pot.
 */
export function leftoverShare(text: string, left: number): { all: true } | { fraction: number } | { error: string } {
  const t = text.trim().replace(/\s*%$/, "");
  if (t === "") return { all: true };
  const v = typedNumber(t);
  const most = Math.round(left * 100);
  if (!Number.isFinite(v) || v < 1 || v > most) return { error: `Give a share from 1% to ${most}%, or leave it empty for all of it.` };
  return v === most ? { all: true } : { fraction: v / 100 };
}

/** A leftover eaten by a member at a meal: dated today by the API (Task 13), never the cook's day; all of it unless `fraction` (of the pot) is given. */
export function leftoverEatenPlan(componentId: number, member: string, mealSlot: string, fraction?: number): Plan {
  return {
    steps: [planStep("mark_remainder", { component_id: componentId, disposition: "eaten", member, meal_slot: mealSlot, provenance: "estimated", ...(fraction === undefined ? {} : { fraction }) })],
    done: fraction === undefined ? `Marked eaten by ${member}.` : `Marked ${Math.round(fraction * 100)}% of the pot eaten by ${member}.`,
  };
}

export function leftoverDiscardPlan(componentId: number): Plan {
  return { steps: [planStep("mark_remainder", { component_id: componentId, disposition: "discarded", provenance: "estimated" })], done: "Marked discarded." };
}
