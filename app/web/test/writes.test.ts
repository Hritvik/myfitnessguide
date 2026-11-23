import { describe, expect, it } from "vitest";
import { failedToReach, type Outcome } from "../src/api";
import { answerPlan, sameInput, clearsOnLeave, changeSharePlan, checkStepPlan, closeOnSaved, questionChoices, writeBook, confirmPlan, confirmRepsPlan, holdsForRetry, refusedOutright, leftoverDiscardPlan, leftoverEatenPlan, leftoverShare, leftoverPlan, plainQuestion, platesPlan, rejectPlan, withdrawPlan, undoChangePlan, planStep, resolveFlagPlan, runPlan, runPlanResults, type Call } from "../src/writes";

const ok: Outcome = { kind: "ok", data: { status: "ok" } };

function recorder(replies: Outcome[]) {
  const calls: { tool: string; input: Record<string, unknown> }[] = [];
  const call: Call = async (tool, input) => {
    calls.push({ tool, input });
    return replies.shift() ?? ok;
  };
  return { calls, call };
}

describe("write plans", () => {
  it("confirms a pot draft by its portion; the API confirms the portion's intake item with it", () => {
    const plan = confirmPlan([{ table: "portion", id: 7 }]);
    expect(plan.steps).toEqual([{ tool: "confirm", input: { records: [{ table: "portion", id: 7 }], idempotency_key: expect.any(String) } }]);
    expect(plan.done).toBe("Confirmed.");
  });

  it("changes my share as one amend with a reason; the API confirms the portion and its intake item together", () => {
    const plan = changeSharePlan({ portionId: 7 }, "40");
    expect(plan).not.toHaveProperty("error");
    if ("error" in plan) return;
    expect(plan.steps.map((s) => [s.tool, { ...s.input, idempotency_key: "k" }])).toEqual([
      ["amend", { record: { table: "portion", id: 7 }, changes: { fraction: 0.4 }, reason: "Changed my share in the app", idempotency_key: "k" }],
    ]);
    expect(plan.done).toBe("Share changed to 40%.");
  });

  it("refuses a share that isn't a whole percent from 1 to 100, saying what to enter", () => {
    for (const bad of ["", "0", "101", "abc", "-5"]) expect(changeSharePlan({ portionId: 7 }, bad)).toEqual({ error: "Enter your share as a percent from 1 to 100." });
    const decimal = changeSharePlan({ portionId: 7 }, "37.5");
    expect("error" in decimal ? null : decimal.steps[0]?.input.changes).toEqual({ fraction: 0.375 });
  });

  it("marks the rest of a component leftover", () => {
    const plan = leftoverPlan(21);
    expect(plan.steps[0]).toEqual({ tool: "mark_remainder", input: { component_id: 21, disposition: "leftover", provenance: "estimated", idempotency_key: expect.any(String) } });
    expect(plan.done).toBe("Marked the rest leftover.");
  });

  it("rejects a draft with a reason", () => {
    const plan = rejectPlan([{ table: "intake_item", id: 5 }]);
    expect(plan.steps[0]).toEqual({ tool: "reject", input: { records: [{ table: "intake_item", id: 5 }], reason: "Rejected in the app: not eaten", idempotency_key: expect.any(String) } });
  });

  it("withdraws your own draft about another member, saying so (ticket 69)", () => {
    const plan = withdrawPlan([{ table: "intake_item", id: 5 }]);
    expect(plan.steps[0]).toEqual({ tool: "reject", input: { records: [{ table: "intake_item", id: 5 }], reason: "Withdrawn in the app by who logged it", idempotency_key: expect.any(String) } });
    expect(plan.done).toBe("Taken back.");
  });

  it("undoes someone else's edit of your record: a reject, which the Worker turns into a restore (ticket 69 review P1-1)", () => {
    const plan = undoChangePlan([{ table: "intake_item", id: 5 }]);
    expect(plan.steps[0]).toEqual({ tool: "reject", input: { records: [{ table: "intake_item", id: 5 }], reason: "Undone in the app: not their change", idempotency_key: expect.any(String) } });
    expect(plan.done).toBe("Undone.");
  });

  it("gives every step its own idempotency key", () => {
    const plans = [confirmPlan([{ table: "portion", id: 7 }]), leftoverPlan(21)];
    const keys = plans.flatMap((p) => p.steps.map((s) => s.input.idempotency_key));
    expect(new Set(keys).size).toBe(2);
  });
});

