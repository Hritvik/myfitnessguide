import { useEffect, useId, useMemo, useState } from "react";
import { callTool } from "../api";
import { LineChart } from "../charts/LineChart";
import { linear } from "../charts/scale";
import { Link, LoadState } from "../components/Shell";
import { Split } from "../components/Split";
import { DraftsToCheck } from "../components/DraftsToCheck";
import { HistoryLink } from "../components/HistoryLink";
import { Text } from "../components/layout/Text";
import { StateScreen } from "../components/Parts";
import { WriteLine } from "../components/WriteLine";
import { ReadingFixer } from "../components/Fix";
import { readingFixes } from "../fixes";
import type { ReadingMetrics } from "../types";
import { useLoad, useOnline, useSaved, useSheet, useWrites, type Writes } from "../hooks";
import { loadHealth, loadTrajectory, loadWeek, type Who } from "../load";
import { HEALTH_PARTS, PROGRESS_PARTS } from "../layout";
import { buildHealth, buildTrajectory, buildWeek, drawRows, HEALTH_HEADINGS, readingRows, type DrawRow, type FlagView, type MarkerView, type ReadingRow } from "../progress";
import { hrefOf, type Range } from "../route";
import { resolveFlagPlan } from "../writes";
import { useWide } from "../wide";
import { ProgressViewHeader, ProgressViewNav } from "./ViewScreens";

const RANGES: { range: Range; label: string }[] = [
  { range: "4w", label: "4 weeks" },
  { range: "12w", label: "12 weeks" },
  { range: "6m", label: "6 months" },
  { range: "1y", label: "1 year" },
  { range: "all", label: "All" },
];

