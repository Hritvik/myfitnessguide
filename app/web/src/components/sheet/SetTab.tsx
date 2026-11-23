import { useEffect, useState } from "react";
import { Text } from "../layout/Text";
import { callTool } from "../../api";
import { useDebounced, useLoad, useWrites } from "../../hooks";
import { newBuild } from "../../plateBuilder";
import { cardioPlan, draftForExercise, exerciseChoices, LOAD_CHIPS, setFeedback, setInput, setPlan, type Basis, type CardioDraft, type LoadDraft, type SetDraft } from "../../setEntry";
import type { CatalogueHit, Inventory, NextForEntry, PreviewSet, RecentItems } from "../../types";
import { asked, closeOnSaved, QuestionAnswer, KEEP_ENTRY, SaveLine, type TabProps } from "../Sheet";
import { PlateBuilder } from "./PlateBuilder";
import { FormError } from "../FormError";
import { setTemplate } from "../../sheet";

const BASES: Basis[] = ["total", "per_side", "per_hand", "per_leg"];

/** A chip's empty load: nothing carried over from another kind. */
function freshLoad(kind: LoadDraft["kind"]): LoadDraft {
  switch (kind) {
    case "value":
      return { kind: "value", value: "", unit: "kg", basis: "total" };
    case "plates":
      return { kind: "plates", build: newBuild() };
    case "none":
      return { kind: "none" };
    case "not_recorded":
      return { kind: "not_recorded" };
  }
}

