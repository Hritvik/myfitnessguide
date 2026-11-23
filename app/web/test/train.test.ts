import { describe, expect, it } from "vitest";
import { buildHistory, buildTrain, editCardioPlan, emptyHistory, historyStep, questionKey, removeCardioPlan, selectedSession, sessionList, setTarget, type HistoryCard, type TrainData } from "../src/train";
import type { Prescription, SessionsList } from "../src/types";

function row(over: Partial<Prescription> = {}): Prescription {
  return {
    prescription_id: 1, position: 1, exercise: "Cable row", sets: 3, target: { kind: "reps", low: 10, high: 12 }, rir_target: { low: 1, high: 2 },
    load: { value: 40, unit: "kg", basis: "total", bar: null, plates: null, implement: "Row stack", unverified: false },
    cue: "Chest up. Pull to the navel.", fallback_note: "Seated row machine if the cable is taken.", fallbacks: ["Machine row"],
    state: { kind: "ready", next_load: { value: 45, unit: "kg", plates: null } },
    ...over,
  };
}

function data(over: Partial<TrainData> = {}): TrainData {
  return {
    own: true, viewing: "Asha",
    next: { programming_mode: "prescribed", session: "Upper A", date: "2026-10-12", layoff_policy: "normal", gaps: [], prescriptions: [row()] },
    gaps: null,
    history: null,
    ...over,
  };
}

describe("Train: Log a set on the session's card (click test P2-16)", () => {
  it("sends a later session's template, so the set starts that session today", () => {
    const view = buildTrain(data());
    expect(setTarget(view, "Cable row", "Asha", "2026-10-08")).toEqual({ tab: "set", exercise: "Cable row", member: "Asha", template: "Upper A" });
  });

  it("sends none for today's session, or a view with no session", () => {
    expect(setTarget(buildTrain(data()), "Cable row", "Asha", "2026-10-12")).toEqual({ tab: "set", exercise: "Cable row", member: "Asha" });
    const empty = buildTrain(data({ next: { programming_mode: "prescribed", session: null, date: null, layoff_policy: "normal", gaps: [], prescriptions: [] } as never }));
    expect(setTarget(empty, "Cable row", "Asha", "2026-10-08")).toEqual({ tab: "set", exercise: "Cable row", member: "Asha" });
  });
});

