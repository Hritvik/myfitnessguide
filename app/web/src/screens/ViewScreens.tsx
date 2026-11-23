import { useMemo } from "react";
import { callTool } from "../api";
import { FoodCost } from "../charts/CostChart";
import { DailyChart } from "../charts/DailyChart";
import { SplitChart } from "../charts/SplitChart";
import { LiftStrengthChart, VolumeChart } from "../charts/LiftCharts";
import { Link } from "../components/Shell";
import { StateScreen } from "../components/Parts";
import { Text } from "../components/layout/Text";
import { useLoad, type Loaded } from "../hooks";
import { loadLifts, loadNutrition, type LiftsData, type Who } from "../load";
import { buildLiftDetail, buildLiftList } from "../lifts";
import { buildNutrition, type NutritionData, type NutritionView } from "../nutrition";
import { hrefOf, type ProgressView, type Range } from "../route";

type Go = (href: string) => void;

const memberOf = (who: Who, viewing: string): string | null => (viewing === who.member ? null : viewing);

export function ProgressViewNav({
  who,
  viewing,
  current,
  range,
  week,
  go,
}: {
  who: Who;
  viewing: string;
  current: ProgressView;
  range: Range;
  week: string | null;
  go: Go;
}) {
  const views: readonly { view: ProgressView; label: string }[] =
    viewing === who.member
      ? [
          { view: "overview", label: "Summary" },
          { view: "body", label: "Body" },
          { view: "nutrition", label: "Nutrition" },
          { view: "health", label: "Health" },
        ]
      : [{ view: "nutrition", label: "Nutrition" }];
  return (
    <nav className="ranges" aria-label="Progress views">
      {views.map(({ view, label }) => (
        <Link
          key={view}
          className="pill"
          href={hrefOf({ route: { section: "progress", view, range, week }, member: memberOf(who, viewing) })}
          go={go}
          current={view === current}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

/** Shared page heading: wide and phone layouts must expose the same view switcher. */
export function ProgressViewHeader({
  who,
  viewing,
  current,
  range,
  week,
  go,
}: {
  who: Who;
  viewing: string;
  current: ProgressView;
  range: Range;
  week: string | null;
  go: Go;
}) {
  return (
    <div className="top">
      <h1>{current === "overview" ? "Progress" : current === "body" ? "Body" : current === "nutrition" ? "Nutrition" : "Health"}</h1>
      <ProgressViewNav who={who} viewing={viewing} current={current} range={range} week={week} go={go} />
    </div>
  );
}

export function TrainViewNav({ who, viewing, current, go }: { who: Who; viewing: string; current: "session" | "lifts"; go: Go }) {
  const member = memberOf(who, viewing);
  return (
    <nav className="ranges" aria-label="Training views">
      <Link className="pill" href={hrefOf({ route: { section: "train", view: "session" }, member })} go={go} current={current === "session"}>
        Session
      </Link>
      <Link className="pill" href={hrefOf({ route: { section: "train", view: "lifts", lift: null }, member })} go={go} current={current === "lifts"}>
        Lifts
      </Link>
    </nav>
  );
}

/** Nutrition ranges are relative to the household day, so an overnight change must invalidate the cached screen. */
export const nutritionScreenKey = (who: Who, viewing: string, range: Range): string => `nutrition|${viewing}|${range}|${who.today}`;

export function NutritionScreen({ who, viewing, range, week, go }: { who: Who; viewing: string; range: Range; week: string | null; go: Go }) {
  const { state, reload } = useLoad(
    () => loadNutrition((tool, input) => callTool(tool, input), { who, viewing, range }),
    nutritionScreenKey(who, viewing, range),
  );
  return (
    <NutritionDashboard who={who} viewing={viewing} range={range} week={week} go={go} state={state} retry={reload} />
  );
}

const RANGES: readonly { range: Range; label: string }[] = [
  { range: "4w", label: "4 weeks" },
  { range: "12w", label: "12 weeks" },
  { range: "6m", label: "6 months" },
  { range: "1y", label: "1 year" },
  { range: "all", label: "All" },
];

function ReadState<T>({ state, retry, what, label }: { state: Exclude<Loaded<T>, { kind: "ready" }>; retry: () => void; what: string; label: string }) {
  if (state.kind === "loading") {
    return (
      <section className="nutrition-state l-stack g-8" aria-busy="true" aria-live="polite">
        <Text as="p" role="status">Loading {what}…</Text>
      </section>
    );
  }
  if (state.kind === "offline") {
    return (
      <section className="nutrition-state l-stack g-8" aria-live="polite">
        <h2>You're offline</h2>
        <Text as="p" role="status">{label} needs a connection to load. It will try again when you're back online.</Text>
        <button type="button" className="btn" onClick={retry}>Try again</button>
      </section>
    );
  }
  if (state.kind === "signed_out") {
    return (
      <section className="nutrition-state l-stack g-8" role="alert">
        <h2>Sign in again</h2>
        <p>Your sign-in has expired, or this account isn't one of the household's members.</p>
        <button type="button" className="btn" onClick={() => location.reload()}>Sign in again</button>
      </section>
    );
  }
  return (
    <section className="nutrition-state l-stack g-8" role="alert">
      <Text as="h2">{label} didn't load</Text>
      <Text as="p" className="error-text">{state.message}</Text>
      <button type="button" className="btn" onClick={retry}>Try again</button>
    </section>
  );
}

function NutritionSummary({ view }: { view: NutritionView }) {
  return (
    <section className="nutrition-summary l-stack g-8" aria-labelledby="nutrition-summary-title">
      <h2 id="nutrition-summary-title">At a glance</h2>
      <ul className="l-stack g-8">
        {view.charts.map((chart) => <Text as="li" key={chart.key}>{chart.summary}</Text>)}
        <Text as="li">{view.split.summary}</Text>
        <Text as="li">{view.cost.daily.summary}</Text>
        <Text as="li">{view.cost.per25.summary}</Text>
      </ul>
      {view.cost.empty ? <Text as="p" className="leftnote">{view.cost.empty}.</Text> : null}
    </section>
  );
}

function NutritionWeeks({ view }: { view: NutritionView }) {
  const partial = view.weekly.some((row) => row.failed);
  return (
    <section className="nutrition-weekly l-stack g-8" aria-labelledby="nutrition-weeks-title">
      <h2 id="nutrition-weeks-title">By week</h2>
      {partial ? <p className="banner" role="status">Some history could not be loaded. The available weeks are still shown.</p> : null}
      <div className="nutrition-table-scroll" tabIndex={0} aria-label="Scrollable weekly nutrition table">
        <table className="wide-table nutrition-weeks">
          <caption>Weekly nutrition averages</caption>
          <thead>
            <tr>
              <th scope="col">Week</th>
              <th scope="col">Days</th>
              <th scope="col">Calories</th>
              <th scope="col">Protein</th>
              <th scope="col">Carbs</th>
              <th scope="col">Fat</th>
              <th scope="col">Split P · C · F</th>
              <th scope="col">Cost</th>
              <th scope="col">₹ / 25 g protein</th>
            </tr>
          </thead>
          <tbody>
            {view.weekly.map((row) => row.failed ? (
              <tr key={row.key}>
                <th scope="row"><Text>{row.week}</Text></th>
                <td colSpan={8}><Text>{row.days}</Text></td>
              </tr>
            ) : (
              <tr key={row.key}>
                <th scope="row"><Text>{row.week}</Text></th>
                <Text as="td">{row.days}</Text>
                <Text as="td">{row.kcal}</Text>
                <Text as="td">{row.protein}</Text>
                <Text as="td">{row.carbs}</Text>
                <Text as="td">{row.fat}</Text>
                <Text as="td">{row.split}</Text>
                <Text as="td">{row.cost}</Text>
                <Text as="td">{row.per25}</Text>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Presentation boundary: screen states and loaded nutrition can be verified without network or hook mocks. */
export function NutritionDashboard({
  who,
  viewing,
  range,
  week,
  go,
  state,
  retry,
}: {
  who: Who;
  viewing: string;
  range: Range;
  week: string | null;
  go: Go;
  state: Loaded<NutritionData>;
  retry: () => void;
}) {
  const view = useMemo(() => state.kind === "ready" ? buildNutrition(state.data) : null, [state]);
  const member = memberOf(who, viewing);
  return (
    <main className="screen progress nutrition">
      <div className="top">
        <h1>Nutrition</h1>
        <ProgressViewNav who={who} viewing={viewing} current="nutrition" range={range} week={week} go={go} />
        <nav className="ranges" aria-label="Nutrition range">
          {RANGES.map((item) => (
            <Link
              key={item.range}
              className="pill"
              href={hrefOf({ route: { section: "progress", view: "nutrition", range: item.range, week }, member })}
              go={go}
              current={item.range === range}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
      {state.kind !== "ready" ? <ReadState state={state} retry={retry} what="nutrition history" label="Nutrition" /> : view?.empty ? (
        <Text as="p" className="leftnote" role="status">{view.empty}</Text>
      ) : view ? (
        <>
          {view.notice ? <Text as="p" className="banner" role="status">{view.notice}</Text> : null}
          <NutritionSummary view={view} />
          <section className="nutrition-charts l-stack g-16" aria-label="Nutrition charts">
            {view.charts.map((chart) => <DailyChart key={chart.key} chart={chart} />)}
            <SplitChart model={view.split} />
            <FoodCost model={view.cost} />
          </section>
          <NutritionWeeks view={view} />
        </>
      ) : null}
    </main>
  );
}

export function PrivateProgressScreen({
  who,
  viewing,
  view,
  range,
  week,
  message,
  go,
}: {
  who: Who;
  viewing: string;
  view: "overview" | "body" | "health";
  range: Range;
  week: string | null;
  message: string;
  go: Go;
}) {
  return (
    <StateScreen title={view === "health" ? "Health" : "Progress"}>
      <ProgressViewNav who={who} viewing={viewing} current={view} range={range} week={week} go={go} />
      <Text as="p">{message}</Text>
    </StateScreen>
  );
}

export function LiftsScreen({ who, viewing, exerciseId = null, unknown = false, go }: { who: Who; viewing: string; exerciseId?: number | null; unknown?: boolean; go: Go }) {
  const { state, reload } = useLoad(() => loadLifts((tool, input) => callTool(tool, input), { viewing, exerciseId }), `lifts|${viewing}|${exerciseId ?? "all"}`);
  return <LiftsDashboard who={who} viewing={viewing} exerciseId={exerciseId} unknown={unknown} go={go} state={state} retry={reload} />;
}

export function LiftsDashboard({ who, viewing, exerciseId, unknown, go, state, retry }: { who: Who; viewing: string; exerciseId: number | null; unknown: boolean; go: Go; state: Loaded<LiftsData>; retry: () => void }) {
  const list = useMemo(() => state.kind === "ready" ? buildLiftList(state.data.list) : null, [state]);
  const detail = useMemo(() => state.kind === "ready" && state.data.detail ? buildLiftDetail(state.data.detail) : null, [state]);
  const member = memberOf(who, viewing);
  return (
    <main className="screen train lifts">
      <div className="top">
        <h1>Lifts</h1>
        <TrainViewNav who={who} viewing={viewing} current="lifts" go={go} />
      </div>
      {state.kind !== "ready" ? <ReadState state={state} retry={retry} what="lift history" label="Lift history" /> : list ? <>
        {unknown ? <p className="banner" role="status">That lift link isn't valid. Choose a lift below.</p> : null}
        <div className="lift-layout l-lift-layout">
          <section className="lift-index l-stack g-8" aria-labelledby="lift-index-title">
            <h2 id="lift-index-title">Your lifts</h2>
            {list.empty ? <Text as="p" className="leftnote">{list.empty}</Text> : <ul className="l-stack g-4">{list.lifts.map((lift) => <li key={lift.id}><Link className="lift-row l-lift-row" href={hrefOf({ route: { section: "train", view: "lifts", lift: lift.id, slug: lift.slug }, member })} go={go} current={lift.id === exerciseId}><span><Text as="b">{lift.name}</Text><Text as="span" className="meta">{lift.lastDone} · {lift.sessions}</Text></span><span><Text as="b">{lift.signal}</Text>{lift.goal ? <Text as="span" className="meta">{lift.goal}</Text> : lift.note ? <Text as="span" className="meta">{lift.note}</Text> : null}</span></Link></li>)}</ul>}
          </section>
          <section className="lift-focus l-stack g-16" aria-live="polite">
            {detail ? <><header className="lift-hero l-cluster"><div><p className="eyebrow">Current direction</p><Text as="h2">{detail.title}</Text></div><Text as="b" className="lift-insight">{detail.insight}</Text></header><LiftStrengthChart model={detail.chart} />{detail.methodChanges.length ? <div><h3>Method changes</h3><ul>{detail.methodChanges.map((change) => <Text as="li" key={change}>{change}</Text>)}</ul></div> : null}{detail.bodyweightGoals.map((goal) => <Text as="p" className="leftnote" key={goal}>{goal}</Text>)}</> : <><header className="lift-hero l-cluster"><div><p className="eyebrow">Training pattern</p><h2>Across all lifts</h2></div></header><VolumeChart model={list.volume} /></>}
          </section>
        </div>
      </> : null}
    </main>
  );
}
