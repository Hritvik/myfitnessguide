import { useState } from "react";
import { callTool } from "../../api";
import { useLoad, useWrites } from "../../hooks";
import { BODY_STATES, fieldLabel, lastLine, metricOptions, readingDraft, readingInput, readingPlan, readingResult, releasesHeld, settle, type ReadingDraft } from "../../reading";
import type { LoggedReading, ReadingMetrics } from "../../types";
import { KEEP_ENTRY, QuestionAnswer, SaveLine, type TabProps } from "../Sheet";

const SIDES = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const;

/** One reading of your own (spec addendum 7 Oct 2026, A); the frame shows why there are no for chips here. */
export function ReadingTab({ who, state, onSaved, online }: TabProps) {
  const metrics = useLoad(() => callTool<ReadingMetrics>("reading_metrics", { member: who.member }), `reading-metrics|${who.member}`);
  const write = useWrites(onSaved, KEEP_ENTRY).slot("save");
  const [draft, setDraft] = useState<ReadingDraft>(() => readingDraft(state.metric, state.bodyState));
  const [error, setError] = useState<string | null>(null);
  const [after, setAfter] = useState<string[]>([]);
  // The input of the last Save sent; while it is held for "Try again", only a different complete entry lets it go.
  const [sent, setSent] = useState<Record<string, unknown> | null>(null);
  if (metrics.state.kind !== "ready") {
    if (metrics.state.kind === "loading") return <p className="state">Loading what you can measure…</p>;
    return (
      <p className="error-text" role="alert">
        What you can measure could not be loaded.{" "}
        <button type="button" className="btn" onClick={metrics.reload}>
          Try again
        </button>
      </p>
    );
  }
  const options = metricOptions(metrics.state.data);
  const metric = options.find((m) => m.code === draft.metric);
  const shown = settle(draft, metric);
  const last = metric ? lastLine(metric) : null;
  const edit = (change: Partial<ReadingDraft>) => {
    setDraft({ ...shown, ...change });
    setError(null);
    setAfter([]);
  };
  // A failed Save is held for "Try again" with the same keys until the form holds a different complete reading.
  const now = readingInput(who.member, state.date, shown, metric);
  // What a Save would send now: a question is answered only while the form still holds the entry it asked about.
  const entryNow = "input" in now ? now.input : null;
  const released = write.canRetry && releasesHeld(sent, now);
  const held = write.canRetry && !released;
  const saveLine = { ...write, canRetry: held };
  const save = () => {
    const out = readingInput(who.member, state.date, shown, metric);
    if ("error" in out) {
      setError(out.error);
      return;
    }
    setSent(out.input);
    // The plan's after-save: a "Try again" that lands shows the reading and empties the value too (decision 74).
    void write.run(readingPlan(out.input), (r) => {
      const answer = r.results[0];
      if (r.status.state === "saved" && answer) {
        setAfter(readingResult(answer as unknown as LoggedReading));
        setDraft({ ...shown, value: "" });
      }
    });
  };
  return (
    <>
      <label className="field wide">
        <span>What you measured</span>
        <select
          value={draft.metric ?? ""}
          onChange={(e) => {
            const code = e.target.value || null;
            edit(readingDraft(code, code === state.metric ? state.bodyState : null));
          }}
        >
          <option value="">Choose…</option>
          {/* Named groups, so recent-first then A to Z reads as an order, not a jumble (click test P2-27). */}
          {[
            { label: "Logged before, latest first", list: options.filter((m) => m.last !== null) },
            { label: "Not logged yet", list: options.filter((m) => m.last === null) },
          ]
            .filter((g) => g.list.length > 0)
            .map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.list.map((m) => (
                  <option key={m.code} value={m.code}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            ))}
        </select>
      </label>
      {metric ? (
        <div className="amount">
          <label className="field">
            <span>{fieldLabel(metric, shown.unit)}</span>
            <input inputMode="decimal" value={shown.value} onChange={(e) => edit({ value: e.target.value })} aria-invalid={error ? "true" : undefined} />
          </label>
          <div className="chips" role="group" aria-label="Unit">
            {metric.units.map((u) => (
              <button key={u} type="button" className="chip" aria-pressed={shown.unit === u} onClick={() => edit({ unit: u })}>
                {u}
              </button>
            ))}
          </div>
          {metric.sides.length > 0 ? (
            <div className="chips" role="group" aria-label="Side">
              {SIDES.map((s) => (
                <button key={s.value} type="button" className="chip" aria-pressed={shown.side === s.value} onClick={() => edit({ side: s.value })}>
                  {s.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="chips" role="group" aria-label="Before or after eating">
            {BODY_STATES.map((b) => (
              <button key={b.value} type="button" className="chip" aria-pressed={shown.bodyState === b.value} onClick={() => edit({ bodyState: b.value })}>
                {b.label}
              </button>
            ))}
          </div>
          {last ? <p className="sheet-day">{last}</p> : null}
        </div>
      ) : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <button type="button" className="btn primary" disabled={write.busy || held} onClick={save}>
        Log the reading
      </button>
      <SaveLine write={saveLine} online={online} />
      <QuestionAnswer write={write} tool="log_reading" online={online} current={entryNow} />
      {after.length > 0 ? (
        <div className="preview">
          {after.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}
    </>
  );
}
