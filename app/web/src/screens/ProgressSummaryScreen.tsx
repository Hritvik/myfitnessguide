import { useMemo, type ReactNode } from "react";
import { callTool } from "../api";
import { Link, LoadState } from "../components/Shell";
import { Split } from "../components/Split";
import { Text } from "../components/layout/Text";
import { StateScreen } from "../components/Parts";
import { useLoad } from "../hooks";
import { SUMMARY_PARTS } from "../layout";
import { loadProgressSummary, type Who } from "../load";
import { day, n, pct, plural } from "../format";
import { buildProgressSummary, metricTitle, one, signed, type SummarySignal } from "../progress";
import { RANGES, hrefOf, type ProgressView, type Range } from "../route";
import type { ProgressSummary } from "../types";
import { useWide } from "../wide";
import { ProgressViewHeader, ProgressViewNav } from "./ViewScreens";

const RANGE_LABEL: Record<Range, string> = { "4w": "4 weeks", "12w": "12 weeks", "6m": "6 months", "1y": "1 year", all: "All" };

/**
 * The Progress overview (spec §Unified Progress read model, 20 Oct 2026): the
 * Direction hero, the five-signal grid, one next drill-down, a comparison
 * strip, the domain links and the collapsible evidence. Every figure comes
 * from progress_summary; the layout only orders and words it. Association,
 * never causality.
 */
export function ProgressSummaryScreen({ who, viewing, range, week, go }: { who: Who; viewing: string; range: Range; week: string | null; go: (href: string) => void }) {
  const wide = useWide();
  const { state, reload } = useLoad(() => loadProgressSummary((t, i) => callTool(t, i), { who, viewing, range }), `progress-summary|${viewing}|${range}`);
  const view = useMemo(() => (state.kind === "ready" && !state.data.private ? buildProgressSummary(state.data) : null), [state]);
  if (state.kind === "ready" && state.data.private) {
    return (
      <StateScreen title="Progress">
        <Text as="p">{state.data.message}</Text>
      </StateScreen>
    );
  }
  if (state.kind !== "ready" || !view) return <LoadState state={state.kind === "ready" ? { kind: "loading" } : state} what="Progress" retry={reload} />;

  const ranges = (
    <nav className="ranges" aria-label="Range">
      {RANGES.map((r) => (
        <Link key={r} className="pill" href={hrefOf({ route: { section: "progress", view: "overview", range: r, week }, member: null })} go={go} current={r === range}>
          {RANGE_LABEL[r]}
        </Link>
      ))}
    </nav>
  );

  const nodes = {
    top: (
      <div className="top">
        <h1>Progress</h1>
        <ProgressViewNav who={who} viewing={viewing} current="overview" range={range} week={week} go={go} />
      </div>
    ),
    title: <ProgressViewHeader who={who} viewing={viewing} current="overview" range={range} week={week} go={go} />,
    hero: <DirectionHero view={view} ranges={ranges} range={range} week={week} go={go} />,
    signals: view.empty ? (
      <Text as="p" className="leftnote">{view.empty}</Text>
    ) : (
      <SignalGrid signals={view.signals} range={range} week={week} go={go} />
    ),
    next: <NextDrillDown next={view.next} range={range} week={week} go={go} />,
    comparison: view.comparison ? <ComparisonStrip comparison={view.comparison} /> : null,
    links: <DomainLinks range={range} week={week} go={go} />,
    evidence: state.kind === "ready" && !state.data.private ? <EvidenceTable summary={state.data.summary} /> : null,
  };

  return (
    <main className="screen progress summary">
      <Split wide={wide} specs={SUMMARY_PARTS} nodes={nodes} />
    </main>
  );
}

/** The Direction hero: whether the current choices are moving the member the way they want, with the period control. */
function DirectionHero({ view, ranges, range, week, go }: { view: ReturnType<typeof buildProgressSummary>; ranges: ReactNode; range: Range; week: string | null; go: (href: string) => void }) {
  const d = view.direction;
  return (
    <section className={`summary-hero direction-${d.kind} l-stack g-8`} aria-labelledby="summary-direction-title">
      <Text as="p" className="eyebrow">Current direction</Text>
      <Text as="h2" id="summary-direction-title">{d.title}</Text>
      <Text as="p" className="summary-observation">{d.observation}</Text>
      {d.href ? (
        <Link className="btn" href={hrefOf({ route: { section: "progress", view: d.href.view, range, week }, member: null })} go={go}>
          See the body detail
        </Link>
      ) : null}
      <>{ranges}</>
      <Text as="p" className="leftnote">Trends show association, not cause. Nutrition and training sit alongside the trend; they do not prove what moved it.</Text>
    </section>
  );
}

/** The five-signal grid, in the Worker's fixed order, body first. */
function SignalGrid({ signals, range, week, go }: { signals: SummarySignal[]; range: Range; week: string | null; go: (href: string) => void }) {
  return (
    <section className="summary-signals l-stack g-8" aria-label="Signals">
      <Text as="h2" className="visually-hidden">Signals</Text>
      <ol className="l-grid min-300 g-12">
        {signals.map((s) => (
          <SignalCard key={s.name} signal={s} range={range} week={week} go={go} />
        ))}
      </ol>
    </section>
  );
}

/** Each signal's drill-down view: body → Body, nutrition → Nutrition, review → Health. */
const SIGNAL_VIEW: Record<SummarySignal["name"], ProgressView | null> = { body: "body", strength: null, nutrition: "nutrition", review: "health" };

