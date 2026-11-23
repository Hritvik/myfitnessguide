import { useEffect, useState } from "react";
import { callTool } from "../../api";
import { removeWorkoutLinePlan, addWorkoutLinePlan, workoutLineText, workoutRows } from "../../catalogue";
import type { IdPane } from "../../route";
import { useLoad, useTitle } from "../../hooks";
import type { WorkoutOut } from "../../types";
import { useCatalogueStore } from "../CatalogueStore";
import { Link } from "../Shell";
import { Panes, RecordState, type Go } from "./Panes";
import { SmallForm } from "./SmallForm";

/** Workouts (desktop spec §5): the saved workouts; a workout's lines, each removable, and a line to add, each with a reason. */
export function WorkoutsPane({ view, wide, go }: { view: IdPane; wide: boolean; go: Go }) {
  const store = useCatalogueStore();
  const list = useLoad(() => callTool<{ workouts: WorkoutOut[] }>("workouts", {}), "cat-workouts");
  // Every catalogue write re-reads the workouts once it lands.
  useEffect(() => {
    if (store.saved) list.reload();
    // Only a new catalogue Save re-reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.saved]);
  // A removed line leaves the re-read list, and its own status with it: the confirmation stays here.
  const [removed, setRemoved] = useState<{ workout: number; text: string } | null>(null);
  // It is the last write's news: opening another workout, or adding a line, ends it.
  useEffect(() => setRemoved(null), [view.id]);
  const workouts: WorkoutOut[] = list.state.kind === "ready" ? list.state.data.workouts : [];
  const open = view.id === null ? null : (workouts.find((w) => w.id === view.id) ?? null);
  useTitle(open?.name ?? null);
  const rows = workoutRows(workouts);
  const listNode = (
    <section className="cat-list" aria-label="Workouts">
      {list.state.kind !== "ready" ? <RecordState state={list.state} what="The workouts" retry={list.reload} /> : null}
      {list.state.kind === "ready" && rows.length === 0 ? <p className="leftnote">No saved workouts yet. Save a session as a workout from Train.</p> : null}
      <ul className="cat-rows">
        {rows.map((r) => (
          <li key={r.key}>
            <Link href={r.href} go={go} className="cat-row" current={r.key === `workout:${view.id}`} row>
              <span>{r.label}</span>
              <span className="leftnote">{r.hint}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
  const record =
    view.id === null || list.state.kind !== "ready" ? null : open ? (
      <article className="record" aria-labelledby="record-title">
        <header className="record-head">
          <h2 id="record-title">{open.name}</h2>
        </header>
        {open.note ? <p className="leftnote">{open.note}</p> : null}
        <ol className="workout-lines">
          {open.lines.map((l) => (
            <li key={l.id}>
              <div className="workout-line">
                <span>{workoutLineText(l)}</span>
                {open.lines.length > 1 ? (
                  <SmallForm
                    storeKey={`wline:${l.id}:remove`}
                    open="Remove"
                    submit="Remove it"
                    fields={[]}
                    empty={{}}
                    plan={(_f, why) => removeWorkoutLinePlan(l.id, l.exercise, why)}
                    onSaved={() => setRemoved({ workout: open.id, text: `Removed ${l.exercise}.` })}
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        {removed && removed.workout === open.id ? (
          <p className="status saved" role="status">
            {removed.text}
          </p>
        ) : null}
        {open.lines.length === 1 ? <p className="leftnote">A workout keeps at least one line.</p> : null}
        <div className="record-acts">
          <SmallForm
            storeKey={`workout:${open.id}:line`}
            open="Add a line"
            edit
            fields={[{ key: "exercise", label: "Exercise" }, { key: "sets", label: "Sets", numeric: true }, { key: "low", label: "Reps from", numeric: true }, { key: "high", label: "Reps to", numeric: true }]}
            empty={{ exercise: "", sets: "", low: "", high: "" }}
            plan={(f, why) => addWorkoutLinePlan(open.id, { exercise: f.exercise ?? "", sets: f.sets ?? "", low: f.low ?? "", high: f.high ?? "" }, why)}
            onSaved={() => setRemoved(null)}
          />
        </div>
      </article>
    ) : (
      <p className="leftnote">There is no workout at this link. Pick one from the list.</p>
    );
  return <Panes wide={wide} pane="workouts" go={go} back="Workouts" list={listNode} record={record} />;
}
