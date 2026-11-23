import { useEffect, useMemo, useState } from "react";
import { callTool } from "../api";
import { PlateDiagram } from "../components/PlateDiagram";
import { LoadState } from "../components/Shell";
import { Split } from "../components/Split";
import { WriteLine } from "../components/WriteLine";
import { useLoad, useOnline, useSaved, useSheet, useWrites } from "../hooks";
import { loadEarlierSessions, loadTrain, type Who } from "../load";
import { qty } from "../format";
import { HistoryLink } from "../components/HistoryLink";
import { CardioFixer, ConfirmDraft, SetFixer } from "../components/Fix";
import { buildHistory, buildTrain, emptyHistory, historyStep, questionKey, sessionList, setTarget, type HistoryAction, type HistoryCard, type Question, type SessionHistory, type TrainRow } from "../train";
import { Grid } from "../components/layout/Grid";
import { TRAIN, TRAIN_PARTS } from "../layout";
import { useWide } from "../wide";
import { saveAsWorkoutPlan } from "../workout";
import { checkStepPlan, confirmRepsPlan, platesPlan } from "../writes";
import type { Writes } from "../hooks";
import type { SheetTarget } from "../sheet";
import { TrainViewNav } from "./ViewScreens";

export function TrainScreen({ who, viewing, go }: { who: Who; viewing: string; go: (href: string) => void }) {
  const online = useOnline();
  const wide = useWide();
  const { state, reload } = useLoad(() => loadTrain((t, i) => callTool(t, i), { who, viewing, from: null }), `train|${viewing}`);
  const writes = useWrites(reload, () => location.reload());
  const saved = useSaved();
  const sessions = useSessionHistory(viewing);
  useEffect(() => {
    if (saved) reload();
    // Only a new Save in the "+" sheet re-reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);
  const view = useMemo(() => (state.kind === "ready" ? buildTrain(state.data) : null), [state]);
  if (state.kind !== "ready" || !view) return <LoadState state={state.kind === "ready" ? { kind: "loading" } : state} what="Train" retry={reload} />;
  // One session list (wide-layout spec §5): the page's sessions, then those "Show earlier" added; `history` lists it, `open` shows the pick.
  const { cards, oldest, selected } = sessionList(view.history, view.historyFrom, sessions.state);
  const nodes = {
    top: (
      <div className="top">
        <h1>{view.title ?? "Train"}</h1>
        <TrainViewNav who={who} viewing={viewing} current="session" go={go} />
      </div>
    ),
    message: view.message ? <p className="leftnote">{view.message}</p> : null,
    policy: view.policy ? <p className="banner">{view.policy}</p> : null,
    gaps:
      view.gaps.length > 0 ? (
        <ul className="gaps">
          {view.gaps.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      ) : null,
    // The prescriptions: a grid of cards on a wide screen, one to three across (wide-layout spec §5, Train A); `fill` keeps a lone card at card width.
    rows:
      view.rows.length > 0 ? (
        <Grid wide={wide} min={340} gap={12} fill as="ol" className="rows">
          {view.rows.map((r) => (
            <Row key={r.id} row={r} viewing={viewing} writes={writes} online={online} logSet={(exercise) => setTarget(view, exercise, viewing, who.today)} />
          ))}
        </Grid>
      ) : null,
    question: view.question ? <InventoryQuestion key={questionKey(view.question)} q={view.question} member={viewing} writes={writes} online={online} /> : null,
    history: (
      <History
        key={viewing}
        cards={cards}
        failed={view.historyFailed}
        oldest={oldest}
        status={sessions.state.status}
        showEarlier={() => void sessions.showEarlier(oldest, view.own)}
        picked={selected?.id ?? null}
        pick={sessions.pick}
        retry={reload}
        timeZone={who.time_zone}
        writes={writes}
        online={online}
        wide={wide}
        mode={view.mode}
      />
    ),
    // The open session, wide only: its own part, so a layout can give it its own region (Train A).
    open:
      wide && selected ? (
        <article className="rx session-open l-stack" aria-label={`${selected.title}, ${selected.summary}`}>
          <h3>
            {selected.title} <span>{selected.summary}</span>
          </h3>
          <SessionBody h={selected} timeZone={who.time_zone} writes={writes} online={online} mode={view.mode} />
        </article>
      ) : null,
  };
  return (
    <main className="screen train">
      <Split wide={wide} specs={TRAIN_PARTS} nodes={nodes} layout={TRAIN} />
    </main>
  );
}

function Row({ row, writes, online, logSet }: { row: TrainRow; viewing: string; writes: Writes; online: boolean; logSet: (exercise: string) => SheetTarget }) {
  const sheet = useSheet();
  const key = `rx:${row.id}`;
  const busy = !online || writes.status(key)?.state === "pending";
  return (
    <li className="rx l-stack">
      <header>
        <h2>{row.exercise}</h2>
        <span>{row.dose}</span>
      </header>
      {row.load?.kind === "plates" ? <PlateDiagram layout={row.load.layout} /> : row.load ? <p className="loadval">{row.load.text}</p> : null}
      <p className={`chip ${row.chip.kind}`}>{row.chip.text}</p>
      {row.cue ? (
        <details>
          <summary className="t-clamp">{row.cue}</summary>
          {row.fallback ? <p>{row.fallback}</p> : null}
        </details>
      ) : row.fallback ? (
        <p className="fallback">{row.fallback}</p>
      ) : null}
      {row.confirm ? (
        <div className="acts l-cluster">
          <button type="button" className="btn primary" disabled={busy} onClick={() => row.confirm && void writes.run(key, confirmRepsPlan(row.confirm.setIds))}>
            Reps were as logged
          </button>
        </div>
      ) : null}
      {row.check ? (
        <div className="acts l-cluster">
          {[true, false].map((there) => {
            const plan = row.check ? checkStepPlan(row.check.offer, there) : null;
            return plan ? (
              <button key={String(there)} type="button" className={`btn${there ? " primary" : ""}`} disabled={busy} onClick={() => void writes.run(key, plan)}>
                {there ? "It's there" : "It isn't there"}
              </button>
            ) : null;
          })}
        </div>
      ) : null}
      <div className="acts l-cluster">
        <button type="button" className="btn" onClick={(e) => sheet.open(logSet(row.exercise), e.currentTarget)}>
          Log a set
        </button>
      </div>
      <WriteLine writes={writes} id={key} online={online} />
    </li>
  );
}

function InventoryQuestion({ q, member, writes, online }: { q: Question; member: string; writes: Writes; online: boolean }) {
  const [seen, setSeen] = useState<number[]>([]);
  if (q.kind === "chat") return <p className="ask-inv">{q.text}</p>;
  const key = "inventory";
  return (
    <section className="ask-inv" aria-label="A question about your gym">
      <p>{q.text}</p>
      <div className="acts l-cluster">
        {q.values.map((v) => (
          <button key={v} type="button" className="btn" aria-pressed={seen.includes(v)} onClick={() => setSeen((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]))}>
            {qty(v)} {q.unit}
          </button>
        ))}
        <button type="button" className="btn primary" disabled={!online || writes.status(key)?.state === "pending"} onClick={() => void writes.run(key, platesPlan(member, q.unit, q.values, seen))}>
          Save the plates
        </button>
      </div>
      <WriteLine writes={writes} id={key} online={online} />
    </section>
  );
}

/**
 * Sessions, newest first, from the one session list (`useSessionHistory`).
 * "Show earlier" reads the eight weeks before the oldest shown and appends
 * them, so the page above stays mounted. On a wide screen a row picks the
 * session the `open` part shows; on the phone each row opens in place.
 */
function History({
  cards, failed, oldest, status, showEarlier, picked, pick, retry, timeZone, writes, online, wide, mode,
}: {
  cards: HistoryCard[];
  failed: boolean;
  oldest: string | null;
  status: SessionHistory["status"];
  showEarlier: () => void;
  picked: number | null;
  pick: (id: number) => void;
  retry: () => void;
  timeZone: string;
  writes: Writes;
  online: boolean;
  wide: boolean;
  mode: "prescribed" | "record_only";
}) {
  return (
    <section className="history" aria-label="Sessions">
      <h2>Sessions</h2>
      {failed ? (
        <>
          <p className="leftnote">The session history couldn't be loaded.</p>
          <button type="button" className="btn" onClick={retry}>
            Try loading the history again
          </button>
        </>
      ) : null}
      {!failed && cards.length === 0 ? <p className="leftnote">No sessions in this range.</p> : null}
      {wide ? (
        <ol className="rows session-list">
          {cards.map((h) => (
            <li key={h.id}>
              <button type="button" className="session-row" data-row aria-pressed={picked === h.id} onClick={() => pick(h.id)}>
                <b>{h.title}</b> <span>{h.summary}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <ol className="rows">
          {cards.map((h) => (
            <li key={h.id} className="rx l-stack">
              <details>
                <summary>
                  <b>{h.title}</b> <span>{h.summary}</span>
                </summary>
                <SessionBody h={h} timeZone={timeZone} writes={writes} online={online} mode={mode} />
              </details>
            </li>
          ))}
        </ol>
      )}
      {status === "loading" ? <p className="leftnote">Loading earlier sessions</p> : null}
      {status === "error" ? <p className="error-text">Earlier sessions didn't load. Try again.</p> : null}
      {oldest ? (
        <button type="button" className="btn" disabled={status === "loading"} onClick={showEarlier}>
          {status === "error" ? "Try showing earlier again" : "Show earlier"}
        </button>
      ) : null}
    </section>
  );
}

/**
 * The one session list's state (wide-layout spec §5), keyed by member: a
 * switch starts afresh before the first paint (React's adjust-state-while-
 * rendering pattern), and a load that lands after a switch, or after the
 * list started afresh, is dropped (`historyStep` checks the member and the
 * `before` the load asked for).
 */
function useSessionHistory(viewing: string) {
  const [held, setHeld] = useState(() => emptyHistory(viewing));
  const state = held.member === viewing ? held : emptyHistory(viewing);
  if (held.member !== viewing) setHeld(state);
  const step = (a: HistoryAction) => setHeld((s) => historyStep(s, a));
  return {
    state,
    pick: (id: number) => step({ kind: "pick", member: viewing, id }),
    showEarlier: async (before: string | null, own: boolean) => {
      if (!before) return;
      step({ kind: "loading", member: viewing, before });
      const out = await loadEarlierSessions((t, i) => callTool(t, i), { viewing, before });
      if (out.kind !== "ok") return step({ kind: "failed", member: viewing, before });
      step({ kind: "loaded", member: viewing, before, cards: buildHistory(out.data, own), from: out.data.from });
    },
  };
}

/** A session's body: its note, records, sets and "Save this session as a workout". A fragment, so the phone's details keep their DOM. */
function SessionBody({ h, timeZone, writes, online, mode }: { h: HistoryCard; timeZone: string; writes: Writes; online: boolean; mode: "prescribed" | "record_only" }) {
  return (
    <>
      {h.note ? <p className="leftnote">{h.note}</p> : null}
      {h.records.map((r) => (
        <p key={r} className="chip">
          {r}
        </p>
      ))}
      <ul className="items">
        {h.sets.map((x) => (
          <li key={x.id} className={`item${x.draft ? " draft" : ""}`}>
            <span>{x.text}</span>
            <HistoryLink table="session_set" id={x.id} timeZone={timeZone} />
            {x.fix ? <SetFixer fix={x.fix} name={x.text} mode={mode} writes={writes} online={online} /> : null}
            {x.confirm ? <ConfirmDraft id={`set:${x.id}`} records={x.confirm} writes={writes} online={online} /> : null}
          </li>
        ))}
        {h.cardioFix || h.cardio ? (
          <li className="item">
            <span>{h.cardio ?? h.summary}</span>
            {h.cardioFix ? <CardioFixer id={h.id} fix={h.cardioFix} name={h.title} writes={writes} online={online} /> : null}
          </li>
        ) : null}
      </ul>
      {h.sets.length > 0 ? <SaveAsWorkout sessionId={h.id} writes={writes} online={online} /> : null}
    </>
  );
}

/** "Save this session as a workout" on a session card: name it, then save_session_as_workout. */
function SaveAsWorkout({ sessionId, writes, online }: { sessionId: number; writes: Writes; online: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const key = `as-workout:${sessionId}`;
  const plan = saveAsWorkoutPlan(sessionId, name);
  if (!open) {
    // What it was saved as stays under the button once the form closes (click test P2-18).
    return (
      <div className="acts l-cluster">
        <button type="button" className="btn" onClick={() => (writes.clear(key), setOpen(true))}>
          Save this session as a workout
        </button>
        {writes.status(key) ? <WriteLine writes={writes} id={key} online={online} /> : null}
      </div>
    );
  }
  return (
    <div className="acts l-cluster">
      <label className="field">
        <span>Workout name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <button type="button" className="btn primary" disabled={!online || "error" in plan || writes.status(key)?.state === "pending" || writes.canRetry(key)} onClick={() => "steps" in plan && void writes.run(key, plan, (o) => o.status.state === "saved" && setOpen(false))}>
        Save as a workout
      </button>
      <WriteLine writes={writes} id={key} online={online} />
    </div>
  );
}
