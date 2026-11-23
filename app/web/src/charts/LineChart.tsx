import { dateScale, linePath, linear, plot } from "./scale";
import { day } from "../format";
import type { ChartModel } from "../progress";

const W = 358;
const H = 180;

/** A to-scale line chart: phase band, value grid, goals in ink at low emphasis, readings in ink, the latest in haldi. With its text equivalent. */
export function LineChart({ chart }: { chart: ChartModel }) {
  const p = plot(W, H);
  const x = dateScale(chart.from, chart.to, [p.left, p.right], true);
  const y = linear([chart.y.min, chart.y.max], [p.bottom, p.top], true);
  const at = (d: string, v: number) => ({ x: x(d), y: y(v) });
  const dot = (d: string, v: number) => {
    const q = at(d, v);
    return { cx: q.x, cy: q.y };
  };
  const fmt = new Intl.NumberFormat("en-IN", { minimumFractionDigits: chart.y.decimals, maximumFractionDigits: chart.y.decimals });
  return (
    <figure className="chart">
      <h3>{chart.title}</h3>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={chart.summary}>
        {chart.phase ? (
          <rect x={x(chart.phase.from)} y={p.top} width={Math.max(0, x(chart.phase.to) - x(chart.phase.from))} height={p.bottom - p.top} fill="var(--steel)" />
        ) : null}
        {chart.y.ticks.map((t) => (
          <g key={t}>
            <line x1={p.left} x2={p.right} y1={y(t)} y2={y(t)} stroke="var(--steel-2)" strokeWidth="1" />
            <text x={p.left - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--dim)">
              {fmt.format(t)}
            </text>
          </g>
        ))}
        {chart.x.ticks.map((d) => (
          <text key={d} x={x(d)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--dim)">
            {day(d).slice(4)}
          </text>
        ))}
        {chart.goals.length > 1 ? <path d={linePath(chart.goals.map((g) => at(g.date, g.value)))} fill="none" stroke="var(--ink)" strokeOpacity="0.35" strokeDasharray="4 4" strokeWidth="1.5" /> : null}
        {chart.goals.map((g) => (
          <g key={`g${g.date}`}>
            {g.high !== undefined ? <line x1={at(g.date, g.value).x} x2={at(g.date, g.value).x} y1={y(g.value)} y2={y(g.high)} stroke="var(--ink)" strokeOpacity="0.35" strokeWidth="2" /> : null}
            <circle {...dot(g.date, g.value)} r="2.5" fill="none" stroke="var(--ink)" strokeOpacity="0.35" />
          </g>
        ))}
        {chart.segments.map((s, i) => (
          <path key={i} d={linePath(s.map((pt) => at(pt.date, pt.value)))} fill="none" stroke="var(--ink)" strokeWidth="2" />
        ))}
        {chart.segments.flat().map((pt) => (
          <circle key={`r${pt.date}`} {...dot(pt.date, pt.value)} r="3" fill="var(--ink)" />
        ))}
        {chart.current ? <circle {...dot(chart.current.date, chart.current.value)} r="5" fill="var(--haldi)" stroke="var(--ink)" strokeWidth="1" /> : null}
      </svg>
      <figcaption>{chart.summary}</figcaption>
      <details>
        <summary>Data</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Reading</th>
              <th scope="col">Goal</th>
            </tr>
          </thead>
          <tbody>
            {chart.table.map((r) => (
              <tr key={r.date}>
                <td>{r.date}</td>
                <td>{r.reading ?? "—"}</td>
                <td>{r.goal ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
