import { useEffect, useState } from "react";
import { callTool } from "../../api";
import { day } from "../../format";
import { useLoad, useWrites } from "../../hooks";
import { countNote, sendInput, sendPlan, WAITING_INPUT, waitingAbout } from "../../freetext";
import type { InboxEntry } from "../../types";
import { KEEP_ENTRY, SaveLine, type TabProps } from "../Sheet";
import { FormError } from "../FormError";

/** The sheet's "Tell Claude" tab: free words go whole to the inbox; Claude logs them later. */
export function TextTab({ state, online, onSaved, draft: text, setDraft: setText, holdSend }: TabProps) {
  const [refused, setRefused] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const writes = useWrites(onSaved, KEEP_ENTRY);
  const send = writes.slot("send");
  // Your texts naming nobody (the Worker refuses naming another member; decision 110), then those about the member the sheet is for.
  const waiting = useLoad(() => callTool<{ entries: InboxEntry[] }>("inbox_entries", { ...WAITING_INPUT }), `inbox|${sent}`);
  const waitingHere = waiting.state.kind === "ready" ? waitingAbout(waiting.state.data.entries, state.forMember) : [];

  // A failed send is held for "Try again" with its own key; nothing new starts until it lands or the member changes.
  const held = send.canRetry;
  const locked = send.busy || held;

  // While a send is held the sheet keeps the member, day and meal (and this tab) as they are, so a resend is the same write.
  useEffect(() => {
    holdSend(locked);
    return () => holdSend(false);
  }, [locked]);

  // Clearing the box is the plan's after-save, so a "Try again" that lands clears it too (decision 74).
  const tap = () => {
    const made = sendInput(state.forMember, state.date, state.slot, text);
    if ("error" in made) return setRefused(made.error);
    setRefused(null);
    void send.run(sendPlan(made.input), (o) => {
      if (o.status.state === "saved") {
        setText("");
        setSent((k) => k + 1);
      }
    });
  };

  return (
    <div className="amount tell-claude">
      <label className="field wide">
        <span>Say what you had or did, the way you'd say it. Claude will log it.</span>
        <textarea rows={4} value={text} readOnly={locked} onChange={(e) => {
          setText(e.target.value);
          setRefused(null);
          if (send.status?.state === "saved" || send.status?.state === "failed") send.clear();
        }} />
      </label>
      <button type="button" className="btn primary" disabled={locked || text.trim() === ""} onClick={tap}>Send to Claude</button>
      {countNote(text) ? <small className="hint">{countNote(text)}</small> : null}
      <FormError className="status failed" text={refused} />
      <SaveLine write={send} online={online} />
      {waitingHere.length > 0 ? (
        <section className="pick-group">
          <h3>Waiting for Claude</h3>
          <ul className="pick-list">
            {waitingHere.map((e) => <li key={e.id} className="waiting">{e.spans.map((s) => `"${s.text}"`).join(", ")} <small>({day(e.date)})</small></li>)}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