describe("Train: next session", () => {
  it("heads with the session and day, and shows the layoff policy only when it isn't normal", () => {
    expect(buildTrain(data())).toMatchObject({ kind: "prescribed", title: "Upper A, Mon 12 Oct", policy: null });
    expect(buildTrain(data({ next: { ...data().next, layoff_policy: "hold" } })).policy).toBe("Hold the loads: it has been a while since this session.");
    expect(buildTrain(data({ next: { ...data().next, layoff_policy: "back_off" } })).policy).toBe("Back off the loads after the layoff.");
  });

  it("lists never-performed prescriptions first", () => {
    const view = buildTrain(data({ next: { ...data().next, gaps: [{ prescription_id: 9, exercise: "Hack squat", template: "Lower A" }] } }));
    expect(view.gaps).toEqual(["Not done yet: Hack squat (Lower A)"]);
  });

  it("gives each row its dose, its load, its chip and its cue with the fallback behind it", () => {
    const [r] = buildTrain(data()).rows;
    expect(r).toMatchObject({
      exercise: "Cable row", dose: "3 × 10–12 @ RIR 1–2", load: { kind: "value", text: "40 kg" },
      chip: { kind: "ready", text: "Ready → 45 kg" }, cue: "Chest up. Pull to the navel.", fallback: "Seated row machine if the cable is taken. Or: Machine row.",
    });
  });

  it("shows coach notes only on your own Train: another member's view has no cue and no fallback note, only the fallback exercises' names (the notes cite BMR and BIA)", () => {
    const theirs = buildTrain(data({ own: false, viewing: "Ravi" })).rows[0];
    expect(theirs).toMatchObject({ exercise: "Cable row", dose: "3 × 10–12 @ RIR 1–2", cue: null, fallback: "Or: Machine row." });
    expect(JSON.stringify(theirs)).not.toContain("navel");
    expect(JSON.stringify(theirs)).not.toContain("Seated row machine");
    expect(buildTrain(data({ own: true })).rows[0]).toMatchObject({ cue: "Chest up. Pull to the navel.", fallback: "Seated row machine if the cable is taken. Or: Machine row." });
    expect(buildTrain(data({ own: false, next: { ...data().next, prescriptions: [row({ fallbacks: [] })] } })).rows[0]).toMatchObject({ cue: null, fallback: null });
  });

  it("draws a composition as plates", () => {
    const [r] = buildTrain(data({ next: { ...data().next, prescriptions: [row({ load: { value: 12.27, unit: "kg", basis: "per_side", bar: { value: 20, unit: "kg" }, plates: [{ value: 10, unit: "kg", count: 1 }, { value: 5, unit: "lb", count: 1 }], implement: "Olympic bar", unverified: false } })] } })).rows;
    expect(r?.load).toMatchObject({ kind: "plates", layout: { bar: "20 kg bar", text: "20 kg bar + 10 kg + 5 lb a side" } });
  });

  it("words every chip, with the sets to confirm and the gym question as actions on your own view", () => {
    const offer = { if_exists: { tool: "add_implement_load", implement_id: 4, loads: [{ value: 45, unit: "kg" as const }] }, if_not: { tool: "remove_implement_load", implement_id: 4, loads: [{ value: 45, unit: "kg" as const }] } };
    const rows = buildTrain(data({ next: { ...data().next, prescriptions: [
      row({ prescription_id: 1, state: { kind: "needs_confirmation", set_ids: [7, 8], next_load: { value: 45, unit: "kg", plates: null } } }),
      row({ prescription_id: 2, state: { kind: "check_at_gym", question: "Is there a 45 kg on the Row stack?", next_load: { value: 45, unit: "kg", plates: null }, offer } }),
      row({ prescription_id: 3, state: { kind: "holding", reason: "a set was ground out" } }),
      row({ prescription_id: 4, state: { kind: "cant_move", reason: "the 1 kg step isn't on the rack" } }),
    ] } })).rows;
    expect(rows.map((r) => r.chip.text)).toEqual([
      "Needs confirmation (2 sets)", "Check at the gym (Is there a 45 kg on the Row stack?)", "Holding (a set was ground out)", "Can't move (the 1 kg step isn't on the rack)",
    ]);
    // The API's own aside goes, so a reason never nests brackets (click test P2-18).
    const manual = buildTrain(data({ next: { ...data().next, prescriptions: [row({ state: { kind: "cant_move", reason: "the load moves only by hand (manual rule)" } })] } })).rows;
    expect(manual[0]?.chip.text).toBe("Can't move (the load moves only by hand)");
    expect(rows[0]?.confirm).toEqual({ setIds: [7, 8] });
    expect(rows[1]?.check).toEqual({ offer });
    const theirs = buildTrain(data({ own: false, next: { ...data().next, prescriptions: [row({ state: { kind: "needs_confirmation", set_ids: [7], next_load: null } })] } })).rows;
    expect(theirs[0]?.confirm).toBeNull();
  });

  it("shows a cardio prescription's duration instead of a load", () => {
    const [r] = buildTrain(data({ next: { ...data().next, prescriptions: [row({ exercise: "Treadmill walk", sets: 1, target: { kind: "duration", low_s: 1200, high_s: 1800 }, rir_target: null, load: null })] } })).rows;
    expect(r).toMatchObject({ dose: "20–30 min", load: null });
  });

  it("reads a timed prescription in seconds unless every bound is whole minutes (ticket 68)", () => {
    const dose = (sets: number, low_s: number | null, high_s: number | null) =>
      buildTrain(data({ next: { ...data().next, prescriptions: [row({ exercise: "Dead hang", sets, target: { kind: "duration", low_s, high_s }, rir_target: null, load: null })] } })).rows[0]?.dose;
    expect(dose(2, 30, 45)).toBe("2 × 30–45 s");
    expect(dose(3, 90, 90)).toBe("3 × 90 s");
    expect(dose(1, 60, 120)).toBe("1–2 min");
    expect(dose(2, null, 40)).toBe("2 × 40 s");
  });

  it("asks at most one inventory question: plates by tapping what is on the rack, anything else in chat", () => {
    const plates = buildTrain(data({ gaps: { gym: "Sample gym", next_session: "Upper A", gaps: [], ask: { kind: "plate_denominations", implement_id: null, implement: null, unit: "kg", unknown: [1.25, 2.5, 25], question: "Which kg plates are on the rack? Not yet confirmed: 1.25, 2.5, 25 kg." } } }));
    expect(plates.question).toEqual({ kind: "plates", unit: "kg", values: [1.25, 2.5, 25], text: "Which of these kg plates are on the rack? Tap the ones you see; the rest are saved as not there." });
    const stack = buildTrain(data({ gaps: { gym: "Sample gym", next_session: "Upper A", gaps: [], ask: { kind: "stack_top", implement_id: 3, implement: "Row stack", question: "Row stack: what's the heaviest it goes to above 40 kg, and is any step missing?" } } }));
    expect(stack.question).toEqual({ kind: "chat", text: "Row stack: what's the heaviest it goes to above 40 kg, and is any step missing? Tell the agent at the gym." });
  });

  it("says a record-only member is programmed by their trainer, and a member with no programme has none", () => {
    expect(buildTrain(data({ viewing: "Kabir", own: false, next: { programming_mode: "record_only", session: null, prescriptions: [], gaps: [] } }))).toMatchObject({
      kind: "record_only", rows: [], message: "Programmed by Kabir's trainer: sessions are recorded here, not prescribed.",
    });
    expect(buildTrain(data({ next: { programming_mode: "prescribed", session: null, prescriptions: [], gaps: [], message: "no active programme" } }))).toMatchObject({
      kind: "empty", rows: [], message: "No programme yet. The agent sets one up from your Guide.",
    });
  });
});

