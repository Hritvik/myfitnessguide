import { useEffect, useState } from "react";
import { Text } from "../layout/Text";
import { callTool } from "../../api";
import { useDebounced, useLoad, useWrites } from "../../hooks";
import { setFeedback, setInput } from "../../setEntry";
import { afterSave } from "../../meal";
import type { Plan } from "../../writes";
import type { Inventory, LogWorkout, NextForEntry, PreviewSet, WorkoutOut } from "../../types";
import { addRow, asksToKeep, fromNext, fromWorkout, loggedLines, newBlock, offerSaveAsWorkout, removeRow, saveAsWorkoutPlan, swap, workoutChanges, workoutInput, workoutPlan, type Block, type DistUnit, type RowDraft, type Source, type TargetKind } from "../../workout";
import { asked, QuestionAnswer, KEEP_ENTRY, SaveLine, type TabProps } from "../Sheet";
import { PlateBuilder } from "./PlateBuilder";
import { FormError } from "../FormError";

const BASIS_WORDS: Record<string, string> = { per_side: " a side", per_hand: " a hand", per_leg: " a leg" };

export function WorkoutTab(props: TabProps) {
  const { state, online, onSaved } = props;
  const next = useLoad(() => callTool<NextForEntry>("next_prescription", { member: state.forMember, date: state.date }), `next|${state.forMember}|${state.date}`);
  const saved = useLoad(() => callTool<{ workouts: WorkoutOut[] }>("workouts", { member: state.forMember }), `workouts|${state.forMember}`);
  const inv = useLoad(() => callTool<Inventory>("inventory", { member: state.forMember }), `inv|${state.forMember}`);
  const [chosen, setChosen] = useState<{ source: Source; blocks: Block[]; workout: WorkoutOut | null } | null>(null);
  const [asking, setAsking] = useState(false);
  const [newName, setNewName] = useState("");
  const [after, setAfter] = useState<LogWorkout | null>(null);
  // Once log_workout has landed but the workout edits have not, the plan is held: only Try again (same keys) or Back remain.
  const [held, setHeld] = useState<{ plan: Plan; logged: LogWorkout } | null>(null);
  const [adding, setAdding] = useState("");
  const [swapping, setSwapping] = useState<{ key: string; name: string } | null>(null);
  const [focus, setFocus] = useState<{ key: string; id: string } | null>(null);
  const writes = useWrites(onSaved, KEEP_ENTRY);
  const write = writes.slot("workout");
  const keepWrite = writes.slot("keep");
  // RIR is optional until the member's mode is known.
  const mode = next.state.kind === "ready" ? next.state.data.programming_mode : "record_only";
  const [addKind, setAddKind] = useState<TargetKind>("reps");
  // Feedback for the set being edited, from preview_set, debounced (spec §5).
  const focused = chosen && focus ? chosen.blocks.find((b) => b.key === focus.key) : undefined;
  const row = focused && focus ? focused.rows.find((r) => r.id === focus.id) : undefined;
  const one = focused && row && row.kind === "reps" ? setInput(state.forMember, state.date, { exercise: focused.exercise, setType: row.setType, reps: row.reps, rir: row.rir, load: row.load }, mode) : null;
  const settled = useDebounced(one && "input" in one ? JSON.stringify(one.input) : "", 400);
  const [feedback, setFeedbackLines] = useState<string[]>([]);
  useEffect(() => {
    if (!settled || !online) return setFeedbackLines([]);
    let live = true;
    void callTool<PreviewSet>("preview_set", JSON.parse(settled)).then((o) => {
      if (live) setFeedbackLines(o.kind === "ok" ? setFeedback(o.data, { session: false }) : o.kind === "needs_clarification" ? [o.question] : []);
    });
    return () => {
      live = false;
    };
  }, [settled, online]);

  // Opened on a workout (a shortcut to a saved workout): start on it once the saved workouts are read.
  useEffect(() => {
    if (state.workoutId !== null && !chosen && saved.state.kind === "ready") {
      const w = saved.state.data.workouts.find((x) => x.id === state.workoutId);
      if (w) setChosen({ ...fromWorkout(w), workout: w });
    }
  }, [state.workoutId, saved.state, chosen]);

  const finished = after ?? (held && write.status?.state === "saved" ? held.logged : null);
  const back = () => {
    write.clear();
    keepWrite.clear();
    setAfter(null);
    setHeld(null);
    setAsking(false);
    setChosen(null);
    // Back to the list: the workout it was opened on is no longer the one shown.
    if (state.workoutId !== null) props.setState({ ...state, workoutId: null });
  };

  if (held && !finished) {
    return (
      <div className="amount">
        <p>The session is saved. The change to the workout is not.</p>
        <SaveLine write={write} online={online} />
        {write.status?.state === "signed_out" ? <button type="button" className="btn" disabled={!online} onClick={() => void write.run(held.plan)}>Try again</button> : null}
        <button type="button" className="btn" onClick={() => { onSaved(); back(); }}>Back</button>
      </div>
    );
  }

  if (finished) {
    return (
      <div className="amount">
        <h3>Logged</h3>
        {loggedLines(finished, { member: state.forMember, own: state.forMember === props.who.member }).map((l) => <p key={l}>{l}</p>)}
        {offerSaveAsWorkout(finished) ? (
          <div className="keep">
            <p>Save this session as a workout, to log it again in one go?</p>
            <label className="field"><span>Name</span><input value={newName} onChange={(e) => setNewName(e.target.value)} /></label>
            <button type="button" className="btn" disabled={!newName.trim() || keepWrite.busy || keepWrite.canRetry} onClick={() => {
              const plan = saveAsWorkoutPlan(finished.session.id, newName);
              if ("steps" in plan) void keepWrite.run(plan);
            }}>Save as a workout</button>
            <SaveLine write={keepWrite} online={online} />
          </div>
        ) : null}
        <button type="button" className="btn" onClick={back}>Done</button>
      </div>
    );
  }

  if (!chosen) {
    const fromProgramme = next.state.kind === "ready" ? fromNext(next.state.data) : null;
    const workouts = saved.state.kind === "ready" ? saved.state.data.workouts : [];
    return (
      <ul className="pick-list">
        {fromProgramme ? (
          <li><button type="button" className="pick" onClick={() => setChosen({ ...fromProgramme, workout: null })}><Text mode="truncate" reach="title">{`Next: ${(fromProgramme.source as { template: string }).template}`}</Text><small>from the programme</small></button></li>
        ) : null}
        {workouts.map((w) => (
          <li key={w.id}><button type="button" className="pick" onClick={() => setChosen({ ...fromWorkout(w), workout: w })}><Text mode="truncate" reach="title">{w.name}</Text><small>{w.last_used ? `last ${w.last_used}` : "saved workout"}</small></button></li>
        ))}
        <li><button type="button" className="pick" onClick={() => setChosen({ source: { kind: "none" }, blocks: [], workout: null })}><Text mode="truncate" reach="title">Start from nothing</Text></button></li>
      </ul>
    );
  }

  const built = workoutInput(state.forMember, state.date, chosen.source, chosen.blocks, mode);
  const changes = chosen.workout ? workoutChanges(chosen.workout, chosen.blocks) : null;
  const setBlocks = (blocks: Block[]) => setChosen({ ...chosen, blocks });
  const update = (key: string, f: (b: Block) => Block) => setBlocks(chosen.blocks.map((b) => (b.key === key ? f(b) : b)));
  const save = (keep: "once" | "update" | "new") => {
    if (!("input" in built)) return;
    const plan = workoutPlan(built.input, keep, chosen.workout, changes, chosen.blocks, newName);
    if ("error" in plan) return;
    // The plan's after-save: SaveLine's "Try again" runs it too, so a retried Save that lands shows "Logged" (decision 74).
    void write.run(plan, (out) => {
      const logged = out.results[0] as unknown as LogWorkout | undefined;
      if (!logged) return;
      if (out.status.state === "saved") setAfter(logged);
      else if (afterSave(out).hold) setHeld({ plan, logged });
    });
  };

  return (
    <div className="amount">
      <button type="button" className="btn" onClick={back}>Back</button>
      {chosen.blocks.map((b) => (
        <section key={b.key} className="block">
          <header>
            <h3>{b.exercise}{b.substitutes !== null ? " (in place of the plan)" : ""}</h3>
            {b.target ? <small>{b.target}</small> : null}
          </header>
          {b.rows.length > 0 ? (
            <div className="set-row set-cols" aria-hidden="true">
              <span />
              <span>Load</span>
              <span>{b.rows[0]?.kind === "duration" ? "Seconds" : b.rows[0]?.kind === "distance" ? "Distance" : "Reps"}</span>
              <span>{b.rows[0]?.kind === "reps" ? "RIR" : ""}</span>
              <span />
            </div>
          ) : null}
          {b.rows.map((r, i) => {
            const set = (f: (y: RowDraft) => RowDraft) => update(b.key, (x) => ({ ...x, rows: x.rows.map((y) => (y.id === r.id ? f(y) : y)) }));
            return (
            <div key={r.id} className="set-row" onFocus={() => setFocus({ key: b.key, id: r.id })}>
              <span className="set-n">{i + 1}</span>
              {r.load.kind === "value" ? (
                <span className="cell">
                  <input inputMode="decimal" aria-label="Load" value={r.load.value} onChange={(e) => set((y) => (y.load.kind === "value" ? { ...y, load: { ...y.load, value: e.target.value } } : y))} />
                  {/* The basis goes with the unit, so 35 lb a side never reads as 35 lb in all (click test P2-15). */}
                  <span className="unit">{r.load.unit}{BASIS_WORDS[r.load.basis] ?? ""}</span>
                </span>
              ) : r.load.kind === "plates" ? (
                <div className="load-wide">
                  <PlateBuilder inv={inv.state.kind === "ready" ? inv.state.data : null} build={r.load.build} online={online} onRecorded={inv.reload} onChange={(build) => set((y) => ({ ...y, load: { kind: "plates", build } }))} />
                </div>
              ) : (
                <span className="cell unit">{r.load.kind === "none" ? (r.kind === "reps" ? "bodyweight" : "no load") : "not recorded"}</span>
              )}
              {r.kind === "reps" ? (
                <span className="cell">
                  <input inputMode="numeric" aria-label="Reps" placeholder={b.target?.split(" ")[0] ?? "reps"} value={r.reps} onChange={(e) => set((y) => ({ ...y, reps: e.target.value }))} />
                </span>
              ) : r.kind === "duration" ? (
                <span className="cell">
                  <input inputMode="numeric" aria-label="Seconds" placeholder={b.target?.split(" ")[0] ?? "seconds"} value={r.secs} onChange={(e) => set((y) => ({ ...y, secs: e.target.value }))} />
                  <span className="unit">s</span>
                </span>
              ) : (
                <span className="cell">
                  <input inputMode="decimal" aria-label="Distance" placeholder={b.target?.split(" ")[0] ?? "distance"} value={r.dist} onChange={(e) => set((y) => ({ ...y, dist: e.target.value }))} />
                  <select aria-label="Distance unit" value={r.distUnit} onChange={(e) => set((y) => ({ ...y, distUnit: e.target.value as DistUnit }))}>
                    {(["m", "km", "mi"] as const).map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </span>
              )}
              {/* Reps in reserve belongs to counted reps; a timed or measured set isn't asked it (decision 94). */}
              {r.kind === "reps" ? (
                <span className="cell">
                  <input inputMode="numeric" aria-label="RIR" placeholder="RIR" value={r.rir} onChange={(e) => set((y) => ({ ...y, rir: e.target.value }))} />
                </span>
              ) : (
                <span className="cell" />
              )}
              <button type="button" className="btn" aria-label={`Remove set ${i + 1}`} onClick={() => update(b.key, (x) => removeRow(x, i))}>×</button>
              <div className="load-kind chips" role="group" aria-label={`Set ${i + 1}'s load`}>
                <button type="button" className="chip" aria-pressed={r.load.kind === "none"} onClick={() => set((y) => ({ ...y, load: { kind: "none" } }))}>Bodyweight</button>
                <button type="button" className="chip" aria-pressed={r.load.kind === "not_recorded"} onClick={() => set((y) => ({ ...y, load: { kind: "not_recorded" } }))}>Not recorded</button>
                {r.load.kind === "none" || r.load.kind === "not_recorded" ? (
                  <button type="button" className="chip" onClick={() => set((y) => ({ ...y, load: { kind: "value", value: "", unit: "kg", basis: "total" } }))}>Enter a load</button>
                ) : null}
              </div>
              {focus?.key === b.key && focus.id === r.id && feedback.filter((f) => !asked(write, f)).length > 0 ? (
                <div className="preview" aria-live="polite">{feedback.filter((f) => !asked(write, f)).map((f) => <p key={f}>{f}</p>)}</div>
              ) : null}
            </div>
            );
          })}
          {swapping?.key === b.key ? (
            <div className="row">
              <input aria-label="Swap for" placeholder="Exercise in its place" value={swapping.name} onChange={(e) => setSwapping({ key: b.key, name: e.target.value })} />
              <button type="button" className="btn" disabled={!swapping.name.trim()} onClick={() => { update(b.key, (x) => swap(x, swapping.name.trim())); setSwapping(null); }}>Swap</button>
            </div>
          ) : null}
          <div className="row">
            <button type="button" className="btn" onClick={() => update(b.key, addRow)}>Add a set</button>
            <button type="button" className="btn" onClick={() => setSwapping({ key: b.key, name: "" })}>Swap</button>
            <button type="button" className="btn" onClick={() => setBlocks(chosen.blocks.filter((x) => x.key !== b.key))}>Remove exercise</button>
          </div>
        </section>
      ))}
      <div className="row">
        <select aria-label="Counted in" value={addKind} onChange={(e) => setAddKind(e.target.value as TargetKind)}>
          <option value="reps">reps</option>
          <option value="duration">seconds</option>
          <option value="distance">distance</option>
        </select>
        <input aria-label="Add an exercise" placeholder="Add an exercise" value={adding} onChange={(e) => setAdding(e.target.value)} />
        <button type="button" className="btn" disabled={!adding.trim()} onClick={() => { setBlocks([...chosen.blocks, newBlock(adding.trim(), addKind)]); setAdding(""); }}>Add</button>
      </div>
      <FormError className="preview" text={"error" in built ? built.error : null} />
      {asking && asksToKeep(chosen.source, changes) ? (
        <div className="keep" role="group" aria-label="Keep these changes for next time?">
          <p>Keep these changes for next time? Updating the workout changes it for everyone.</p>
          <button type="button" className="btn" disabled={write.busy || write.canRetry} onClick={() => void save("once")}>Just this time</button>
          <button type="button" className="btn" disabled={write.busy || write.canRetry} onClick={() => void save("update")}>Update {chosen.workout?.name} for everyone</button>
          <label className="field"><span>New workout's name</span><input value={newName} onChange={(e) => setNewName(e.target.value)} /></label>
          <button type="button" className="btn" disabled={write.busy || write.canRetry || !newName.trim()} onClick={() => void save("new")}>Save as a new workout</button>
        </div>
      ) : (
        <button type="button" className="btn primary" disabled={"error" in built || write.busy || write.canRetry} onClick={() => (asksToKeep(chosen.source, changes) ? setAsking(true) : void save("once"))}>Save workout</button>
      )}
      <SaveLine write={write} online={online} />
      <QuestionAnswer write={write} tool="log_workout" online={online} current={"input" in built ? built.input : null} />
    </div>
  );
}
