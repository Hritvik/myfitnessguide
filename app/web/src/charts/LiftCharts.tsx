import { day, n, qty } from "../format";
import type { LiftChartModel, VolumeChartModel } from "../lifts";
import { dateScale, linePath, linear, plot } from "./scale";

const W = 720;
const H = 260;
const tickAnchor = (index: number, count: number) => index === 0 ? "start" : index === count - 1 ? "end" : "middle";

export function LiftStrengthChart({ model }: { model: LiftChartModel }) {
  const p = plot(W, H);
  const x = dateScale(model.from, model.to, [p.left, p.right], true);
  const y = linear([model.y.min, model.y.max], [p.bottom, p.top], true);
  const at = (point: { date: string; value: number }) => ({ x: x(point.date), y: y(point.value) });
  return (
    <figure className="chart lift-chart">
      <h2>{model.title}</h2>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={model.summary}>
        {model.y.ticks.map((tick) => <g key={tick}><line x1={p.left} x2={p.right} y1={y(tick)} y2={y(tick)} stroke="var(--steel-2)" /><text x={p.left - 8} y={y(tick) + 4} textAnchor="end" fontSize="11" fill="var(--dim)">{qty(tick)}</text></g>)}
        {model.x.ticks.map((date, index) => <text key={date} x={x(date)} y={H - 8} textAnchor={tickAnchor(index, model.x.ticks.length)} fontSize="11" fill="var(--dim)">{day(date).slice(4)}</text>)}
        {model.goals.map((goal) => <g key={goal.date}><line x1={x(goal.date)} x2={x(goal.date)} y1={y(goal.value)} y2={y(goal.high ?? goal.value)} stroke="var(--ink)" strokeOpacity=".3" strokeWidth="3" /><circle cx={x(goal.date)} cy={y(goal.value)} r="3" fill="var(--card)" stroke="var(--ink)" strokeOpacity=".45" /></g>)}
        {model.segments.map((segment, index) => <path key={index} d={linePath(segment.map(at))} fill="none" stroke="var(--ink)" strokeWidth="2.5" />)}
        {model.points.map((point, index) => <circle key={`${point.date}-${index}`} cx={x(point.date)} cy={y(point.value)} r={point.draft ? 5 : 4} fill={point.draft ? "var(--card)" : "var(--haldi)"} stroke="var(--ink)" strokeWidth={point.draft ? 2 : 1} />)}
      </svg>
      <figcaption>{model.summary}</figcaption>
      <details><summary>Lift history data</summary><table><thead><tr><th scope="col">Date</th><th scope="col">e1RM</th><th scope="col">Top set</th><th scope="col">Volume</th><th scope="col">Note</th></tr></thead><tbody>{model.table.map((row, index) => <tr key={`${row.date}-${index}`}><td>{row.date}</td><td>{row.e1rm}</td><td>{row.topSet}</td><td>{row.volume}</td><td>{row.note || "—"}</td></tr>)}</tbody></table></details>
    </figure>
  );
}

export function VolumeChart({ model }: { model: VolumeChartModel }) {
  if (!model.from) return <p className="leftnote">No weekly volume yet.</p>;
  const p = plot(W, H);
  const x = dateScale(model.from, model.to, [p.left, p.right], true);
  const y = linear([model.y.min, model.y.max], [p.bottom, p.top], true);
  const width = Math.max(5, Math.min(32, (p.right - p.left) / Math.max(1, model.bars.length) - 4));
  return <figure className="chart lift-chart"><h2>{model.title}</h2><svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={model.summary}>
    {model.y.ticks.map((tick) => <g key={tick}><line x1={p.left} x2={p.right} y1={y(tick)} y2={y(tick)} stroke="var(--steel-2)" /><text x={p.left - 8} y={y(tick) + 4} textAnchor="end" fontSize="11" fill="var(--dim)">{n(tick)}</text></g>)}
    {model.bars.map((bar) => bar.value === null ? <line key={bar.date} x1={x(bar.date) - width / 2} x2={x(bar.date) + width / 2} y1={p.bottom - 2} y2={p.bottom - 2} stroke="var(--dim)" strokeDasharray="3 2" /> : <rect key={bar.date} x={x(bar.date) - width / 2} y={y(bar.value)} width={width} height={p.bottom - y(bar.value)} rx="2" fill={bar.incomplete ? "none" : "var(--ink)"} stroke="var(--ink)" strokeWidth={bar.incomplete ? 2 : 0} />)}
    {model.x.ticks.map((date, index) => <text key={date} x={x(date)} y={H - 8} textAnchor={tickAnchor(index, model.x.ticks.length)} fontSize="11" fill="var(--dim)">{day(date).slice(4)}</text>)}
  </svg><figcaption>{model.summary}</figcaption><details><summary>Weekly volume data</summary><table><thead><tr><th scope="col">Week</th><th scope="col">Sessions</th><th scope="col">Sets</th><th scope="col">Volume</th><th scope="col">Note</th></tr></thead><tbody>{model.table.map((row) => <tr key={row.date}><td>{row.date}</td><td>{row.sessions}</td><td>{row.sets}</td><td>{row.volume}</td><td>{row.note || "—"}</td></tr>)}</tbody></table></details></figure>;
}