export function ProgressScreen({ who, viewing, range, week, go }: { who: Who; viewing: string; range: Range; week: string | null; go: (href: string) => void }) {
  const { state, reload } = useLoad(() => loadTrajectory((t, i) => callTool(t, i), { who, viewing, range }), `trajectory|${viewing}|${range}`);
  const sheet = useSheet();
  const wide = useWide();
  // A reading saved in the "+" sheet re-reads quietly, as Today does (pre-flight ruling on Task 16).
  const saved = useSaved();
  useEffect(() => {
    if (saved) reload();
    // Only a new Save re-reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);
  const view = useMemo(() => (state.kind === "ready" && !state.data.private ? buildTrajectory(state.data) : null), [state]);
  if (state.kind === "ready" && state.data.private) {
    return (
      <StateScreen title="Progress">
        <p>{state.data.message}</p>
      </StateScreen>
    );
  }
  if (state.kind !== "ready" || !view) return <LoadState state={state.kind === "ready" ? { kind: "loading" } : state} what="Progress" retry={reload} />;
  const ranges = (
    <nav className="ranges" aria-label="Range">
      {RANGES.map((r) => (
        <Link key={r.range} className="pill" href={hrefOf({ route: { section: "progress", view: "body", range: r.range, week }, member: null })} go={go} current={r.range === range}>
          {r.label}
        </Link>
      ))}
    </nav>
  );
  const nodes = {
    top: (
      <div className="top">
        <h1>Progress</h1>
        <ProgressViewNav who={who} viewing={viewing} current="body" range={range} week={week} go={go} />
        {ranges}
      </div>
    ),
    title: <ProgressViewHeader who={who} viewing={viewing} current="body" range={range} week={week} go={go} />,
    headline: view.headline ? (
      <section className="goal trajectory-headline" aria-label="Headline goal">
        <Text as="p" className="eyebrow">Current direction</Text>
        <Text as="h2" className={`trajectory-verdict ${view.headline.verdict.kind}`}>{view.headline.verdict.text}</Text>
        <Text as="p" className="trajectory-observation">{view.headline.observation}</Text>
        <Text as="h3" className="trajectory-metric">{view.headline.title}</Text>
        <p className="goal-value">
          <Text as="b">{view.headline.value ?? "No reading yet"}</Text>
          {view.headline.target ? <Text as="span"> {view.headline.target}</Text> : null}
        </p>
        {view.headline.secondary ? <Text as="p" className="leftnote">{view.headline.secondary}</Text> : null}
      </section>
    ) : (
      <p className="leftnote">{view.message}</p>
    ),
    log: (
      <button type="button" className="btn" onClick={(e) => sheet.open({ tab: "reading" }, e.currentTarget)}>
        Log a reading
      </button>
    ),
    drafts: <DraftsToCheck who={who} kind="reading" onChanged={reload} />,
    chart: view.chart ? <LineChart chart={view.chart} /> : null,
    weight: view.weight ? <LineChart chart={view.weight} /> : null,
    context: (
      <section className="trajectory-context l-stack g-8" aria-labelledby="trajectory-context-title">
        <Text as="h2" id="trajectory-context-title">Review the inputs</Text>
        <Text as="p">Nutrition and training show the choices recorded alongside this trend. They do not prove what caused it.</Text>
        <div className="l-cluster g-8">
          <Link className="btn" href={hrefOf({ route: { section: "progress", view: "nutrition", range, week }, member: null })} go={go}>Nutrition</Link>
          <Link className="btn" href={hrefOf({ route: { section: "train", view: "lifts", lift: null }, member: null })} go={go}>Lifts</Link>
        </div>
      </section>
    ),
    ranges,
    readings: <ReadingsTable rows={readingRows(view)} />,
    recent: <RecentReadings who={who} onChanged={reload} />,
    week: <WeekSection who={who} viewing={viewing} week={week} range={range} go={go} />,
    health: (
      <Link className="btn" href={hrefOf({ route: { section: "progress", view: "health", range, week }, member: null })} go={go}>
        Health
      </Link>
    ),
  };
  return (
    <main className="screen progress">
      <Split wide={wide} specs={PROGRESS_PARTS} nodes={nodes} />
    </main>
  );
}

/** The readings and goal points by date, with the 7-day weight (web decision 66). Wide layout only. */
function ReadingsTable({ rows }: { rows: ReadingRow[] }) {
  if (rows.length === 0) return null;
  const withWeight = rows.some((r) => r.weight !== null);
  return (
    <section className="readings" aria-label="Readings and goals">
      <h2>Readings and goals</h2>
      <table className="wide-table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Reading</th>
            <th scope="col">Goal</th>
            {withWeight ? <th scope="col">7-day weight</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.date}>
              <th scope="row">{r.date}</th>
              <td>{r.value}</td>
              <td>{r.goal}</td>
              {withWeight ? <td>{r.weight ?? "not known"}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** How many recent readings show before "Show all". */
const RECENT_SHOWN = 5;

/**
 * Your recent readings with Edit and Remove (click test P1-3), newest first,
 * from reading_metrics: a wrong reading (700 kg, a waist in inches) is fixed
 * here and leaves the trends. Both layouts; five rows, then "Show all".
 */
function RecentReadings({ who, onChanged }: { who: Who; onChanged: () => void }) {
  const online = useOnline();
  const { state, reload } = useLoad(() => callTool<ReadingMetrics>("reading_metrics", { member: who.member }), `reading-metrics|${who.member}`);
  const writes = useWrites(
    () => {
      reload();
      onChanged();
    },
    () => location.reload(),
  );
  const [all, setAll] = useState(false);
  if (state.kind !== "ready") return null;
  const rows = readingFixes(state.data);
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, RECENT_SHOWN);
  return (
    <section className="tier" aria-label="Your readings">
      <header>
        <h2>Your readings</h2>
      </header>
      <ul className="items">
        {shown.map((r) => (
          <li key={r.id} className="item">
            <span>{r.text}</span>
            <HistoryLink table="reading" id={r.id} timeZone={who.time_zone} />
            <ReadingFixer fix={r} today={who.today} writes={writes} online={online} />
          </li>
        ))}
      </ul>
      {rows.length > RECENT_SHOWN ? (
        <button type="button" className="btn" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      ) : null}
    </section>
  );
}

/**
 * Health's blood draws, on both layouts (click test P2-22): every draw,
 * newest first, each a row that opens to all of its results (an earlier
 * draw's values, which the panels above leave out once a later draw has
 * the marker).
 */
function DrawsList({ rows }: { rows: DrawRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="draws history" aria-label="Blood draws">
      <h2>Blood draws</h2>
      <ol className="rows">
        {rows.map((r) => (
          <li key={r.id} className="rx l-stack">
            <details>
              <summary>
                <b>{r.title}</b> <span>{r.results} · {r.out}</span>
              </summary>
              <ul className="items">
                {r.markers.map((m) => (
                  <MarkerItem key={m.id} m={m} />
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}

function WeekSection({ who, viewing, week, range, go }: { who: Who; viewing: string; week: string | null; range: Range; go: (href: string) => void }) {
  const { state, reload } = useLoad(() => loadWeek((t, i) => callTool(t, i), { who, viewing, week }), `week|${viewing}|${week ?? ""}`);
  if (state.kind !== "ready") {
    if (state.kind === "loading") return null;
    return (
      <p className="error-text" role="alert">
        The week could not be loaded.{" "}
        <button type="button" className="btn" onClick={reload}>
          Try again
        </button>
      </p>
    );
  }
  if (state.data.private) return null;
  const view = buildWeek(state.data.summary, state.data.today);
  const to = (w: string | null) => hrefOf({ route: { section: "progress", view: "body", range, week: w }, member: null });
  return (
    <section className="week" aria-label={view.title}>
      <header>
        <h2>{view.title}</h2>
        <nav className="daynav" aria-label="Week">
          <Link className="btn" href={to(view.prev)} go={go}>
            ‹
          </Link>
          {view.next ? (
            <Link className="btn" href={to(view.next)} go={go}>
              ›
            </Link>
          ) : null}
        </nav>
      </header>
      <ol className="weekdays">
        {view.days.map((d) => (
          <li key={d.date}>
            <span>{d.label}</span>
            <span>{d.training}</span>
            <span>
              {d.kcal}
              {d.fill !== null ? (
                <span className="track" aria-hidden="true">
                  <span style={{ width: `${(d.fill * 100).toFixed(1)}%` }} />
                </span>
              ) : null}
            </span>
            <span>{[d.protein, d.status].filter(Boolean).join(" · ")}</span>
          </li>
        ))}
      </ol>
      <p>{view.measured}</p>
      <p className={view.energy.flagged ? "chip flagged" : ""}>{view.energy.text}</p>
    </section>
  );
}

export function HealthScreen({ who, viewing, range, week, go }: { who: Who; viewing: string; range: Range; week: string | null; go: (href: string) => void }) {
  const online = useOnline();
  const wide = useWide();
  const { state, reload } = useLoad(() => loadHealth((t, i) => callTool(t, i), { who, viewing }), `health|${viewing}`);
  const writes = useWrites(reload, () => location.reload());
  if (state.kind === "ready" && state.data.private) {
    return (
      <StateScreen title="Health">
        <p>{state.data.message}</p>
      </StateScreen>
    );
  }
  if (state.kind !== "ready" || state.data.private) return <LoadState state={state.kind === "ready" ? { kind: "loading" } : state} what="Health" retry={reload} />;
  const view = buildHealth(state.data.draws, state.data.flags);
  const nodes = {
    top: (
      <div className="top">
        <h1>Health</h1>
        <ProgressViewNav who={who} viewing={viewing} current="health" range={range} week={week} go={go} />
      </div>
    ),
    overview: <HealthOverview view={view.overview} />,
    drafts: <DraftsToCheck who={who} kind="blood_draw" onChanged={reload} />,
    out: view.outOfRange.length > 0 ? <Panel title="Outside the reported range" markers={view.outOfRange} showDraw /> : null,
    panels:
      view.panels.length > 0 ? (
        <>
          {view.panels.map((p) => (
            <Panel key={p.title} title={p.title} markers={p.markers} note={p.allOutOfRange ? "Every marker from this draw is out of range and listed above." : null} />
          ))}
        </>
      ) : null,
    gaps: view.gaps.length > 0 ? <FlagList title={HEALTH_HEADINGS.gaps} items={view.gaps} writes={writes} online={online} /> : null,
    flags: view.flags.length > 0 ? <FlagList title={HEALTH_HEADINGS.flags} items={view.flags} writes={writes} online={online} /> : null,
    draws: <DrawsList rows={drawRows(state.data.draws)} />,
  };
  return (
    <main className="screen health">
      <Split wide={wide} specs={HEALTH_PARTS} nodes={nodes} />
    </main>
  );
}

function HealthOverview({ view }: { view: ReturnType<typeof buildHealth>["overview"] }) {
  return (
    <section className={`health-overview ${view.kind}`} aria-labelledby="health-overview-title">
      <Text as="p" className="eyebrow">Current review</Text>
      <Text as="h2" id="health-overview-title">{view.title}</Text>
      <Text as="p" className="health-overview-summary">{view.summary}</Text>
      <Text as="p" className="leftnote">{view.note}</Text>
    </section>
  );
}

function Panel({ title, markers, note = null, showDraw = false }: { title: string; markers: MarkerView[]; note?: string | null; showDraw?: boolean }) {
  return (
    <section className="tier">
      <header>
        <h2>{title}</h2>
      </header>
      <ul className="items">
        {note ? <li className="leftnote">{note}</li> : null}
        {markers.map((m) => (
          <MarkerItem key={m.id} m={m} showDraw={showDraw} />
        ))}
      </ul>
    </section>
  );
}

function MarkerItem({ m, showDraw = false }: { m: MarkerView; showDraw?: boolean }) {
  return (
    <li className="item marker">
      <span>{m.name}</span>
      <span>
        <b>{m.value}</b> {m.range ? <small>({m.range})</small> : null}
      </span>
      <span className="prov">
        {showDraw ? `${m.draw}, ` : ""}
        {m.statusText}
        {m.change ? `, ${m.change}` : ""}
      </span>
      {m.band ? <RangeBand band={m.band} /> : null}
    </li>
  );
}

/** The lab's range as a band and the value as a mark (ink; never red). Geometry only. */
function RangeBand({ band }: { band: NonNullable<MarkerView["band"]> }) {
  const lo = band.low ?? Math.min(band.value, (band.high ?? band.value) * 0.5);
  const hi = band.high ?? Math.max(band.value, (band.low ?? band.value) * 1.5);
  const x = linear([Math.min(lo, band.value), Math.max(hi, band.value)], [4, 116]);
  return (
    <svg className="band" viewBox="0 0 120 10" width="120" height="10" aria-hidden="true">
      <rect x={x(lo)} y="3" width={Math.max(1, x(hi) - x(lo))} height="4" rx="2" fill="var(--steel-2)" />
      <circle cx={x(band.value)} cy="5" r="3.5" fill="var(--ink)" />
    </svg>
  );
}

function FlagList({ title, items, writes, online }: { title: string; items: FlagView[]; writes: Writes; online: boolean }) {
  return (
    <section className="foot" aria-label={title}>
      <h2>{title}</h2>
      {items.map((f) => (
        <FlagRow key={f.id} flag={f} writes={writes} online={online} />
      ))}
    </section>
  );
}

function FlagRow({ flag, writes, online }: { flag: FlagView; writes: Writes; online: boolean }) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const key = `flag:${flag.id}`;
  const subjectId = useId();
  return (
    // Named by its subject, so its "Resolve…" is told apart from the other flags' (and found by name).
    <div className="flag" role="group" aria-labelledby={subjectId}>
      <p>
        <b id={subjectId}>{flag.subject}</b> {flag.due ? <span>{flag.due}</span> : null}
      </p>
      {flag.note ? <p className="leftnote">{flag.note}</p> : null}
      {open ? (
        <form
          className="share"
          onSubmit={(e) => {
            e.preventDefault();
            const plan = resolveFlagPlan(flag.id, why);
            if ("error" in plan) setError(plan.error);
            else {
              setError(null);
              void writes.run(key, plan);
            }
          }}
        >
          <label>
            How was it resolved?
            <input value={why} onChange={(e) => setWhy(e.target.value)} aria-invalid={error ? "true" : undefined} />
          </label>
          {error ? <p className="error-text">{error}</p> : null}
          <button type="submit" className="btn primary" disabled={!online}>
            Resolve it
          </button>
        </form>
      ) : (
        <button type="button" className="btn" onClick={() => setOpen(true)} disabled={!online}>
          Resolve…
        </button>
      )}
      <WriteLine writes={writes} id={key} online={online} />
    </div>
  );
}
