import { day } from "../format";
import type { CostModel } from "../nutrition";
import { breakAtFailedRanges, chartWidth, dayBar, dayWidth, stepPaths } from "./bars";
import { MeasuredChart } from "./measure";
import { dateScale, linear, plot } from "./scale";

const HEIGHT = 160;
const FONT_SIZE = 11;
const rupee = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
type Daily = CostModel["daily"];
type Per25 = CostModel["per25"];
type CostChartProps = { chart: Daily; kind: "daily"; width?: number } | { chart: Per25; kind: "per25"; width?: number };

export function costGeometry(chart: Daily | Per25, requestedWidth: number) {
  const width = chartWidth(requestedWidth);
  const area = plot(width, HEIGHT);
  if (!chart.from || !chart.to) return { width, height: HEIGHT, fontSize: FONT_SIZE, plot: area, dayWidth: 0, bars: [], failed: [], minPaths: [], maxPaths: [], x: () => area.left, y: () => area.bottom };
  const oneDay = dayWidth(chart.from, chart.to, area.left, area.right);
  const x = dateScale(chart.from, chart.to, [area.left + oneDay / 2, area.right - oneDay / 2], true);
  const y = linear([chart.y.min, chart.y.max], [area.bottom, area.top], true);
  const failed = chart.failed.map((gap) => ({ ...gap, x: x(gap.from) - oneDay / 2, width: Math.max(0, x(gap.to) - x(gap.from) + oneDay) }));
  const bars = "bars" in chart ? chart.bars.map((bar) => {
    const box = dayBar(x, bar.date, oneDay);
    const minY = y(bar.min);
    const maxY = y(bar.max);
    return { ...bar, ...box, minY, maxY, height: Math.max(1, minY - maxY) };
  }) : [];
  const minPaths = "points" in chart ? stepPaths(breakAtFailedRanges(chart.weeks.map((week) => ({ ...week, value: week.min })), chart.failed), x, y, oneDay) : [];
  const maxPaths = "points" in chart ? stepPaths(breakAtFailedRanges(chart.weeks.map((week) => ({ ...week, value: week.max })), chart.failed), x, y, oneDay) : [];
  return { width, height: HEIGHT, fontSize: FONT_SIZE, plot: area, dayWidth: oneDay, bars, failed, minPaths, maxPaths, x, y };
}

/** Food cost keeps missing prices and failed history visible instead of implying exact totals. */
export function FoodCost({ model, width }: { model: CostModel; width?: number }) {
  return <section className="food-cost" aria-labelledby="food-cost-title">
    <h2 id="food-cost-title">Food cost</h2>
    {model.empty ? <p className="leftnote" role="status">{model.empty}</p> : <>
      <CostChart chart={model.daily} kind="daily" width={width} />
      <CostChart chart={model.per25} kind="per25" width={width} />
    </>}
  </section>;
}

export function CostChart(props: CostChartProps) {
  const { chart, kind, width } = props;
  return <figure className="chart cost">
    <h3>{chart.title}</h3>
    {!chart.from || !chart.to ? <p role="status" className="leftnote">No cost data in this range.</p> : (
      <MeasuredChart width={width}>{(drawingWidth) => kind === "daily"
        ? <DailyCostGraphic chart={chart} width={drawingWidth} />
        : <Per25Graphic chart={chart} width={drawingWidth} />}
      </MeasuredChart>
    )}
    <figcaption>{chart.summary}</figcaption>
    {kind === "daily" ? <DailyCostTable chart={chart} /> : <Per25Table chart={chart} />}
  </figure>;
}

function Grid({ ticks, y, left, right }: { ticks: number[]; y: (value: number) => number; left: number; right: number }) {
  return <>{ticks.map((tick) => <g key={tick}>
    <line x1={left} x2={right} y1={y(tick)} y2={y(tick)} stroke="var(--steel-2)" strokeWidth="1" />
    <text x={left - 6} y={y(tick) + 4} textAnchor="end" fontSize={FONT_SIZE} fill="var(--dim)">₹{rupee.format(tick)}</text>
  </g>)}</>;
}