describe("runPlan", () => {
  it("runs the steps in order and reports saved with the plan's words", async () => {
    const r = recorder([ok]);
    const plan = changeSharePlan({ portionId: 7 }, "40");
    if ("error" in plan) throw new Error("unexpected");
    expect(await runPlan(plan, r.call)).toEqual({ state: "saved", message: "Share changed to 40%." });
    expect(r.calls.map((c) => c.tool)).toEqual(["amend"]);
    const two = recorder([ok, ok]);
    expect(await runPlan({ steps: [...plan.steps, ...leftoverPlan(21).steps], done: "Both." }, two.call)).toEqual({ state: "saved", message: "Both." });
    expect(two.calls.map((c) => c.tool)).toEqual(["amend", "mark_remainder"]);
  });

  it("stops at a question and shows it inline", async () => {
    const r = recorder([{ kind: "needs_clarification", question: "Portions of whole add up to 1.1, more than the whole cook. What is right?", options: [], reason: "portions_exceed_whole" }]);
    const plan = changeSharePlan({ portionId: 7 }, "80");
    if ("error" in plan) throw new Error("unexpected");
    expect(await runPlan(plan, r.call)).toEqual({ state: "question", message: "With the others' shares, that comes to more than the whole pot. Enter a smaller share.", reason: "portions_exceed_whole" });
    expect(plainQuestion("duplicate_portion", "Asha already has a portion of whole; amend it instead.")).toBe("You already have a share of this pot. Change it on the pot card on Today, or send it to Claude.");
    expect(r.calls).toHaveLength(1);
  });

  it("keeps the API's member-named question for cooked_weight_needed on amend and mark_remainder, and falls back to the app's copy only when it is empty", async () => {
    const asked = "Kabir's share of the Rajma has no cooked weight yet, so 250 g of it can't be worked out.";
    const r = recorder([{ kind: "needs_clarification", question: asked, options: [], reason: "cooked_weight_needed" }]);
    const plan = changeSharePlan({ portionId: 7 }, "80");
    if ("error" in plan) throw new Error("unexpected");
    expect(await runPlan(plan, r.call)).toMatchObject({ state: "question", message: asked, reason: "cooked_weight_needed" });
    const r2 = recorder([{ kind: "needs_clarification", question: "kabir's share has no cooked weight yet.", options: [], reason: "cooked_weight_needed" }]);
    expect(await runPlan(leftoverPlan(21), r2.call)).toMatchObject({ state: "question", message: "Kabir's share has no cooked weight yet." });
    expect(plainQuestion("cooked_weight_needed", "  ")).toMatch(/^This pot has no cooked weight yet/);
  });

  it("passes any other question through as the API asks it, sentence-cased", async () => {
    const r = recorder([{ kind: "needs_clarification", question: "which meal was it eaten at?", options: [], reason: "meal_slot_needed" }]);
    expect(await runPlan(leftoverPlan(21), r.call)).toEqual({ state: "question", message: "Which meal was it eaten at?", reason: "meal_slot_needed" });
  });

  it("fails with what went wrong and what to do next", async () => {
    const plan = confirmPlan([{ table: "portion", id: 7 }]);
    expect(await runPlan(plan, recorder([{ kind: "error", code: "not_draft", message: "portion 7 is already confirmed", http: 409 }]).call)).toEqual({
      state: "failed",
      message: "Not saved: portion 7 is already confirmed. Refresh to see the latest, then try again.",
      rejected: true,
    });
    expect(await runPlan(plan, recorder([{ kind: "invalid", message: "changes.fraction: Too big" }]).call)).toEqual({
      state: "failed",
      message: "Not saved: changes.fraction: Too big. Change the value and try again.",
      rejected: true,
    });
    expect(await runPlan(plan, recorder([{ kind: "offline" }]).call)).toEqual({
      state: "failed",
      message: "Not saved: you're offline.",
    });
    expect(await runPlan(plan, recorder([{ kind: "signed_out", http: 401 }]).call)).toEqual({ state: "signed_out", message: "Your sign-in has expired." });
  });

  it("a retry resends the same keys, so a step that already landed is replayed, not written twice", async () => {
    const share = changeSharePlan({ portionId: 7 }, "40");
    if ("error" in share) throw new Error("unexpected");
    const plan = { steps: [...share.steps, ...leftoverPlan(21).steps], done: "Both." };
    const first = recorder([ok, { kind: "offline" }]);
    expect((await runPlan(plan, first.call)).state).toBe("failed");
    const second = recorder([ok, ok]);
    expect((await runPlan(plan, second.call)).state).toBe("saved");
    expect(second.calls.map((c) => c.input.idempotency_key)).toEqual(first.calls.map((c) => c.input.idempotency_key));
  });
});
describe("a failed write's copy", () => {
  const plan = { steps: [planStep("log_reading", { member: "Asha" })], done: "Done." };

  it("ends the API's message with one full stop, whether or not it came with one", async () => {
    for (const message of ["The server failed (HTTP 503).", "The server failed (HTTP 503)", "The server failed (HTTP 503)..."]) {
      const r = await runPlan(plan, recorder([{ kind: "error", code: "http_503", message, http: 503 }]).call);
      expect(r).toMatchObject({ message: "Not saved: The server failed (HTTP 503). Refresh to see the latest." });
    }
    const invalid = await runPlan(plan, recorder([{ kind: "invalid", message: "Too small." }]).call);
    expect(invalid).toMatchObject({ message: "Not saved: Too small. Change the value and try again." });
  });

  it("says the server didn't answer, not offline, and holds the plan for Try again", async () => {
    const r = await runPlanResults(plan, recorder([failedToReach(true)]).call);
    expect(r.status).toEqual({ state: "failed", message: "Not saved: the server didn't answer." });
    expect(holdsForRetry(r.status)).toBe(true);
    expect((await runPlan(plan, recorder([failedToReach(false)]).call)).message).toBe("Not saved: you're offline.");
  });
});

