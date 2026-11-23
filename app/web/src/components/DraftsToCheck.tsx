import { useRef, useState } from "react";
import { callTool } from "../api";
import { useLoad, useOnline, useWrites, type WriteResult, type Writes } from "../hooks";
import { draftRows, rejectHealthPlan, settledNote, type DraftRow } from "../healthDrafts";
import type { Who } from "../load";
import type { HealthDrafts, HistoryVersion } from "../types";
import { confirmPlan, type Plan } from "../writes";
import { HistoryLink } from "./HistoryLink";
import { WriteLine } from "./WriteLine";

/** "Drafts to check" on your own Progress (readings) or Health (blood draws); nothing when there is none. */
export function DraftsToCheck({ who, kind, onChanged }: { who: Who; kind: "reading" | "blood_draw"; onChanged: () => void }) {
  const online = useOnline();
  const { state, reload } = useLoad(() => callTool<HealthDrafts>("health_drafts", { member: who.member }), `health-drafts|${who.member}`);
  const writes = useWrites(
    () => {
      reload();
      onChanged();
    },
    () => location.reload(),
  );
  // Each tap's plan, built once: "Try again" resends it with the same keys.
  const plans = useRef(new Map<string, Plan>());
  // Drafts that settled while shown, with what happened: no buttons, no "Try again".
  // `from` is the list it was tapped in: until the re-read lands, that list's row gives way to the note.
  const [settled, setSettled] = useState<(DraftRow & { said: string; from: HealthDrafts | null })[]>([]);
  const decide = async (r: DraftRow, plan: Plan): Promise<WriteResult> => {
    plans.current.set(r.key, plan);
    const out = await writes.run(r.key, plan);
    if (out.status.state === "saved") plans.current.delete(r.key);
    if (out.status.state !== "failed") return out;
    // The hourly auto-confirm may have confirmed it while shown (not_draft, 409), or it was decided
    // elsewhere: its history says which. Still a draft (or no history) means a real failure: a held
    // plan keeps "Try again" with its keys; a rejected one (nothing written) unlocks the buttons.
    const h = await callTool<{ versions: HistoryVersion[] }>("history", { table: r.ref.table, id: r.ref.id });
    const said = h.kind === "ok" ? settledNote(r.ref.table, h.data.versions, who.time_zone) : null;
    if (said === null) return out;
    plans.current.delete(r.key);
    writes.clear(r.key);
    const from = state.kind === "ready" ? state.data : null;
    setSettled((s) => [...s.filter((x) => x.key !== r.key), { ...r, said, from }]);
    reload();
    onChanged();
    return out;
  };
  if (state.kind !== "ready") return null;
  const shown = state.data;
  const gone = (key: string) => settled.some((s) => s.key === key && s.from === shown);
  const rows = draftRows(shown, kind, who.time_zone).filter((r) => !gone(r.key));
  // "Try again" goes through decide too, so a draft that settled before the retry says so instead.
  const lineWrites: Writes = {
    ...writes,
    retry: (key) => {
      const r = rows.find((x) => x.key === key);
      const plan = plans.current.get(key);
      return r && plan ? decide(r, plan) : Promise.resolve(null);
    },
  };
  const done = settled.filter((s) => !rows.some((r) => r.key === s.key));
  if (rows.length === 0 && done.length === 0) return null;
  return (
    <section className="tier" aria-label="Drafts to check">
      <header>
        <h2>Drafts to check</h2>
      </header>
      <ul className="items">
        {rows.map((r) => {
          const disabled = !online || writes.status(r.key)?.state === "pending" || writes.canRetry(r.key);
          return (
            <li key={r.key} className="item draft">
              <span>{r.text}</span>
              <div className="draftbar">
                <p>{r.note}</p>
                <div className="acts l-cluster">
                  <button type="button" className="btn primary" disabled={disabled} onClick={() => void decide(r, confirmPlan([r.ref]))}>
                    Yes, confirm
                  </button>
                  <button type="button" className="btn" disabled={disabled} onClick={() => void decide(r, rejectHealthPlan(r.ref))}>
                    Not mine, remove it
                  </button>
                </div>
                <WriteLine writes={lineWrites} id={r.key} online={online} />
              </div>
            </li>
          );
        })}
        {done.map((s) => (
          <li key={s.key} className="item">
            <span>{s.text}</span>
            <div className="draftbar">
              <p role="status">{s.said}</p>
              <HistoryLink table={s.ref.table} id={s.ref.id} timeZone={who.time_zone} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
