import { useRef, useState } from "react";
import { callTool } from "../api";
import { useLoad, useOnline, useWrites } from "../hooks";
import { loadHousehold, type Who } from "../load";
import type { HistoryVersion, HouseholdOverview, InboxEntry, RecordRef } from "../types";
import { confirmTickedPlan, goneNote, rejectDraftPlan, settleRefusal, waitingRows, type WaitingRow } from "../waiting";
import { holdsForRetry, type Plan } from "../writes";
import { WriteLine } from "./WriteLine";

const CONFIRM = "confirm-ticked";

/** Waiting on you (desktop spec §4): Household's right column; on the phone, a section after the member list. */
export function WaitingOnYou({ who, overview, date, onChanged }: { who: Who; overview: HouseholdOverview; date: string | null; onChanged: () => void }) {
  const online = useOnline();
  const tz = who.time_zone;
  const inbox = useLoad(() => callTool<{ entries: InboxEntry[]; truncated: boolean }>("inbox_entries", { member: who.member, status: "pending" }), `inbox|${who.member}`);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [settled, setSettled] = useState<{ key: string; text: string; said: string }[]>([]);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const writes = useWrites(onChanged, () => location.reload());
  const entries = inbox.state.kind === "ready" ? inbox.state.data.entries : [];
  const listed = waitingRows(overview, entries, tz);
  const rows = listed.rows.filter((r) => !settled.some((s) => s.key === r.key));

  /** A refused batch: re-read; each row of the plan that left the list says how it settled; the plan's other rows stay ticked. */
  const settle = async (plan: Plan, before: readonly WaitingRow[]) => {
    const fresh = await loadHousehold((t, i) => callTool(t, i), { date });
    if (fresh.kind !== "ok") return;
    const records = (plan.steps[0]?.input.records ?? []) as RecordRef[];
    const out = settleRefusal(records, waitingRows(fresh.data, entries, tz).rows, before);
    if (out.gone.length === 0) return;
    const notes = await Promise.all(
      out.gone.map(async (row) => {
        const h = row.ref ? await callTool<{ versions: HistoryVersion[] }>("history", { table: row.ref.table, id: row.ref.id }) : null;
        return goneNote(row, h?.kind === "ok" ? h.data.versions : null, tz);
      }),
    );
    setSettled((s) => [...s.filter((x) => !notes.some((n) => n.key === x.key)), ...notes]);
    setTicked(out.ticked);
    writes.clear(CONFIRM);
    onChanged();
  };

  // The latest settle, for an after-save that runs on a later "Try again" (it reads this render's inbox entries).
  const settleNow = useRef(settle);
  settleNow.current = settle;

  // The batch's after-save goes with its plan, with the rows it was made from, so "Try again" goes through the same rule with
  // the same keys (decision 74; a quiet re-read on reconnect may already have dropped a row that settled meanwhile; its note
  // still needs the row's words): landed clears the ticks, refused outright settles.
  const send = (plan: Plan, before: readonly WaitingRow[]) =>
    void writes.run(CONFIRM, plan, (out) => {
      if (out.status.state === "saved") return setTicked(new Set());
      if (out.status.state === "failed" && !holdsForRetry(out.status)) void settleNow.current(plan, before);
    });

  const confirm = () => {
    if (writes.canRetry(CONFIRM)) return;
    const plan = confirmTickedPlan(rows, ticked);
    if (plan) send(plan, rows);
  };

  // Closing the reason is the plan's after-save, so a "Try again" that lands closes it too (decision 74).
  const reject = (r: WaitingRow) => {
    if (!r.ref) return;
    const plan = rejectDraftPlan(r.ref, why);
    if ("error" in plan) return setError(plan.error);
    setError(null);
    void writes.run(`reject:${r.key}`, plan, (out) => {
      if (out.status.state !== "saved") return;
      setRejecting((open) => (open === r.key ? null : open));
      setWhy("");
    });
  };

  const busy = !online || writes.busy;
  // While the batch is held, its records are fixed: "Try again" resends exactly them, so the ticks can't change.
  const ticksLocked = busy || writes.canRetry(CONFIRM);
  const tickable = rows.filter((r) => r.tickable);
  const count = tickable.filter((r) => ticked.has(r.key)).length;
  const toggle = (key: string) =>
    setTicked((t) => {
      const next = new Set(t);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <section className="waiting-you" aria-label="Waiting on you">
      <header>
        <h2>Waiting on you</h2>
        {tickable.length > 1 ? (
          <label className="tick-all">
            <input type="checkbox" checked={count === tickable.length} disabled={ticksLocked} onChange={() => setTicked(count === tickable.length ? new Set() : new Set(tickable.map((r) => r.key)))} /> All
          </label>
        ) : null}
      </header>
      {rows.length === 0 && settled.length === 0 ? <p className="leftnote">Nothing is waiting on you.</p> : null}
      <ul className="waiting-rows">
        {rows.map((r) => (
          <li key={r.key} className="waiting-row">
            {r.tickable ? (
              <label>
                <input type="checkbox" data-row checked={ticked.has(r.key)} disabled={ticksLocked} onChange={() => toggle(r.key)} /> <span>{r.text}</span>
              </label>
            ) : (
              <span data-row tabIndex={-1}>
                {r.text}
              </span>
            )}
            <p className="leftnote">{r.note}</p>
            {r.ref && rejecting === r.key ? (
              <div className="acts l-cluster">
                <label className="field wide">
                  <span>Why isn't it yours?</span>
                  <input value={why} onChange={(e) => setWhy(e.target.value)} />
                </label>
                {error ? <p className="error-text" role="alert">{error}</p> : null}
                <button type="button" className="btn primary" disabled={busy || writes.canRetry(`reject:${r.key}`)} onClick={() => reject(r)}>
                  Remove it
                </button>
                <button type="button" className="btn" onClick={() => setRejecting(null)}>
                  Keep it
                </button>
              </div>
            ) : r.ref ? (
              <button type="button" className="btn" disabled={busy} onClick={() => (setRejecting(r.key), setWhy(""), setError(null))}>
                Not mine…
              </button>
            ) : null}
            {r.ref ? <WriteLine writes={writes} id={`reject:${r.key}`} online={online} /> : null}
          </li>
        ))}
        {settled.map((s) => (
          <li key={`settled:${s.key}`} className="waiting-row settled">
            <span>{s.text}</span>
            <p role="status">{s.said}</p>
          </li>
        ))}
      </ul>
      {listed.more ? <p className="leftnote">{listed.more}</p> : null}
      {tickable.length > 0 ? (
        <div className="acts l-cluster">
          <button type="button" className="btn primary" disabled={busy || count === 0 || writes.canRetry(CONFIRM)} onClick={confirm}>
            {count === 0 ? "Confirm" : `Confirm ${count}`}
          </button>
        </div>
      ) : null}
      <WriteLine writes={writes} id={CONFIRM} online={online} />
    </section>
  );
}