describe("questionKey", () => {
  it("differs between the kg and the lb plate questions, even with the same values", () => {
    expect(questionKey({ kind: "plates", unit: "kg", values: [2.5, 5], text: "" })).not.toBe(questionKey({ kind: "plates", unit: "lb", values: [2.5, 5], text: "" }));
    expect(questionKey({ kind: "chat", text: "x" })).toBe("chat");
  });
});

function list(): SessionsList {
  const set = (over: Partial<SessionsList["sessions"][number]["sets"][number]>) => ({
    id: 1, exercise: "Cable row", set_number: 1, set_type: "working", reps: 10, load_status: "entered" as const, load_value: 45, load_unit: "kg" as const,
    load_basis: "total", bar: null, plates: null, rir: { low: 1, high: 2 }, state: "confirmed" as const, ...over,
  });
  return {
    member: "Asha", from: "2026-08-12", to: "2026-10-06",
    sessions: [
      {
        id: 9, date: "2026-10-05", session_type: "strength", template: "Upper A", gym: "Sample gym", state: "confirmed", working_sets: 2, volume_kg: 900.4,
        records: [{ exercise: "Cable row", e1rm_kg: 60, previous_best_kg: 53.33 }], cardio: null, energy_kcal: null, imported: false,
        sets: [
          set({ id: 1, set_type: "warm_up", reps: 12, load_value: 20, rir: null }),
          set({ id: 2, plates: [{ value: 10, unit: "kg", count: 1 }, { value: 5, unit: "lb", count: 1 }], load_basis: "per_side", bar: { value: 20, unit: "kg" }, load_value: 12.27 }),
          set({ id: 3, load_status: "none", load_value: null, load_unit: null, load_basis: null, exercise: "Push-up", reps: 15, rir: "not_recorded", state: "draft" }),
        ],
      },
      { id: 8, date: "2026-10-04", session_type: "class", template: null, gym: null, state: "confirmed", working_sets: 0, volume_kg: 0, records: [], cardio: { blocks: 2, duration_s: 3000 }, energy_kcal: 280, imported: false, sets: [] },
    ],
  };
}