function FailedGaps({ gaps, top, bottom }: { gaps: ReturnType<typeof costGeometry>["failed"]; top: number; bottom: number }) {
  return <>{gaps.map((gap) => <g key={gap.from}>
    <rect x={gap.x} y={top} width={gap.width} height={bottom - top} fill="var(--steel)" />
    {gap.width >= 72 ? <text x={gap.x + gap.width / 2} y={(top + bottom) / 2} textAnchor="middle" fontSize={FONT_SIZE} fill="var(--dim)">Couldn't load</text> : null}
  </g>)}</>;
}

function DailyCostGraphic({ chart, width }: { chart: Daily; width: number }) {
  const g = costGeometry(chart, width);
  return <svg viewBox={`0 0 ${g.width} ${g.height}`} width="100%" role="img" aria-label={chart.summary}>
    <Grid ticks={chart.y.ticks} y={g.y} left={g.plot.left} right={g.plot.right} />
    {chart.weeks.map((week) => week.min === null || week.max === null ? null : <rect key={week.from} x={g.x(week.from) - g.dayWidth / 2} y={g.y(week.max)} width={g.x(week.to) - g.x(week.from) + g.dayWidth} height={Math.max(1, g.y(week.min) - g.y(week.max))} fill="var(--steel)" />)}
    {g.bars.map((bar) => bar.atLeast
      ? <path key={bar.date} d={`M${bar.x.toFixed(1)} ${bar.maxY.toFixed(1)} V${bar.minY.toFixed(1)} H${(bar.x + bar.width).toFixed(1)} V${bar.maxY.toFixed(1)}`} fill="none" stroke="var(--ink)" strokeOpacity="0.6"><title>at least</title></path>
      : <rect key={bar.date} x={bar.x} y={bar.maxY} width={bar.width} height={bar.height} fill="var(--steel-2)" />)}
    <FailedGaps gaps={g.failed} top={g.plot.top} bottom={g.plot.bottom} />
    {chart.x.ticks.map((tick) => <text key={tick} x={g.x(tick)} y={g.height - 8} textAnchor="middle" fontSize={g.fontSize} fill="var(--dim)">{day(tick).slice(4)}</text>)}
  </svg>;
}

function Per25Graphic({ chart, width }: { chart: Per25; width: number }) {
  const g = costGeometry(chart, width);
  return <svg viewBox={`0 0 ${g.width} ${g.height}`} width="100%" role="img" aria-label={chart.summary}>
    <Grid ticks={chart.y.ticks} y={g.y} left={g.plot.left} right={g.plot.right} />
    {g.minPaths.map((path, index) => <path key={`min-${index}`} d={path} fill="none" stroke="var(--ink)" strokeWidth="1.5" />)}
    {g.maxPaths.map((path, index) => <path key={`max-${index}`} d={path} fill="none" stroke="var(--ink)" strokeDasharray="3 3" strokeWidth="1.5" />)}
    {chart.points.map((point) => <line key={point.date} x1={g.x(point.date)} x2={g.x(point.date)} y1={g.y(point.min)} y2={g.y(point.max)} stroke="var(--dim)" strokeWidth="3" strokeLinecap="round" />)}
    <FailedGaps gaps={g.failed} top={g.plot.top} bottom={g.plot.bottom} />
    {chart.x.ticks.map((tick) => <text key={tick} x={g.x(tick)} y={g.height - 8} textAnchor="middle" fontSize={g.fontSize} fill="var(--dim)">{day(tick).slice(4)}</text>)}
  </svg>;
}

function DailyCostTable({ chart }: { chart: Daily }) {
  return <details><summary>Data</summary><table><thead><tr><th scope="col">Date</th><th scope="col">Cost</th><th scope="col">Note</th></tr></thead>
    <tbody>{chart.table.map((row) => <tr key={row.iso}><td>{row.date}</td><td>{row.cost}</td><td>{row.note}</td></tr>)}</tbody></table></details>;
}

function Per25Table({ chart }: { chart: Per25 }) {
  return <details><summary>Data</summary><table><thead><tr><th scope="col">Week</th><th scope="col">₹ per 25 g protein</th></tr></thead>
    <tbody>{chart.table.map((row) => <tr key={row.key}><td>{row.week}</td><td>{row.value}</td></tr>)}</tbody></table></details>;
}