describe("a held failure's copy", () => {
  const plan = { steps: [planStep("log_reading", { member: "Asha" })], done: "Done." };

  it("never says try again itself, since a Try again button follows it", async () => {
    for (const out of [failedToReach(true), failedToReach(false), { kind: "error", code: "http_503", message: "The server failed (HTTP 503).", http: 503 }, { kind: "error", code: "idempotency_key_reused", message: "Used.", http: 409 }] as const) {
      const r = await runPlanResults(plan, recorder([out]).call);
      expect(holdsForRetry(r.status)).toBe(true);
      expect(r.status).toMatchObject({ message: expect.not.stringMatching(/try again/i) });
      expect((r.status as { message: string }).message.match(/\.$/)).not.toBeNull();
      expect((r.status as { message: string }).message).not.toContain("..");
    }
  });
});

describe("holdsForRetry", () => {
  const plan = { steps: [planStep("log_reading", { member: "Asha" }), planStep("amend", { record: { table: "reading", id: 1 } })], done: "Done." };

  it("lets go of a plan the API rejected before anything landed: nothing was written, so a changed entry is a new plan", async () => {
    const r = await runPlanResults(plan, recorder([{ kind: "invalid", message: "value: Too small" }]).call);
    expect(r.status).toMatchObject({ state: "failed", rejected: true });
    expect(holdsForRetry(r.status)).toBe(false);
  });

  it("holds an offline or error failure, which may have landed, for Try again with its own keys", async () => {
    expect(holdsForRetry(await runPlan(plan, recorder([{ kind: "offline" }]).call))).toBe(true);
    expect(holdsForRetry(await runPlan(plan, recorder([{ kind: "error", code: "internal", message: "boom", http: 500 }]).call))).toBe(true);
  });

  it("lets go of a first step's definitive 4xx refusal (nothing written), like invalid", async () => {
    for (const [code, http] of [["invalid", 400], ["not_visible", 403], ["not_found", 404], ["not_draft", 409], ["not_this_member", 400], ["not_pending", 409], ["constraint", 422]] as const) {
      const r = await runPlanResults(plan, recorder([{ kind: "error", code, message: "no", http }]).call);
      expect(r.status, code).toMatchObject({ state: "failed", rejected: true });
      expect(holdsForRetry(r.status), code).toBe(false);
    }
  });

  it("holds a 5xx, a proxy's 4xx page, a timeout or rate limit, and a reused key's 409: any of them may have landed", async () => {
    for (const [code, http] of [["internal", 500], ["http_502", 502], ["http_413", 413], ["timeout", 408], ["rate_limited", 429], ["idempotency_key_reused", 409]] as const) {
      expect(refusedOutright({ code, http }), code).toBe(false);
      expect(holdsForRetry(await runPlan(plan, recorder([{ kind: "error", code, message: "no", http }]).call)), code).toBe(true);
    }
  });

  it("holds a later step's 4xx refusal, since an earlier step landed", async () => {
    const r = await runPlanResults(plan, recorder([ok, { kind: "error", code: "not_draft", message: "no", http: 409 }]).call);
    expect(r.status).not.toHaveProperty("rejected");
    expect(holdsForRetry(r.status)).toBe(true);
  });

  it("holds a plan refused at a later step, since an earlier step landed", async () => {
    const r = await runPlanResults(plan, recorder([ok, { kind: "invalid", message: "changes: Too big" }]).call);
    expect(r.status.state).toBe("failed");
    expect(holdsForRetry(r.status)).toBe(true);
  });

  it("holds nothing that isn't a failure: saved, a question, signed out, or nothing yet", () => {
    expect(holdsForRetry({ state: "saved", message: "Done." })).toBe(false);
    expect(holdsForRetry({ state: "question", message: "Which?" })).toBe(false);
    expect(holdsForRetry({ state: "signed_out", message: "Your sign-in has expired." })).toBe(false);
    expect(holdsForRetry(null)).toBe(false);
  });
});
describe("training plans", () => {
  it("confirms inferred reps by amending each set, one key per step", () => {
    const plan = confirmRepsPlan([7, 8]);
    expect(plan.steps.map((s) => [s.tool, s.input.record, s.input.changes])).toEqual([
      ["amend", { table: "session_set", id: 7 }, { reps_inferred: false }],
      ["amend", { table: "session_set", id: 8 }, { reps_inferred: false }],
    ]);
    expect(new Set(plan.steps.map((s) => s.input.idempotency_key)).size).toBe(2);
  });

  it("answers an unverified step either way, with a reason when it isn't there", () => {
    const offer = { if_exists: { tool: "add_implement_load", implement_id: 4, loads: [{ value: 45, unit: "kg" as const }] }, if_not: { tool: "remove_implement_load", implement_id: 4, loads: [{ value: 45, unit: "kg" as const }] } };
    expect(checkStepPlan(offer, true)?.steps[0]).toMatchObject({ tool: "add_implement_load", input: { implement_id: 4, loads: [{ value: 45, unit: "kg" }] } });
    expect(checkStepPlan(offer, false)?.steps[0]).toMatchObject({ tool: "remove_implement_load", input: { implement_id: 4, loads: [{ value: 45, unit: "kg" }], reason: "Not at the gym (checked in the app)" } });
    expect(checkStepPlan({ if_exists: { tool: "record_plates" }, if_not: { tool: "record_plates" } }, true)).toBeNull();
  });

  it("records the plates seen as available and the rest as absent", () => {
    expect(platesPlan("Asha", "kg", [1.25, 2.5, 25], [2.5]).steps[0]).toMatchObject({ tool: "record_plates", input: { member: "Asha", unit: "kg", available: [2.5], absent: [1.25, 25] } });
  });
});

