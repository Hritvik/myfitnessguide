import { useId, useState, type FormEvent } from "react";
import type { Writes } from "../hooks";
import type { PotCard as Pot } from "../today";
import { changeSharePlan, confirmPlan, leftoverPlan, undoChangePlan } from "../writes";
import { Text } from "./layout/Text";
import { WriteLine } from "./WriteLine";

/** Segments narrower than this show their label only to screen readers. */
const LABEL_MIN_SHARE = 0.13;

export function PotCard({ pot, writes, online }: { pot: Pot; writes: Writes; online: boolean }) {
  const key = `pot:${pot.cookId}`;
  const [editing, setEditing] = useState(false);
  const [share, setShare] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();
  const disabled = !online || writes.status(key)?.state === "pending";
  const ask = pot.ask;

  function startEdit() {
    setShare(ask?.sharePercent === null || ask?.sharePercent === undefined ? "" : String(ask.sharePercent));
    setError(null);
    setEditing(true);
  }

  function saveShare(e: FormEvent) {
    e.preventDefault();
    if (!ask) return;
    const plan = changeSharePlan(ask, share);
    if ("error" in plan) {
      setError(plan.error);
      return;
    }
    setError(null);
    // A "Try again" that lands closes the editor too (decision 74).
    void writes.run(key, plan, (result) => result.status.state === "saved" && setEditing(false));
  }

  return (
    <section className="pot" aria-labelledby={`${key}-h`}>
      <header>
        <h2 id={`${key}-h`}>
          {pot.title}
          <span>, one pot</span>
        </h2>
        <p className="meta">{pot.meta}</p>
      </header>

      {pot.bars.map((bar) => (
        <div className="bar" key={bar.componentId}>
          {bar.name ? <span className="bar-name">{bar.name}</span> : null}
          <div className="split" role="img" aria-label={bar.description}>
            {bar.segments.map((s, i) => (
              <div key={i} className={`seg ${s.kind}`} style={{ flexGrow: s.share }} title={s.share >= LABEL_MIN_SHARE ? s.label : undefined}>
                {s.share >= LABEL_MIN_SHARE ? <Text mode="truncate" reach="label">{s.label}</Text> : null}
              </div>
            ))}
          </div>
        </div>
      ))}

      {pot.legend.length > 0 ? (
        <p className="legend">
          {pot.legend.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </p>
      ) : null}

      {ask ? (
        <div className="ask">
          <p>
            {ask.parts.map((part, i) =>
              part.estimated ? (
                <span key={i} className="est">
                  {part.text}
                </span>
              ) : (
                part.text
              ),
            )}
          </p>
          {editing ? (
            <form className="share" onSubmit={saveShare} noValidate>
              <label htmlFor={inputId}>My share</label>
              <span className="field">
                <input
                  id={inputId}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={share}
                  onChange={(e) => setShare(e.target.value)}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  autoFocus
                />
                %
              </span>
              <button type="submit" className="btn primary" disabled={disabled}>
                Save my share
              </button>
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
              {error ? (
                <p id={errorId} className="error-text full">
                  {error}
                </p>
              ) : null}
            </form>
          ) : (
            <div className="acts l-cluster">
              <button type="button" className="btn primary" disabled={disabled} onClick={() => void writes.run(key, confirmPlan(ask.confirm))}>
                {ask.redraft ? "Keep their change" : "Yes, confirm"}
              </button>
              {ask.redraft ? (
                <button type="button" className="btn" disabled={disabled} onClick={() => void writes.run(key, undoChangePlan(ask.confirm))}>
                  Undo their change
                </button>
              ) : null}
              <button type="button" className="btn" disabled={disabled} onClick={startEdit}>
                Change my share
              </button>
              {ask.canMarkLeftover && !ask.redraft ? (
                <button type="button" className="btn" disabled={disabled} onClick={() => void writes.run(key, leftoverPlan(ask.componentId))}>
                  Mark the rest leftover
                </button>
              ) : null}
            </div>
          )}
          <WriteLine writes={writes} id={key} online={online} />
        </div>
      ) : null}

      {!ask && pot.settle.length > 0 ? (
        <div className="acts l-cluster">
          {pot.settle.map((componentId) => (
            <button key={componentId} type="button" className="btn" disabled={disabled} onClick={() => void writes.run(key, leftoverPlan(componentId))}>
              Mark the rest leftover{pot.bars.length > 1 ? ` (${pot.bars.find((b) => b.componentId === componentId)?.name})` : ""}
            </button>
          ))}
        </div>
      ) : null}

      {ask ? null : <WriteLine writes={writes} id={key} online={online} />}
    </section>
  );
}
