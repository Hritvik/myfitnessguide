import { callTool } from "../../api";
import { exerciseRows, implementWord, lastDoneText, wordsFor } from "../../catalogue";
import { useLoad, useTitle } from "../../hooks";
import type { Who } from "../../load";
import type { IdPane } from "../../route";
import type { CatalogueListExercise, LastTrained, Learned } from "../../types";
import { Link } from "../Shell";
import { Panes, RecordState, type Go } from "./Panes";
import { usePaged } from "./usePaged";
import { WordList } from "./WordList";

/** Exercises (desktop spec §5), read-only: creating one waits for ticket 38. */
export function ExercisesPane({ who, view, wide, go }: { who: Who; view: IdPane; wide: boolean; go: Go }) {
  const paged = usePaged<CatalogueListExercise>("exercise", exerciseRows);
  const items = paged.state.kind === "ready" ? paged.state.data.items : [];
  const open = view.id === null ? null : (items.find((e) => e.id === view.id) ?? null);
  useTitle(open?.name ?? null);
  const listNode = (
    <section className="cat-list" aria-label="Exercises">
      {paged.state.kind !== "ready" ? <RecordState state={paged.state} what="The exercises" retry={paged.reload} /> : null}
      {paged.state.kind === "ready" && paged.rows.length === 0 ? <p className="leftnote">No exercises yet.</p> : null}
      <ul className="cat-rows">
        {paged.rows.map((r) => (
          <li key={r.key}>
            <Link href={r.href} go={go} className="cat-row" current={r.key === `exercise:${view.id}`} row>
              <span>{r.label}</span>
              <span className="leftnote">{r.hint}</span>
            </Link>
          </li>
        ))}
      </ul>
      {paged.next !== null ? (
        <button type="button" className="btn" disabled={paged.status === "loading"} onClick={() => void paged.loadMore()}>
          {paged.status === "error" ? "Try showing more again" : "Show more"}
        </button>
      ) : null}
    </section>
  );
  const record = view.id === null || paged.state.kind !== "ready" ? null : open ? <ExerciseRecord who={who} exercise={open} /> : <p className="leftnote">There is no exercise at this link. Pick one from the list.</p>;
  return <Panes wide={wide} pane="exercises" go={go} back="Exercises" list={listNode} record={record} />;
}

function ExerciseRecord({ who, exercise }: { who: Who; exercise: CatalogueListExercise }) {
  const last = useLoad(() => callTool<LastTrained>("last_trained", { member: who.member, exercise: exercise.name }), `cat-last|${who.member}|${exercise.id}`);
  const learned = useLoad(() => callTool<Learned>("learned", {}), "learned");
  return (
    <article className="record" aria-labelledby="record-title">
      <header className="record-head">
        <h2 id="record-title">{exercise.name}</h2>
      </header>
      <p className="leftnote">{implementWord(exercise.implement_kind)}</p>
      <p>{last.state.kind === "ready" ? lastDoneText(last.state.data) : null}</p>
      <WordList words={learned.state.kind === "ready" ? wordsFor(learned.state.data.aliases, "exercise", exercise.id) : []} canForget={false} />
      <p className="leftnote">Exercises are read-only here. A new exercise comes from Claude, in chat.</p>
    </article>
  );
}