describe("Train history", () => {
  it("notes a session the import wrote", () => {
    const l = list();
    l.sessions[0] = { ...l.sessions[0]!, imported: true };
    expect(buildHistory(l)[0]?.note).toBe("Imported from Sheets.");
  });

  it("gives each session a card: date, template, sets and volume, records, and every set inside", () => {
    const [gym, dance] = buildHistory(list());
    expect(gym).toEqual({
      id: 9, title: "Mon 5 Oct: Upper A", summary: "2 working sets, 900 kg volume",
      records: ["Best e1RM on Cable row: 60.0 kg (was 53.3 kg)"],
      note: null,
      sets: [
        { id: 1, text: "Cable row, warm-up: 12 × 20 kg, RIR blank", draft: false },
        { id: 2, text: "Cable row: 10 × 20 kg bar + 10 kg + 5 lb a side, RIR 1–2", draft: false },
        { id: 3, text: "Push-up: 15 × bodyweight, RIR not recorded", draft: true },
      ],
    });
    expect(dance).toMatchObject({ title: "Sun 4 Oct: Dance class", summary: "2 blocks, 50 min, 280 kcal", records: [], sets: [] });
  });

  it("gives a gym session with a treadmill block both its sets and its cardio, and Remove takes only the blocks (ticket 68)", () => {
    const l = list();
    l.sessions[0] = { ...l.sessions[0]!, cardio: { blocks: 1, duration_s: 1200, block_ids: [41] } };
    const [gym] = buildHistory(l, true);
    expect(gym).toMatchObject({ summary: "2 working sets, 900 kg volume", cardio: "Cardio: 1 block, 20 min" });
    expect(gym?.cardioFix).toEqual({ remove: [{ table: "cardio_block", id: 41 }], session: null, ask: "Remove 20 min of cardio on Mon 5 Oct?", edit: { id: 41, minutes: "20" } });
    const plan = removeCardioPlan(gym!.cardioFix!.remove, gym!.cardioFix!.session);
    expect(plan.steps.map((s) => s.input.records)).toEqual([[{ table: "cardio_block", id: 41 }]]);
    // A cardio session alone still goes with its blocks.
    const dance = buildHistory({ ...l, sessions: [{ ...l.sessions[1]!, cardio: { blocks: 2, duration_s: 3000, block_ids: [1, 2] } }] }, true)[0];
    expect(dance?.cardioFix?.session).toBe(8);
    expect(dance?.cardio).toBeUndefined();
  });

  it("never words a session's or a set's own note on a card, on another member's Train too (Worker decision 137 keeps them owner-only)", () => {
    const l = list();
    const withText = { ...l, sessions: l.sessions.map((s) => ({ ...s, note: "Post blood-draw session", sets: s.sets.map((x) => ({ ...x, note: "HR 150" })) })) } as SessionsList;
    const view = buildTrain(data({ own: false, viewing: "Ravi", history: withText }));
    expect(view.history).toHaveLength(2);
    expect(JSON.stringify(view.history)).not.toMatch(/blood-draw|HR 150/);
  });

  it("shows a record-only member's history under the trainer line", () => {
    const view = buildTrain(data({ viewing: "Kabir", own: false, next: { programming_mode: "record_only", session: null, prescriptions: [], gaps: [] }, history: list() }));
    expect(view).toMatchObject({ kind: "record_only", message: "Programmed by Kabir's trainer: sessions are recorded here, not prescribed.", historyFrom: "2026-08-12" });
    expect(view.history).toHaveLength(2);
  });

  it("shows no cards and no range when the sessions read failed or the member has none", () => {
    expect(buildTrain(data())).toMatchObject({ history: [], historyFrom: null, historyFailed: true });
    expect(buildTrain(data({ history: { ...list(), sessions: [] } }))).toMatchObject({ history: [], historyFailed: false });
    expect(buildHistory({ ...list(), sessions: [] })).toEqual([]);
  });
});

describe("the wide history's open session", () => {
  const card = (id: number, sets: number): HistoryCard => ({ id, title: `S${id}`, summary: "", records: [], note: null, sets: Array.from({ length: sets }, (_, i) => ({ id: id * 10 + i, text: "x", draft: false })) });
  it("is the newest session with sets, else the newest, and a pick wins", () => {
    expect(selectedSession([card(3, 0), card(2, 4), card(1, 6)], null)?.id).toBe(2);
    expect(selectedSession([card(3, 0), card(2, 0)], null)?.id).toBe(3);
    expect(selectedSession([card(3, 0), card(2, 4)], 3)?.id).toBe(3);
    expect(selectedSession([], null)).toBeNull();
  });
});

describe("editCardioPlan", () => {
  it("amends the block's minutes as seconds", () => {
    expect(editCardioPlan({ id: 9, minutes: "30" }, "45")).toMatchObject({ steps: [{ tool: "amend", input: { record: { table: "cardio_block", id: 9 }, changes: { duration_s: 2700 } } }] });
  });

  it("sends nothing for the same minutes however written, and refuses minutes too few to be a second (ticket 67, property test)", () => {
    expect(editCardioPlan({ id: 9, minutes: "30" }, "30.0")).toEqual({ error: "Nothing changed." });
    expect(editCardioPlan({ id: 9, minutes: "26.67" }, "26.670")).toEqual({ error: "Nothing changed." });
    expect(editCardioPlan({ id: 9, minutes: "30" }, "0.004")).toEqual({ error: "Enter the minutes as a number, at least a second's worth." });
    expect(editCardioPlan({ id: 9, minutes: "30" }, "601")).toEqual({ error: "Enter the minutes, up to 600." });
    expect(editCardioPlan({ id: 9, minutes: "30" }, "0x32")).toEqual({ error: "Enter the minutes as a number, at least a second's worth." });
  });
});