describe("resolveFlagPlan", () => {
  it("records why the flag is resolved, and asks for a reason when blank", () => {
    expect(resolveFlagPlan(2, "  Repeated on 1 Nov; normal  ")).toMatchObject({ steps: [{ tool: "resolve_flag", input: { flag_id: 2, resolution: "Repeated on 1 Nov; normal" } }], done: "Resolved." });
    expect(resolveFlagPlan(2, "   ")).toEqual({ error: "Say how it was resolved." });
  });
});

describe("leftover plans", () => {
  it("marks one eaten by a member at a meal, or discarded", () => {
    expect(leftoverEatenPlan(31, "Kabir", "dinner")).toMatchObject({ steps: [{ tool: "mark_remainder", input: { component_id: 31, disposition: "eaten", member: "Kabir", meal_slot: "dinner", provenance: "estimated" } }], done: "Marked eaten by Kabir." });
    expect(leftoverDiscardPlan(31)).toMatchObject({ steps: [{ tool: "mark_remainder", input: { component_id: 31, disposition: "discarded", provenance: "estimated" } }], done: "Marked discarded." });
  });

  it("a retried plan sends the same idempotency key, so a write that landed is replayed, not repeated", async () => {
    const plan = leftoverEatenPlan(31, "Kabir", "dinner");
    const r = recorder([{ kind: "offline" }, ok]);
    expect((await runPlan(plan, r.call)).state).toBe("failed");
    expect((await runPlan(plan, r.call)).state).toBe("saved");
    expect(r.calls[0]?.input.idempotency_key).toBe(r.calls[1]?.input.idempotency_key);
  });

  it("a second eaten tap on a leftover that is already gone surfaces the API's question, not a write", async () => {
    const question: Outcome = { kind: "needs_clarification", question: "Nothing of this leftover is left.", options: [], reason: "nothing_left" };
    const r = recorder([question]);
    const status = await runPlan(leftoverEatenPlan(31, "Kabir", "dinner"), r.call);
    expect(status.state).toBe("question");
    expect(r.calls).toHaveLength(1);
  });
});

