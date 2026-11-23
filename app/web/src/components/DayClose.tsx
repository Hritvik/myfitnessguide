import { useEffect, useState } from "react";
import { closeAsk, dayStatusPlan, skippedToSend, unskipPlan, type DayClose as Close, type DayStatus } from "../dayClose";
import type { Writes } from "../hooks";
import { WriteLine } from "./WriteLine";

/** Today's "Close the day" (spec addendum 7 Oct 2026, B), on your own day. */
export function DayClose({ close, member, date, writes, online }: { close: Close; member: string; date: string; writes: Writes; online: boolean }) {
  const said = close.meals.filter((m) => m.skipped).map((m) => m.slot).join(",");
  const [skipped, setSkipped] = useState<string[]>(said ? said.split(",") : []);
  // After a Save the day is re-read: follow what the API now has.
  useEffect(() => setSkipped(said ? said.split(",") : []), [said]);
  const key = `day:${date}`;
  const skipKey = `unskip:${date}`;
  // Closing with meals neither logged nor ticked asks once first (click test P2-11).
  const [asking, setAsking] = useState<{ status: Exclude<DayStatus, "open">; text: string } | null>(null);
  // A held failed plan keeps its keys: Save stays off so a second tap can never mint new ones.
  const disabled = !online || [key, skipKey].some((k) => writes.status(k)?.state === "pending" || writes.canRetry(k));
  const toggle = (slot: string) => {
    setAsking(null);
    // A skip the API holds is cleared now, so the meal stops reading "skipped" (click test P2-10); a new tick waits for the close.
    const unskip = unskipPlan(member, date, close, slot);
    if (unskip) return void writes.run(skipKey, unskip);
    setSkipped((s) => (s.includes(slot) ? s.filter((x) => x !== slot) : [...s, slot]));
  };
  // Built once per tap, filtered at send time: a tick for a meal logged since is dropped (skippedToSend).
  const send = (status: DayStatus) => {
    setAsking(null);
    void writes.run(key, dayStatusPlan(member, date, status, skippedToSend(close, skipped)));
  };
  const run = (status: DayStatus) => {
    const ask = status === "open" ? null : closeAsk(close, skippedToSend(close, skipped));
    if (ask && status !== "open") setAsking({ status, text: ask });
    else send(status);
  };
  return (
    <section className="dayclose" aria-label={close.heading}>
      <h2>{close.heading}</h2>
      <p>{close.text}</p>
      {close.status === "open" ? (
        <>
          {close.meals.length > 0 ? (
            <div className="skips" role="group" aria-label="Meals you skipped">
              {close.meals.map((m) => (
                <button key={m.slot} type="button" className="skip" aria-pressed={skipped.includes(m.slot)} disabled={disabled} onClick={() => toggle(m.slot)}>
                  {m.label} skipped
                </button>
              ))}
            </div>
          ) : null}
          <div className="acts l-cluster">
            <button type="button" className="btn primary" disabled={disabled} onClick={() => run("complete")}>
              Everything is logged
            </button>
            <button type="button" className="btn" disabled={disabled} onClick={() => run("partial")}>
              Some of it isn't logged
            </button>
          </div>
          {asking ? (
            <div className="draftbar" role="group" aria-label="Close the day anyway?">
              <p>{asking.text}</p>
              <div className="acts l-cluster">
                <button type="button" className="btn primary" disabled={disabled} onClick={() => send(asking.status)}>
                  Close anyway
                </button>
                <button type="button" className="btn" onClick={() => setAsking(null)}>
                  Not yet
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className="acts l-cluster">
          <button type="button" className="btn" disabled={disabled} onClick={() => run("open")}>
            Reopen the day
          </button>
        </div>
      )}
      <WriteLine writes={writes} id={key} online={online} />
      {writes.status(skipKey) ? <WriteLine writes={writes} id={skipKey} online={online} /> : null}
    </section>
  );
}