describe("the one session list (wide-layout spec §5, review #4, #5)", () => {
  const card = (id: number, sets = 0): HistoryCard => ({ id, title: `S${id}`, summary: "", records: [], note: null, sets: Array.from({ length: sets }, (_, i) => ({ id: id * 10 + i, text: "x", draft: false })) });

  it("starts empty for a member, and loads, appends, picks and fails for that member", () => {
    const s0 = emptyHistory("Asha");
    expect(s0).toEqual({ member: "Asha", earlier: [], from: null, status: "idle", picked: null, asking: null });
    const s1 = historyStep(s0, { kind: "loading", member: "Asha", before: "2026-08-01" });
    expect(s1).toMatchObject({ status: "loading", asking: "2026-08-01" });
    const s2 = historyStep(s1, { kind: "loaded", member: "Asha", before: "2026-08-01", cards: [card(9), card(8)], from: "2026-06-01" });
    expect(s2).toMatchObject({ status: "idle", from: "2026-06-01", asking: null });
    const s3 = historyStep(historyStep(s2, { kind: "loading", member: "Asha", before: "2026-06-01" }), { kind: "loaded", member: "Asha", before: "2026-06-01", cards: [card(7)], from: "2026-04-06" });
    expect(s3.earlier.map((c) => c.id)).toEqual([9, 8, 7]);
    expect(historyStep(s3, { kind: "pick", member: "Asha", id: 8 }).picked).toBe(8);
    expect(historyStep(s1, { kind: "failed", member: "Asha", before: "2026-08-01" }).status).toBe("error");
  });

  it("drops what lands for another member, so a switch starts afresh and a late load never crosses", () => {
    const kabir = emptyHistory("Kabir");
    expect(historyStep(kabir, { kind: "loaded", member: "Asha", before: "2026-08-01", cards: [card(9)], from: "2026-06-01" })).toBe(kabir);
    expect(historyStep(kabir, { kind: "pick", member: "Asha", id: 9 })).toBe(kabir);
    const asha = historyStep(emptyHistory("Asha"), { kind: "loading", member: "Asha", before: "2026-08-01" });
    expect(historyStep(asha, { kind: "failed", member: "Kabir", before: "2026-08-01" })).toBe(asha);
  });

  it("drops a stale answer for the same member: Asha, then Kabir, then Asha again, and Asha's first load lands late (ruling 14)", () => {
    const loading = historyStep(emptyHistory("Asha"), { kind: "loading", member: "Asha", before: "2026-08-01" });
    expect(loading.asking).toBe("2026-08-01");
    // The switch to Kabir and back starts Asha afresh: nothing is in flight for the new list.
    const back = emptyHistory("Asha");
    const late = { kind: "loaded" as const, member: "Asha", before: "2026-08-01", cards: [card(9)], from: "2026-06-01" };
    expect(historyStep(back, late)).toBe(back);
    expect(historyStep(back, { kind: "failed", member: "Asha", before: "2026-08-01" })).toBe(back);
    // A new load from the fresh list is answered; the old one, landing after it, is not.
    const again = historyStep(back, { kind: "loading", member: "Asha", before: "2026-07-15" });
    expect(historyStep(again, late)).toBe(again);
    expect(historyStep(again, { ...late, before: "2026-07-15" }).earlier.map((c) => c.id)).toEqual([9]);
  });

  it("lists the page's sessions then the earlier ones, and opens an older session as readily as a shown one", () => {
    const shown = [card(3), card(2, 4)];
    const fresh = sessionList(shown, "2026-08-01", emptyHistory("Asha"));
    expect(fresh.cards.map((c) => c.id)).toEqual([3, 2]);
    expect(fresh.oldest).toBe("2026-08-01");
    expect(fresh.selected?.id).toBe(2);
    const loading = historyStep(emptyHistory("Asha"), { kind: "loading", member: "Asha", before: "2026-08-01" });
    const loaded = historyStep(loading, { kind: "loaded", member: "Asha", before: "2026-08-01", cards: [card(1, 2)], from: "2026-06-01" });
    const list = sessionList(shown, "2026-08-01", loaded);
    expect(list.cards.map((c) => c.id)).toEqual([3, 2, 1]);
    expect(list.oldest).toBe("2026-06-01");
    expect(list.selected?.id).toBe(2);
    expect(sessionList(shown, "2026-08-01", historyStep(loaded, { kind: "pick", member: "Asha", id: 1 })).selected?.id).toBe(1);
    expect(sessionList([], null, emptyHistory("Asha"))).toEqual({ cards: [], oldest: null, selected: null });
  });
});