describe("runPlanResults", () => {
  it("returns each step's answer with the status", async () => {
    const plan = { steps: [planStep("log_workout", { member: "Asha" }), planStep("amend", { reason: "r" })], done: "Logged." };
    const r = recorder([{ kind: "ok", data: { status: "ok", progression: [1] } }, { kind: "ok", data: { status: "ok" } }]);
    expect(await runPlanResults(plan, r.call)).toEqual({ status: { state: "saved", message: "Logged." }, results: [{ status: "ok", progression: [1] }, { status: "ok" }] });
  });

  it("keeps the answers of the steps that landed when a later one fails, and a retry replays them by key", async () => {
    const plan = { steps: [planStep("household_meal", { date: "2026-10-06" }), planStep("add_recipe_line", { recipe: "R001" })], done: "Logged, and the recipe updated for everyone." };
    const first = recorder([{ kind: "ok", data: { status: "ok", cooks: [] } }, { kind: "offline" }]);
    const failed = await runPlanResults(plan, first.call);
    expect(failed.status.state).toBe("failed");
    expect(failed.results).toHaveLength(1);
    const again = recorder([{ kind: "ok", data: { status: "ok", cooks: [] } }, ok]);
    expect((await runPlanResults(plan, again.call)).status.state).toBe("saved");
    expect(again.calls.map((c) => c.input.idempotency_key)).toEqual(first.calls.map((c) => c.input.idempotency_key));
  });

  it("gives a new plan new keys", () => {
    const a = planStep("log_intake", { member: "Asha" });
    const b = planStep("log_intake", { member: "Asha" });
    expect(a.input.idempotency_key).not.toBe(b.input.idempotency_key);
  });
});

describe("a rename onto another record's name", () => {
  it("is asked in plain words, never with the other record's ref", () => {
    expect(plainQuestion("duplicate_food_source", "Rice (dry) already exists as FS001. Use that one, or choose another name?")).toBe("Another food already has this name in this state. Choose another name, or open that food from the list.");
    expect(plainQuestion("duplicate_recipe", "A recipe called Poha already exists as R001. Use it, or choose another name?")).toBe("Another recipe already has this name. Choose another name, or open that recipe from the list.");
  });
});

describe("the energy question", () => {
  it("keeps the API's numbers and says the answer plainly, never the input's name", () => {
    const q = plainQuestion("energy_mismatch", "The macros give 96.4 kcal (4/4/9), 103.6 kcal under the stated 200. Is a macro missing or misread, or the reference amount wrong? If the label really says this, give energy_override_reason.");
    expect(q).toBe("The macros give 96.4 kcal (4/4/9), 103.6 kcal under the stated 200. Is a macro missing or misread, or the reference amount wrong? If the label really says this, say why below and save again.");
    expect(q).not.toMatch(/energy_override_reason/);
  });
});

