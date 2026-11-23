import { forgetWordPlan } from "../../catalogue";
import { SmallForm } from "./SmallForm";

/** A record's learned words; Forget asks for a reason (spec review #7). Read-only where the record is (exercises). */
export function WordList({ words, canForget }: { words: readonly { id: number; word: string }[]; canForget: boolean }) {
  return (
    <section className="words" aria-label="Words">
      <h3>Words</h3>
      {words.length === 0 ? <p className="leftnote">No words taught for it yet.</p> : null}
      <ul>
        {words.map((w) => (
          <li key={w.id}>
            <b>{w.word}</b>
            {canForget ? <SmallForm storeKey={`word:${w.id}:forget`} open="Forget" submit="Forget it" fields={[]} empty={{}} plan={(_f, why) => forgetWordPlan(w.id, w.word, why)} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
