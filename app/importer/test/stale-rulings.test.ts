// A decision applies only to the row it was decided on. Each decided ruling
// carries a hash of the cells it records (`decided_on`); when the row has
// changed since, the ruling is raised again as pending, with the old decision
// shown beside the new row. Invented values only.
import { describe, expect, it } from "vitest";
import { rehearse } from "../src/rehearse";
import { MECHANICAL_DECIDER, readRulings, rowHash, RulingBook, writeRulings, type Ruling } from "../src/rulings";
import { basePeople, members, PROGRAM_HEADER, snapshot } from "./fixture";

const origin = { file: "hritvik", tab: "Program", row: 5 };
const OLD_ROW = { C: "Cable Curl", M: "Add 2.5 kg when 3x12" };
const NEW_ROW = { C: "Cable Curl", M: "Add 5 kg when 3x12; nothing lighter fits this pulley" };

function decided(over: Partial<Ruling> = {}): Ruling {
  return {
    id: "hritvik/Program!5/progression_rule", origin, code: "progression_rule", kind: "semantic", cause: null,
    problem: "", proposed_fix: "", proposal: { kind: "manual" }, decision: "accepted", decided_by: "Tester",
    override: { kind: "rep_top", target_sets: 3, rep_top: 12, rir_floor: 1 }, day: null, row: OLD_ROW, note: "decided on the old text", ...over,
  };
}

const raise = (book: RulingBook, row: Record<string, string>, kind: "semantic" | "mechanical" = "semantic") =>
  book.raise<Record<string, unknown>>({ origin, code: "progression_rule", kind, problem: "p", proposed_fix: "f", proposal: { kind: "manual" }, row });

describe("stale decisions", () => {
  it("re-applies a decision whose row is unchanged and stamps it with the row's hash", () => {
    const r = raise(new RulingBook([decided()]), OLD_ROW);
    expect(r.ruling).toMatchObject({ decision: "accepted", decided_by: "Tester", decided_on: rowHash(OLD_ROW), previous_decision: null });
    expect(r.value).toEqual({ kind: "rep_top", target_sets: 3, rep_top: 12, rir_floor: 1 });
  });

  it("raises a decision whose row changed as pending, showing the old decision and the new row, and applies only the proposal", () => {
    const r = raise(new RulingBook([decided()]), NEW_ROW);
    expect(r.ruling).toMatchObject({
      decision: "pending", decided_by: null, override: null, decided_on: null, note: null, row: NEW_ROW,
      previous_decision: { decision: "accepted", decided_by: "Tester", override: { kind: "rep_top", target_sets: 3, rep_top: 12, rir_floor: 1 }, note: "decided on the old text", row: OLD_ROW },
    });
    expect(r.value).toEqual({ kind: "manual" });
  });

  it("compares a stored hash rather than the stored row when there is one", () => {
    const fresh = raise(new RulingBook([decided({ row: { stale: "copy" }, decided_on: rowHash(NEW_ROW) })]), NEW_ROW);
    expect(fresh.ruling.decision).toBe("accepted");
    const stale = raise(new RulingBook([decided({ row: NEW_ROW, decided_on: rowHash(OLD_ROW) })]), NEW_ROW);
    expect(stale.ruling.decision).toBe("pending");
  });

  it("trusts a decision that recorded no row (a hand-written ruling) and stamps the current hash", () => {
    const r = raise(new RulingBook([decided({ row: {} })]), NEW_ROW);
    expect(r.ruling).toMatchObject({ decision: "accepted", decided_on: rowHash(NEW_ROW), previous_decision: null });
  });

  it("re-decides an importer-decided mechanical ruling on a changed row without asking", () => {
    const r = raise(new RulingBook([decided({ kind: "mechanical", decided_by: MECHANICAL_DECIDER, override: null })]), NEW_ROW, "mechanical");
    expect(r.ruling).toMatchObject({ decision: "accepted", decided_by: MECHANICAL_DECIDER, decided_on: rowHash(NEW_ROW), previous_decision: null });
  });

  it("keeps the old decision on a stale ruling across runs until it is decided again, then applies the new decision", () => {
    const first = new RulingBook([decided()]);
    raise(first, NEW_ROW);
    const reread = readRulings(writeRulings("snap.json", first.all()));
    const second = raise(new RulingBook(reread), NEW_ROW);
    expect(second.ruling).toMatchObject({ decision: "pending", previous_decision: { decision: "accepted", row: OLD_ROW } });

    // Decided again by editing the file: decision and override, nothing else.
    const edited = readRulings(writeRulings("snap.json", [{ ...second.ruling, decision: "accepted", decided_by: "Tester", override: { kind: "manual", cue: "Five at a time." } }]));
    const third = raise(new RulingBook(edited), NEW_ROW);
    expect(third.ruling).toMatchObject({ decision: "accepted", decided_on: rowHash(NEW_ROW), previous_decision: null });
    expect(third.value).toEqual({ kind: "manual", cue: "Five at a time." });
  });

  it("hashes cells independently of key order", () => {
    expect(rowHash({ C: "a", M: 1 })).toBe(rowHash({ M: 1, C: "a" }));
    expect(rowHash({ C: "a", M: 1 })).not.toBe(rowHash({ C: "a", M: "1" }));
  });
});

describe("stale decisions in a rehearsal", () => {
  const program = (rule: string) => [
    PROGRAM_HEADER,
    ["Upper A", 1, "Bench Press", "Press", 3, "8-10", 1, "90s", 40, "kg", "total", "", "Add 2.5 kg when 3x10", "", "", ""],
    ["Upper A", 2, "Cable Curl", "Arms", 3, "10-12", 1, "60s", 20, "kg", "total", "", rule, "", "", ""],
  ];
  const prior: Ruling = {
    ...decided(), id: "hritvik/Program!3/progression_rule", origin: { file: "hritvik", tab: "Program", row: 3 },
    row: { C: "Cable Curl", M: "Add 2.5 kg when 3x12" }, override: { kind: "manual", cue: "Old cue." },
  };
  const ruleOf = (r: Awaited<ReturnType<typeof rehearse>>) =>
    JSON.parse(r.db.get<{ rule: string }>("SELECT progression_rule AS rule FROM v_prescription WHERE exercise_name = 'Cable Curl'")?.rule as string);

  it("applies the decision on the unchanged row, and only the proposal once the rule's text has changed", async () => {
    const same = await rehearse({ snapshot: snapshot({ base: { People: basePeople() }, hritvik: { Program: program("Add 2.5 kg when 3x12") } } as never), members: members(), previousRulings: [prior] });
    expect(ruleOf(same)).toEqual({ kind: "manual", cue: "Old cue." });
    expect(same.rulings.find((x) => x.id === prior.id)).toMatchObject({ decision: "accepted", previous_decision: null });

    const changed = await rehearse({ snapshot: snapshot({ base: { People: basePeople() }, hritvik: { Program: program("Add 5 kg when 3x12") } } as never), members: members(), previousRulings: [prior] });
    expect(ruleOf(changed)).toEqual({ kind: "rep_top", target_sets: 3, rep_top: 12, rir_floor: 1 });
    expect(changed.rulings.find((x) => x.id === prior.id)).toMatchObject({ decision: "pending", previous_decision: { override: { kind: "manual", cue: "Old cue." } } });
    // The stale decision counts as pending: the gate cannot pass on it.
    expect(changed.parity.summary.pending_rulings).toBe(same.parity.summary.pending_rulings + 1);
  });
});