describe("writeBook: Try again does what the form's own Save would have (decision 74)", () => {
  const fail500: Outcome = { kind: "error", code: "internal", message: "boom", http: 500 };

  function book(replies: Outcome[]) {
    const r = recorder(replies);
    const statuses: string[] = [];
    let saved = 0;
    let signedOut = 0;
    const b = writeBook(r.call, { status: (_k, s) => statuses.push(s.state), saved: () => saved++, signedOut: () => signedOut++ });
    return { ...r, b, statuses, saved: () => saved, signedOut: () => signedOut };
  }

  it("a form that closes on its Save is handed what was saved, so the list it goes back to can say so (click test P2-5)", async () => {
    const t = book([ok]);
    const notes: string[] = [];
    await t.b.run("save", { steps: [planStep("log_intake", { member: "Asha" })], done: "Logged Oats to Lunch." }, closeOnSaved((note) => notes.push(note)));
    expect(notes).toEqual(["Logged Oats to Lunch."]);
  });

  it("a held Save whose Try again lands closes the form once, with the same keys, and nothing is left to resend", async () => {
    const t = book([fail500, ok]);
    const plan = { steps: [planStep("log_intake", { member: "Asha" })], done: "Logged." };
    let closed = 0;
    const first = await t.b.run("save", plan, closeOnSaved(() => closed++));
    expect(first.status.state).toBe("failed");
    expect(closed).toBe(0);
    expect(t.b.holds("save")).toBe(true);

    const again = await t.b.retry("save");
    expect(again?.status).toEqual({ state: "saved", message: "Logged." });
    expect(closed).toBe(1);
    expect(t.saved()).toBe(1);
    expect(t.calls.map((c) => c.input.idempotency_key)).toEqual([plan.steps[0]!.input.idempotency_key, plan.steps[0]!.input.idempotency_key]);
    // Nothing held: a second "Try again" sends nothing and runs nothing.
    expect(t.b.holds("save")).toBe(false);
    expect(await t.b.retry("save")).toBeNull();
    expect(t.calls).toHaveLength(2);
    expect(closed).toBe(1);
    expect(t.statuses).toEqual(["pending", "failed", "pending", "saved"]);
  });

  it("gives the after-save every attempt's result, with each step's answers, so a form can hold or show what was logged", async () => {
    const t = book([{ kind: "offline" }, { kind: "ok", data: { status: "ok", session: { id: 4 } } }]);
    const seen: { state: string; results: unknown[] }[] = [];
    await t.b.run("workout", { steps: [planStep("log_workout", {})], done: "Saved." }, (o) => seen.push({ state: o.status.state, results: o.results }));
    await t.b.retry("workout");
    expect(seen).toEqual([
      { state: "failed", results: [] },
      { state: "saved", results: [{ status: "ok", session: { id: 4 } }] },
    ]);
  });

  it("keeps a plan's after-save per key, and a new Save replaces both", async () => {
    const t = book([fail500, fail500, ok]);
    const ran: string[] = [];
    await t.b.run("save", { steps: [planStep("log_intake", {})], done: "A." }, () => ran.push("a"));
    await t.b.run("save", { steps: [planStep("log_intake", {})], done: "B." }, () => ran.push("b"));
    await t.b.retry("save");
    expect(ran).toEqual(["a", "b", "b"]);
    expect(t.calls[1]!.input.idempotency_key).toBe(t.calls[2]!.input.idempotency_key);
  });

  it("a sign-out calls signedOut and keeps the plan, so Try again after signing in resends the same keys and closes the form", async () => {
    const t = book([{ kind: "signed_out", http: 401 }, ok]);
    let closed = 0;
    const plan = { steps: [planStep("log_intake", {})], done: "Logged." };
    await t.b.run("save", plan, closeOnSaved(() => closed++));
    expect(t.signedOut()).toBe(1);
    expect(closed).toBe(0);
    await t.b.retry("save");
    expect(closed).toBe(1);
    expect(t.calls[0]!.input.idempotency_key).toBe(t.calls[1]!.input.idempotency_key);
  });

  it("counts each attempt as in flight until its answer is in, a Try again included, and the form's after-save runs once the count is back", async () => {
    const r = recorder([fail500, ok]);
    let n = 0;
    const seen: number[] = [];
    const b = writeBook(r.call, {
      status: () => {},
      saved: () => {},
      signedOut: () => {},
      track: async (work) => {
        seen.push(++n);
        try {
          return await work();
        } finally {
          seen.push(--n);
        }
      },
    });
    const atAfter: number[] = [];
    await b.run("save", { steps: [planStep("log_intake", {})], done: "Logged." }, () => atAfter.push(n));
    await b.retry("save");
    expect(seen).toEqual([1, 0, 1, 0]);
    expect(atAfter).toEqual([0, 0]);
  });
});

describe("answering a question with the asked plan's own keys (ticket 63)", () => {
  const gymAsk: Outcome = { kind: "needs_clarification", reason: "gym_needed", question: "Which gym are you at?", options: ["Gym A", "Gym B"], path: ["gym"] };

  it("a share refused as more than the pot says every share the server names, the eaten leftover included (click test P1-7)", () => {
    expect(plainQuestion("portions_exceed_whole", "portions of whole add up to 1.05, more than the whole cook; shares: Hritvik 40%, Asha 35%, leftover eaten by Hritvik 30%. What is right?")).toBe(
      "With the others' shares, that comes to more than the whole pot: Hritvik 40%, Asha 35%, leftover eaten by Hritvik 30%. Enter a smaller share.",
    );
    // An older Worker's words, without the shares: the plain copy as before.
    expect(plainQuestion("portions_exceed_whole", "portions of whole add up to 1.1, more than the whole cook. What is right?")).toBe("With the others' shares, that comes to more than the whole pot. Enter a smaller share.");
  });

  it("a question's status carries its options", async () => {
    const r = recorder([gymAsk]);
    const out = await runPlanResults({ steps: [planStep("log_set", { member: "Asha" })], done: "Set logged." }, r.call);
    expect(out.status).toEqual({ state: "question", message: "Which gym are you at?", reason: "gym_needed", path: ["gym"], options: ["Gym A", "Gym B"] });
  });

  it("answerPlan adds the answer to that tool's step and keeps every key", () => {
    const plan = { steps: [planStep("log_workout", { member: "Asha" }), planStep("create_workout", { name: "X" })], done: "Logged." };
    const answered = answerPlan(plan, "log_workout", ["gym"], "Gym B");
    expect(answered.steps.map((s) => s.input)).toEqual([{ ...plan.steps[0]!.input, gym: "Gym B" }, plan.steps[1]!.input]);
    expect(answered.done).toBe("Logged.");
  });

  it("writeBook.answer resends the asked plan with the answer under the same keys and runs the form's after-save", async () => {
    const r = recorder([gymAsk, ok]);
    const statuses: string[] = [];
    const b = writeBook(r.call, { status: (_k, s) => statuses.push(s.state), saved: () => {}, signedOut: () => {} });
    const plan = { steps: [planStep("log_set", { member: "Asha" })], done: "Set logged." };
    const after: string[] = [];
    await b.run("save", plan, (o) => after.push(o.status.state));
    const out = await b.answer("save", "log_set", ["gym"], "Gym A", { member: "Asha" });
    expect(out?.status.state).toBe("saved");
    expect(r.calls.map((c) => c.input)).toEqual([plan.steps[0]!.input, { ...plan.steps[0]!.input, gym: "Gym A" }]);
    expect(after).toEqual(["question", "saved"]);
    expect(statuses).toEqual(["pending", "question", "pending", "saved"]);
    expect(await b.answer("save", "log_set", ["gym"], "Gym A", { member: "Asha" })).toBeNull();
  });

  it("questionChoices offers the gyms of a gym question, each answering at its path", () => {
    expect(questionChoices({ state: "question", message: "Which gym are you at?", reason: "gym_needed", path: ["gym"], options: ["Gym A", "Gym B"] })).toEqual([
      { label: "Gym A", path: ["gym"], value: "Gym A" },
      { label: "Gym B", path: ["gym"], value: "Gym B" },
    ]);
    expect(questionChoices(null)).toEqual([]);
    expect(questionChoices({ state: "saved", message: "Saved." })).toEqual([]);
  });
});