function SignalCard({ signal, range, week, go }: { signal: SummarySignal; range: Range; week: string | null; go: (href: string) => void }) {
  const view = SIGNAL_VIEW[signal.name];
  const body = (
    <>
      <Text as="h3" className="signal-title">{signal.title}</Text>
      <Text as="p" className="signal-value">{signal.value ?? "No data"}</Text>
      {signal.detail ? <Text as="p" className="signal-detail">{signal.detail}</Text> : null}
      {signal.note ? <Text as="p" className="leftnote">{signal.note}</Text> : null}
    </>
  );
  return (
    <li className={`signal-card l-stack g-4${signal.empty ? " empty" : ""}`}>
      {view ? (
        <Link className="signal-link l-stack g-4" href={hrefOf({ route: { section: "progress", view, range, week }, member: null })} go={go}>
          {body}
        </Link>
      ) : (
        body
      )}
    </li>
  );
}

/** One deterministic next drill-down, not a prescription. */
function NextDrillDown({ next, range, week, go }: { next: { view: ProgressView; reason: string }; range: Range; week: string | null; go: (href: string) => void }) {
  const label = next.view === "health" ? "Health" : next.view === "nutrition" ? "Nutrition" : "Body";
  return (
    <section className="summary-next l-stack g-8" aria-labelledby="summary-next-title">
      <Text as="h2" id="summary-next-title">Worth a closer look</Text>
      <Text as="p">{next.reason}</Text>
      <Link className="btn primary" href={hrefOf({ route: { section: "progress", view: next.view, range, week }, member: null })} go={go}>
        Open {label}
      </Link>
    </section>
  );
}

/** The prior-period comparison: how long it ran, and what the window before it was. */
function ComparisonStrip({ comparison }: { comparison: NonNullable<ReturnType<typeof buildProgressSummary>["comparison"]> }) {
  return (
    <section className="summary-comparison l-stack g-8" aria-labelledby="summary-comparison-title">
      <Text as="h2" id="summary-comparison-title">{comparison.label}</Text>
      <Text as="p">
        {comparison.days} days, {comparison.from} to {comparison.to}. Trends above are for the period shown; this is the equally long window before it.
      </Text>
    </section>
  );
}

/** Domain links: the drill-downs the summary does not carry itself. */
function DomainLinks({ range, week, go }: { range: Range; week: string | null; go: (href: string) => void }) {
  const links: { view: ProgressView; label: string }[] = [
    { view: "body", label: "Body" },
    { view: "nutrition", label: "Nutrition" },
    { view: "health", label: "Health" },
  ];
  return (
    <section className="summary-links l-stack g-8" aria-labelledby="summary-links-title">
      <Text as="h2" id="summary-links-title">In detail</Text>
      <div className="l-cluster g-8">
        {links.map((l) => (
          <Link key={l.view} className="btn" href={hrefOf({ route: { section: "progress", view: l.view, range, week }, member: null })} go={go}>
            {l.label}
          </Link>
        ))}
        <Link className="btn" href={hrefOf({ route: { section: "train", view: "lifts", lift: null }, member: null })} go={go}>
          Lifts
        </Link>
      </div>
    </section>
  );
}

/** The collapsible evidence: the raw read behind the summary, for the member who wants it. */
function EvidenceTable({ summary: s }: { summary: ProgressSummary }) {
  const rows = evidenceRows(s);
  return (
    <details className="summary-evidence">
      <summary>Evidence</summary>
      <table className="wide-table">
        <caption>
          <Text as="span">The read behind this summary: {s.period}, {day(s.from)} to {day(s.to)}</Text>
        </caption>
        <thead>
          <tr>
            <th scope="col">Signal</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">
                <Text as="span">{r.label}</Text>
              </th>
              <td>
                <Text as="span">{r.value}</Text>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** Flatten the five signals to labelled rows: the number behind each wording on the cards above. */
function evidenceRows(s: ProgressSummary): { label: string; value: string }[] {
  const body = s.signals.find((x) => x.name === "body")!;
  const strength = s.signals.find((x) => x.name === "strength")!;
  const nutrition = s.signals.find((x) => x.name === "nutrition")!;
  const review = s.signals.find((x) => x.name === "review")!;
  const rows: { label: string; value: string }[] = [
    { label: "Body metric", value: metricTitle(body.metric) },
    { label: "Latest reading", value: body.latest ? `${one(body.latest.value)} ${body.latest.unit} on ${day(body.latest.date)}` : "none" },
    { label: "Change over period", value: body.change === null ? "not enough readings" : `${signed(body.change)} over ${plural(body.reading_count, "reading", "readings")}` },
    { label: "Rate a week", value: body.rate_per_week === null ? "not known" : signed(body.rate_per_week) },
  ];
  for (const l of strength.lifts) {
    rows.push({ label: `Lift ${l.exercise}`, value: `${l.best_e1rm_kg === null ? "e1RM not known" : `best e1RM ${one(l.best_e1rm_kg)} kg`}${l.change_kg === null ? "" : ` (${signed(l.change_kg)} kg)`} over ${plural(l.sessions, "session", "sessions")}` });
  }
  rows.push(
    { label: "Logged days", value: `${nutrition.logged_days} of ${nutrition.days_in_window}${nutrition.coverage === null ? "" : ` (${pct(nutrition.coverage)})`}` },
    { label: "Average intake", value: nutrition.average_kcal === null ? "not known" : `${n(nutrition.average_kcal)} kcal a day` },
    { label: "Target", value: nutrition.target_kcal === null ? "no target stored" : `${n(nutrition.target_kcal)} kcal` },
    { label: "Open flags", value: String(review.open_flags) },
    { label: "Blood draws in period", value: String(review.blood_draws_in_period) },
    { label: "Latest reading", value: review.latest_reading_on === null ? "none recorded" : day(review.latest_reading_on) },
  );
  return rows;
}
