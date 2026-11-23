import { useId, useMemo, useState } from "react";
import { callTool } from "../api";
import { PotCard } from "../components/PotCard";
import { FormError } from "../components/FormError";
import { DayNav, Link, LoadState } from "../components/Shell";
import { Split } from "../components/Split";
import { WaitingOnYou } from "../components/WaitingOnYou";
import { WriteLine } from "../components/WriteLine";
import { useLoad, useOnline, useWrites, type Writes } from "../hooks";
import { buildHousehold, type LeftoverRow } from "../household";
import { HOUSEHOLD_PARTS } from "../layout";
import { loadHousehold, type Who } from "../load";
import { hrefOf } from "../route";
import { slotLabel } from "../format";
import { leftoverDiscardPlan, leftoverEatenPlan, leftoverShare } from "../writes";
import { useWide } from "../wide";

const SLOTS = ["breakfast", "lunch", "dinner", "snack", "pre_workout", "post_workout"];

export function HouseholdScreen({ who, date, go }: { who: Who; date: string | null; go: (href: string) => void }) {
  const online = useOnline();
  const wide = useWide();
  const { state, reload } = useLoad(() => loadHousehold((t, i) => callTool(t, i), { date }), `household|${date ?? who.today}`);
  const writes = useWrites(reload, () => location.reload());
  const view = useMemo(() => (state.kind === "ready" ? buildHousehold(state.data, who) : null), [state, who]);
  if (state.kind !== "ready" || !view) return <LoadState state={state.kind === "ready" ? { kind: "loading" } : state} what="Household" retry={reload} />;
  const shown = date ?? who.today;
  const nodes = {
    top: (
      <div className="top">
        <h1>Household</h1>
        <DayNav date={shown} today={who.today} onDate={(d) => go(hrefOf({ route: { section: "household", date: d >= who.today ? null : d }, member: null }))} />
      </div>
    ),
    people: (
      <ul className="people">
        {view.members.map((m) => (
          <li key={m.name}>
            <Link href={m.href} go={go} className="person">
              <b>{m.name}</b>
              <span>{m.left}</span>
              <span>{m.status}</span>
              {m.drafts ? <span>{m.drafts}</span> : null}
              {m.last ? <span className="leftnote">{m.last}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    ),
    "waiting-you": <WaitingOnYou who={who} overview={state.data} date={date} onChanged={reload} />,
    meals: (
      <section aria-label="Shared meals">
        <h2>Shared meals</h2>
        {view.empty.meals ? <p className="leftnote">{view.empty.meals}</p> : null}
        {view.meals.map((m) => (
          <div key={m.date} className="pots">
            <h3>{m.label}</h3>
            {m.pots.map((p) => (
              <PotCard key={p.cookId} pot={p} writes={writes} online={online} />
            ))}
          </div>
        ))}
      </section>
    ),
    leftovers: (
      <section aria-label="Leftovers">
        <h2>Leftovers</h2>
        {view.empty.leftovers ? <p className="leftnote">{view.empty.leftovers}</p> : null}
        {view.leftovers.map((l) => (
          <Leftover key={l.componentId} row={l} writes={writes} online={online} />
        ))}
      </section>
    ),
    others: (
      <section aria-label="Waiting on others">
        <h2>Waiting on others</h2>
        {view.empty.waiting ? <p className="leftnote">{view.empty.waiting}</p> : null}
        <ul className="foot">
          {view.waiting.map((w) => (
            <li key={w.key}>{w.text}</li>
          ))}
        </ul>
      </section>
    ),
  };
  return (
    <main className="screen household">
      <Split wide={wide} specs={HOUSEHOLD_PARTS} nodes={nodes} />
    </main>
  );
}

function Leftover({ row, writes, online }: { row: LeftoverRow; writes: Writes; online: boolean }) {
  const [eater, setEater] = useState<string | null>(null);
  // Part of it, as a share of the whole pot; empty is all of it (click test P2-27).
  const [part, setPart] = useState("");
  const share = leftoverShare(part, row.fraction);
  const key = `leftover:${row.componentId}`;
  const titleId = useId();
  // After a failed write the only resend is "Try again" (same keys): a new tap would make new keys and could record a second serving.
  const busy = !online || writes.status(key)?.state === "pending" || writes.canRetry(key);
  return (
    // A group named by its title, so each leftover's "Eaten by" and "Discarded" buttons are told apart from another leftover's.
    <div className="tier leftover" role="group" aria-labelledby={titleId}>
      <header>
        <h3 id={titleId}>{row.title}</h3>
        <span>{row.amount}</span>
      </header>
      <p className="leftnote">{row.since}</p>
      {eater ? (
        <label className="field">
          <span>How much of the pot (%)</span>
          <input inputMode="decimal" value={part} placeholder={`all of it, ${Math.round(row.fraction * 100)}`} disabled={busy} onChange={(e) => setPart(e.target.value)} />
        </label>
      ) : null}
      {eater ? <FormError className="error-text" text={"error" in share ? share.error : null} /> : null}
      {eater ? <p className="leftnote">Which meal did {eater} eat it at?</p> : null}
      {eater ? (
        <div className="acts l-cluster" role="group" aria-label={`Which meal did ${eater} eat it at?`}>
          {SLOTS.map((s) => (
            <button key={s} type="button" className="btn" disabled={busy || "error" in share} onClick={() => "error" in share || void writes.run(key, leftoverEatenPlan(row.componentId, eater, s, "fraction" in share ? share.fraction : undefined), (r) => r.status.state === "saved" && (setEater(null), setPart("")))}>
              {slotLabel(s)}
            </button>
          ))}
          <button type="button" className="btn" onClick={() => setEater(null)}>
            Back
          </button>
        </div>
      ) : (
        <div className="acts l-cluster">
          {row.eaters.map((m) => (
            <button key={m} type="button" className="btn" disabled={busy} onClick={() => setEater(m)}>
              Eaten by {m}
            </button>
          ))}
          {row.discardable ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void writes.run(key, leftoverDiscardPlan(row.componentId))}>
              Discarded
            </button>
          ) : null}
        </div>
      )}
      <WriteLine writes={writes} id={key} online={online} />
    </div>
  );
}