export function SetTab(props: TabProps) {
  const { state, online, onSaved } = props;
  const [cardio, setCardio] = useState(false);
  // What the cardio form saved: it closes, so the list says it (decision 91).
  const [note, setNote] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 250);
  const recent = useLoad(() => callTool<RecentItems>("recent_items", { member: state.forMember, date: state.date }), `recent|${state.forMember}|${state.date}`);
  const next = useLoad(() => callTool<NextForEntry>("next_prescription", { member: state.forMember, date: state.date }), `next|${state.forMember}|${state.date}`);
  const inv = useLoad(() => callTool<Inventory>("inventory", { member: state.forMember }), `inv|${state.forMember}`);
  const [hits, setHits] = useState<CatalogueHit[] | null>(null);
  useEffect(() => {
    if (!q || !online) return setHits(null);
    let live = true;
    void callTool<{ results: CatalogueHit[] }>("catalogue_search", { query: q, kinds: ["exercise"] }).then((o) => live && o.kind === "ok" && setHits(o.data.results));
    return () => {
      live = false;
    };
  }, [q, online]);
  const nextData = next.state.kind === "ready" ? next.state.data : null;
  const [draft, setDraft] = useState<SetDraft>(() => draftForExercise(state.exercise ?? "", nextData));
  // Opened on a prescription before the next session was read: its load arrives with it, unless the member has started typing.
  useEffect(() => {
    setDraft((d) => (d.exercise && !d.reps && !d.secs && !d.rir && d.load.kind === "value" && !d.load.value ? draftForExercise(d.exercise, nextData) : d));
  }, [nextData]);
  const mode = next.state.kind === "ready" ? next.state.data.programming_mode : "record_only";
  const built = setInput(state.forMember, state.date, draft, mode, setTemplate(state, props.who.today));
  const settled = useDebounced("input" in built ? JSON.stringify(built.input) : "", 400);
  const [feedback, setFeedbackLines] = useState<string[]>([]);
  useEffect(() => {
    if (!settled || !online) return setFeedbackLines([]);
    let live = true;
    void callTool<PreviewSet>("preview_set", JSON.parse(settled)).then((o) => {
      if (live) setFeedbackLines(o.kind === "ok" ? setFeedback(o.data) : o.kind === "needs_clarification" ? [o.question] : []);
    });
    return () => {
      live = false;
    };
  }, [settled, online]);
  const write = useWrites(onSaved, KEEP_ENTRY).slot("save");
  // Another exercise starts a fresh form: nothing typed, asked or answered for the last one stays (click test P2-17).
  const pickExercise = (name: string) => {
    write.clear();
    setFeedbackLines([]);
    setDraft(draftForExercise(name, nextData));
  };

  if (cardio) return <Cardio {...props} onBack={(saved) => { setCardio(false); setNote(saved ?? null); }} />;
  if (!draft.exercise) {
    const choices = exerciseChoices(recent.state.kind === "ready" ? recent.state.data : null, next.state.kind === "ready" ? next.state.data : null, hits);
    return (
      <>
        {note ? <p className="status saved" role="status">{note}</p> : null}
        <label className="field wide"><span>Find an exercise</span><input type="search" value={query} onChange={(e) => { setQuery(e.target.value); setNote(null); }} /></label>
        <ul className="pick-list">
          {choices.map((c) => (
            <li key={c.name}>
              <button type="button" className="pick" onClick={() => pickExercise(c.name)}>
                <Text mode="truncate" reach="title">{c.name}</Text>
                <small>{c.group}</small>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn" onClick={() => setCardio(true)}>Cardio instead</button>
      </>
    );
  }
  const l = draft.load;
  return (
    <div className="amount">
      <button type="button" className="btn" onClick={() => pickExercise("")}>Change exercise</button>
      <h3>{draft.exercise}</h3>
      <div className="chips" role="group" aria-label="Set type">
        {(["working", "warm_up", "back_off"] as const).map((t) => (
          <button key={t} type="button" className="chip" aria-pressed={draft.setType === t} onClick={() => setDraft({ ...draft, setType: t })}>{t.replace(/_/g, " ")}</button>
        ))}
      </div>
      <div className="chips" role="group" aria-label="Load as">
        {LOAD_CHIPS.map((c) => (
          <button key={c.kind} type="button" className="chip" aria-pressed={l.kind === c.kind} onClick={() => l.kind !== c.kind && setDraft({ ...draft, load: freshLoad(c.kind) })}>{c.label}</button>
        ))}
      </div>
      {l.kind === "value" ? (
        <div className="row">
          <input inputMode="decimal" aria-label="Load" value={l.value} onChange={(e) => setDraft({ ...draft, load: { ...l, value: e.target.value } })} />
          <button type="button" className="btn" onClick={() => setDraft({ ...draft, load: { ...l, unit: l.unit === "kg" ? "lb" : "kg" } })}>{l.unit}</button>
          <select aria-label="Basis" value={l.basis} onChange={(e) => setDraft({ ...draft, load: { ...l, basis: e.target.value as Basis } })}>
            {BASES.map((b) => <option key={b} value={b}>{b.replace(/_/g, " ")}</option>)}
          </select>
        </div>
      ) : null}
      {l.kind === "plates" ? (
        <PlateBuilder inv={inv.state.kind === "ready" ? inv.state.data : null} build={l.build} online={online} onRecorded={inv.reload} onChange={(b) => setDraft({ ...draft, load: { kind: "plates", build: b } })} />
      ) : null}
      <div className="chips" role="group" aria-label="Counted in">
        {(["reps", "duration"] as const).map((k) => (
          <button key={k} type="button" className="chip" aria-pressed={(draft.kind ?? "reps") === k} onClick={() => setDraft({ ...draft, kind: k })}>{k === "reps" ? "Reps" : "Seconds"}</button>
        ))}
      </div>
      <div className="row">
        {draft.kind === "duration" ? (
          <label className="field"><span>Seconds</span><input inputMode="numeric" value={draft.secs ?? ""} onChange={(e) => setDraft({ ...draft, secs: e.target.value })} /></label>
        ) : (
          <label className="field"><span>Reps</span><input inputMode="numeric" value={draft.reps} onChange={(e) => setDraft({ ...draft, reps: e.target.value })} /></label>
        )}
        <label className="field"><span>RIR{mode === "prescribed" && draft.setType === "working" && draft.kind !== "duration" ? "" : " (optional)"}</span><input inputMode="numeric" value={draft.rir} onChange={(e) => setDraft({ ...draft, rir: e.target.value })} placeholder="2 or 1-2" /></label>
      </div>
      <div className="preview" aria-live="polite"><FormError text={"error" in built ? built.error : null} />{"error" in built ? null : feedback.filter((f) => !asked(write, f)).map((f) => <p key={f}>{f}</p>)}</div>
      <button type="button" className="btn primary" disabled={"error" in built || write.busy || write.canRetry} onClick={() => {
        if ("input" in built) void write.run(setPlan(built.input), (o) => o.status.state === "saved" && setDraft((d) => ({ ...d, reps: "", secs: "", rir: "" })));
      }}>Save set</button>
      <SaveLine write={write} online={online} />
      <QuestionAnswer write={write} tool="log_set" online={online} current={"input" in built ? built.input : null} onAnswer={(c) => c.path.join(".") === "load.implement" && setDraft((d) => ({ ...d, implement: String(c.value) }))} />
    </div>
  );
}

function Cardio({ state, online, onSaved, onBack }: TabProps & { onBack: (saved?: string) => void }) {
  const [d, setD] = useState<CardioDraft>({ activity: "", minutes: "", km: "", avgHr: "" });
  const write = useWrites(onSaved, KEEP_ENTRY).slot("save");
  const plan = cardioPlan(state.forMember, state.date, d);
  const set = (k: keyof CardioDraft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  return (
    <div className="amount">
      <button type="button" className="btn" onClick={() => onBack()}>Back</button>
      <label className="field"><span>What</span><input value={d.activity} onChange={set("activity")} placeholder="incline walk" /></label>
      <label className="field"><span>Minutes</span><input inputMode="decimal" value={d.minutes} onChange={set("minutes")} /></label>
      <label className="field"><span>Distance (km, optional)</span><input inputMode="decimal" value={d.km} onChange={set("km")} /></label>
      <label className="field"><span>Average heart rate (optional)</span><input inputMode="numeric" value={d.avgHr} onChange={set("avgHr")} /></label>
      <FormError className="preview" text={"error" in plan ? plan.error : null} />
      <button type="button" className="btn primary" disabled={"error" in plan || write.busy || write.canRetry} onClick={() => "steps" in plan && void write.run(plan, closeOnSaved(onBack))}>Save cardio</button>
      <SaveLine write={write} online={online} />
    </div>
  );
}