describe("every question with options is answered in one tap (click test P1-6)", () => {
  const cableAsk: Outcome = {
    kind: "needs_clarification", reason: "implement_needed", question: "Which cable was the Lat Pulldown done on?",
    options: ["Cable A", "Lat pulldown station"], path: ["load", "implement"],
  };

  it("\"Which cable?\" offers its cables, answering at load.implement", async () => {
    const r = recorder([cableAsk]);
    const out = await runPlanResults({ steps: [planStep("log_set", { member: "Asha", load: { value: 40, unit: "kg", basis: "total" } })], done: "Set logged." }, r.call);
    expect(questionChoices(out.status)).toEqual([
      { label: "Cable A", path: ["load", "implement"], value: "Cable A" },
      { label: "Lat pulldown station", path: ["load", "implement"], value: "Lat pulldown station" },
    ]);
  });

  it("answerPlan sets a nested answer inside the asked step, keeping the rest of the load and every key, and copies (never mutates) the plan", () => {
    const plan = { steps: [planStep("log_set", { member: "Asha", load: { value: 40, unit: "kg", basis: "total" } })], done: "Set logged." };
    const before = JSON.stringify(plan);
    const answered = answerPlan(plan, "log_set", ["load", "implement"], "Cable A");
    expect(answered.steps[0]!.input).toEqual({ ...plan.steps[0]!.input, load: { value: 40, unit: "kg", basis: "total", implement: "Cable A" } });
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("answers a set inside log_workout's list by its index", () => {
    const sets = [{ exercise: "Bench", load: { value: 20, unit: "kg" } }, { exercise: "Lat Pulldown", load: { value: 40, unit: "kg" } }];
    const plan = { steps: [planStep("log_workout", { member: "Asha", sets })], done: "Logged." };
    const answered = answerPlan(plan, "log_workout", ["sets", 1, "load", "implement"], "Cable A");
    expect(answered.steps[0]!.input.sets).toEqual([sets[0], { exercise: "Lat Pulldown", load: { value: 40, unit: "kg", implement: "Cable A" } }]);
    expect(Array.isArray(answered.steps[0]!.input.sets)).toBe(true);
  });

  it("an implausible reading is answered \"Yes, it's right\", which resends it with implausible_ok (click test P1-2)", () => {
    expect(questionChoices({ state: "question", message: "700 kg is outside the range a body weight can be (20 to 300 kg). Is it right?", reason: "implausible_reading", path: ["implausible_ok"] })).toEqual([
      { label: "Yes, it's right", path: ["implausible_ok"], value: true },
    ]);
  });

  it("offers chips only for questions whose options are answers at their path (review round)", () => {
    // load_needed's "not_recorded", unit_unclear's "50 kg" and position_past_end's "4" are not values for their paths: plain questions.
    expect(questionChoices({ state: "question", message: "?", reason: "load_needed", path: ["load"], options: ["none", "not_recorded"] })).toEqual([]);
    expect(questionChoices({ state: "question", message: "?", reason: "unit_unclear", path: ["load"], options: ["50 kg", "50 lb"] })).toEqual([]);
    expect(questionChoices({ state: "question", message: "?", reason: "position_past_end", path: ["position"], options: ["4"] })).toEqual([]);
    expect(questionChoices({ state: "question", message: "?", reason: "implement_needed", path: ["load", "implement"], options: ["A", 3, { a: 1 }] })).toEqual([
      { label: "A", path: ["load", "implement"], value: "A" },
      { label: "3", path: ["load", "implement"], value: 3 },
    ]);
    expect(questionChoices({ state: "question", message: "?", reason: "rir_needed", path: ["rir"] })).toEqual([]);
    expect(questionChoices({ state: "question", message: "?", reason: "gym_needed", options: ["a"] })).toEqual([]);
  });
});

describe("a stale answer never sends the old entry (review round, P1 data safety)", () => {
  const ask: Outcome = { kind: "needs_clarification", reason: "implausible_reading", question: "700 kg is outside the range a body weight can be (20 to 300 kg). Is it right?", options: [], path: ["implausible_ok"] };
  const entry = { member: "Asha", date: "2026-10-06", metric: "weight", value: 700, unit: "kg", body_state: "fasted" };

  it("answer with the form's current entry resends only when it is still the entry that was asked about", async () => {
    const r = recorder([ask, ok]);
    const b = writeBook(r.call, { status: () => {}, saved: () => {}, signedOut: () => {} });
    await b.run("save", { steps: [planStep("log_reading", entry)], done: "Logged." });
    expect(b.matches("save", "log_reading", { ...entry, value: 70 })).toBe(false);
    expect(b.matches("save", "log_reading", null)).toBe(false);
    expect(await b.answer("save", "log_reading", ["implausible_ok"], true, { ...entry, value: 70 })).toBeNull();
    expect(await b.answer("save", "log_reading", ["implausible_ok"], true, null)).toBeNull();
    expect(r.calls).toHaveLength(1);
    // Key order and the idempotency key don't matter; the values do.
    const same = { body_state: "fasted", unit: "kg", value: 700, metric: "weight", date: "2026-10-06", member: "Asha" };
    expect(b.matches("save", "log_reading", same)).toBe(true);
    expect((await b.answer("save", "log_reading", ["implausible_ok"], true, same))?.status.state).toBe("saved");
    expect(r.calls[1]!.input).toMatchObject({ value: 700, implausible_ok: true });
  });

  it("sameInput compares nested values, ignoring the idempotency key", () => {
    expect(sameInput({ a: { b: [1, 2] }, idempotency_key: "k1" }, { a: { b: [1, 2] } })).toBe(true);
    expect(sameInput({ a: { b: [1, 2] } }, { a: { b: [2, 1] } })).toBe(false);
    expect(sameInput({ a: 1 }, { a: 1, c: 2 })).toBe(false);
  });
});

describe("a status left behind (click test P2-7)", () => {
  it("clears a question, a refusal or a saved line when the member moves on, never a write going through or one held for Try again", () => {
    expect(clearsOnLeave({ state: "question", message: "More than the whole pot." })).toBe(true);
    expect(clearsOnLeave({ state: "failed", message: "Not saved.", rejected: true })).toBe(true);
    expect(clearsOnLeave({ state: "saved", message: "Changed." })).toBe(true);
    expect(clearsOnLeave({ state: "pending", message: "Saving…" })).toBe(false);
    expect(clearsOnLeave({ state: "failed", message: "Not saved: you're offline." })).toBe(false);
    expect(clearsOnLeave(null)).toBe(false);
  });
});

describe("part of a leftover (click test P2-27)", () => {
  it("is all of it unless a share of the pot is given, from 1% up to what is left", () => {
    expect(leftoverShare("", 0.3)).toEqual({ all: true });
    expect(leftoverShare("15", 0.3)).toEqual({ fraction: 0.15 });
    expect(leftoverShare("30", 0.3)).toEqual({ all: true });
    expect(leftoverShare("45", 0.3)).toEqual({ error: "Give a share from 1% to 30%, or leave it empty for all of it." });
    expect(leftoverShare("x", 0.3)).toEqual({ error: "Give a share from 1% to 30%, or leave it empty for all of it." });
    const plan = leftoverEatenPlan(31, "Kabir", "dinner", 0.15);
    expect(plan.steps[0]?.input).toMatchObject({ component_id: 31, disposition: "eaten", member: "Kabir", meal_slot: "dinner", fraction: 0.15 });
    expect(plan.done).toBe("Marked 15% of the pot eaten by Kabir.");
  });
});
