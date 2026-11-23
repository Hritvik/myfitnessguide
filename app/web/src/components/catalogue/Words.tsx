import { useEffect } from "react";
import { callTool } from "../../api";
import { forgetWordPlan } from "../../catalogue";
import { useLoad } from "../../hooks";
import { buildLearned } from "../../learned";
import type { Learned } from "../../types";
import { useCatalogueStore } from "../CatalogueStore";
import { Panes, RecordState, type Go } from "./Panes";
import { SmallForm } from "./SmallForm";

/** Words I've learned (desktop spec §5): every word, what it means, who taught it and when; Forget with a reason; the router's weekly share. */
export function WordsPane({ wide, go }: { wide: boolean; go: Go }) {
  const store = useCatalogueStore();
  const data = useLoad(() => callTool<Learned>("learned", {}), "learned");
  useEffect(() => {
    if (store.saved) data.reload();
    // Only a new catalogue Save re-reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.saved]);
  const view = data.state.kind === "ready" ? buildLearned(data.state.data) : null;
  const words = (
    <section className="cat-list words-screen" aria-label="Words I've learned">
      <h2>Words I've learned</h2>
      {data.state.kind !== "ready" ? <RecordState state={data.state} what="The words" retry={data.reload} /> : null}
      {view && view.words.length === 0 ? <p className="leftnote">No words taught yet.</p> : null}
      {view && view.words.length > 0 ? (
        <table className="wide-table">
          <thead>
            <tr>
              <th scope="col">Word</th>
              <th scope="col">Means</th>
              <th scope="col">Taught</th>
              <th scope="col">
                <span className="visually-hidden">Forget</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {view.words.map((w) => (
              <tr key={w.id}>
                <th scope="row" data-row tabIndex={0}>
                  {w.word}
                </th>
                <td>
                  {w.means} <span className="leftnote">({w.kind})</span>
                </td>
                <td className="leftnote">
                  {w.by}, {w.when}
                </td>
                <td>
                  <SmallForm storeKey={`word:${w.id}:forget`} open="Forget" submit="Forget it" fields={[]} empty={{}} plan={(_f, why) => forgetWordPlan(w.id, w.word, why)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
  const measure = view ? (
    <section className="cat-list" aria-label="Saved without Claude">
      <h2>Saved without Claude</h2>
      {view.measure.length > 0 ? view.measure.map((m) => <p key={m}>{m}</p>) : <p className="leftnote">Nothing typed in free text yet.</p>}
    </section>
  ) : null;
  // Words has no record: on a wide screen the router's share takes the right column.
  // On the phone the measure shows under the list.
  return <Panes wide={wide} pane="words" go={go} back="Words I've learned" list={wide ? words : <>{words}{measure}</>} record={wide ? measure : null} />;
}
