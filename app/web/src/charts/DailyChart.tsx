import { day } from "../format";
import type { DailyChartModel } from "../nutrition";
import { breakAtFailedRanges, chartWidth, dayBar, dayWidth, stepPaths } from "./bars";
import { MeasuredChart } from "./measure";
import { dateScale, linear, plot } from "./scale";

const HEIGHT = 180;
const FONT_SIZE = 11;
const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

export function dailyGeometry(chart: DailyChartModel, requestedWidth: number) {
  const width = chartWidth(requestedWidth);
  const area = plot(width, HEIGHT);
  if (!chart.from || !chart.to) return { width, height: HEIGHT, fontSize: FONT_SIZE, plot: area, dayWidth: 0, bars: [], failed: [], weekPaths: [], targetPaths: [], x: () => area.left, y: () => area.bottom };
  const oneDay = dayWidth(chart.from, chart.to, area.left, area.right);
  const x = dateScale(chart.from, chart.to, [area.left + oneDay / 2, area.right - oneDay / 2], true);
  const y = linear([chart.y.min, chart.y.max], [area.bottom, area.top], true);
  const bars = chart.bars.map((bar) => {
    const box = dayBar(x, bar.date, oneDay);
    const rawTop = bar.value === null ? area.bottom : y(bar.value);
    const height = bar.value === null ? 0 : Math.max(1, area.bottom - rawTop);
    return { ...bar, ...box, y: area.bottom - height, height, kind: bar.mark };
  });
  const failed = chart.failed.map((gap) => ({ ...gap, x: x(gap.from) - oneDay / 2, width: Math.max(0, x(gap.to) - x(gap.from) + oneDay) }));
  return {
    width, height: HEIGHT, fontSize: FONT_SIZE, plot: area, dayWidth: oneDay, bars, failed,
    weekPaths: stepPaths(breakAtFailedRanges(chart.weeks, chart.failed), x, y, oneDay),
    targetPaths: stepPaths(breakAtFailedRanges(chart.weeks.map((week) => ({ ...week, value: week.target })), chart.failed), x, y, oneDay),
    x, y,
  };
}

/** Daily nutrition, weekly averages/targets, honest coverage marks and the equivalent data table. */
export function DailyChart({ chart, width }: { chart: DailyChartModel; width?: number }) {
  return (
    <figure className="chart daily">
      <h3>{chart.title}</h3>
      {!chart.from || !chart.to ? <p role="status" className="leftnote">No daily data in this range.</p> : (
        <MeasuredChart width={width}>{(drawingWidth) => <DailyGraphic chart={chart} width={drawingWidth} />}</MeasuredChart>
      )}
      <figcaption>{chart.summary}</figcaption>
      <DailyTable chart={chart} />
    </figure>
  );
}

function DailyGraphic({ chart, width }: { chart: DailyChartModel; width: number }) {
  const g = dailyGeometry(chart, width);
  return (
    <svg viewBox={`0 0 ${g.width} ${g.height}`} width="100%" role="img" aria-label={chart.summary}>
      {chart.y.ticks.map((tick) => <g key={tick}>
        <line x1={g.plot.left} x2={g.plot.right} y1={g.y(tick)} y2={g.y(tick)} stroke="var(--steel-2)" strokeWidth="1" />
        <text x={g.plot.left - 6} y={g.y(tick) + 4} textAnchor="end" fontSize={g.fontSize} fill="var(--dim)">{number.format(tick)}</text>
      </g>)}
      {g.failed.map((gap) => <g key={gap.from}>
        <rect x={gap.x} y={g.plot.top} width={gap.width} height={g.plot.bottom - g.plot.top} fill="var(--steel)" />
        {gap.width >= 72 ? <text x={gap.x + gap.width / 2} y={(g.plot.top + g.plot.bottom) / 2} textAnchor="middle" fontSize={g.fontSize} fill="var(--dim)">Couldn't load</text> : null}
      </g>)}
      {g.bars.map((bar) => {
        if (bar.kind === "unlogged") return <line key={bar.date} x1={bar.x} x2={bar.x + bar.width} y1={g.plot.bottom + 4} y2={g.plot.bottom + 4} stroke="var(--dim)" strokeDasharray="2 2"><title>not logged</title></line>;
        if (bar.value === null) return null;
        const title = bar.label ? <title>{bar.label}</title> : null;
        if (bar.kind === "filled") return <rect key={bar.date} x={bar.x} y={bar.y} width={bar.width} height={bar.height} fill="var(--steel-2)">{title}</rect>;
        if (bar.kind === "outline") return <rect key={bar.date} x={bar.x} y={bar.y} width={bar.width} height={bar.height} fill="none" stroke="var(--ink)" strokeOpacity="0.6">{title}</rect>;
        return <path key={bar.date} d={`M${bar.x.toFixed(1)} ${bar.y.toFixed(1)} V${g.plot.bottom} H${(bar.x + bar.width).toFixed(1)} V${bar.y.toFixed(1)}`} fill="none" stroke="var(--ink)" strokeOpacity="0.6">{title}</path>;
      })}
      {chart.withTarget ? g.targetPaths.map((path, index) => <path key={`target-${index}`} d={path} fill="none" stroke="var(--ink)" strokeOpacity="0.35" strokeDasharray="4 4" strokeWidth="1.5" />) : null}
      {g.weekPaths.map((path, index) => <path key={`week-${index}`} d={path} fill="none" stroke="var(--ink)" strokeWidth="2" />)}
      {chart.x.ticks.map((tick) => <text key={tick} x={g.x(tick)} y={g.height - 8} textAnchor="middle" fontSize={g.fontSize} fill="var(--dim)">{day(tick).slice(4)}</text>)}
    </svg>
  );
}

function DailyTable({ chart }: { chart: DailyChartModel }) {
  return <details><summary>Data</summary><table>
    <thead><tr><th scope="col">Date</th><th scope="col">{chart.title.replace(" vs target", "")}</th>{chart.withTarget ? <th scope="col">Target</th> : null}<th scope="col">Note</th></tr></thead>
    <tbody>{chart.table.map((row) => <tr key={row.iso}><td>{row.date}</td><td>{row.value}</td>{chart.withTarget ? <td>{row.target}</td> : null}<td>{row.note}</td></tr>)}</tbody>
  </table></details>;
}
