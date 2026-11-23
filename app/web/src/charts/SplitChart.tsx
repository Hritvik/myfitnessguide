import type { SplitModel } from "../nutrition";
import { chartWidth } from "./bars";
import { MeasuredChart } from "./measure";

const ROW_HEIGHT = 24;
const LABEL_WIDTH = 76;
const FONT_SIZE = 11;
const COLORS = { protein: "var(--ink)", carbs: "var(--steel-2)", fat: "var(--dim)" } as const;
const TEXT = { protein: "var(--bg)", carbs: "var(--ink)", fat: "var(--bg)" } as const;

export function splitGeometry(model: SplitModel, requestedWidth: number) {
  const width = chartWidth(requestedWidth);
  const legendHeight = 24;
  const height = Math.max(56, model.weeks.length * ROW_HEIGHT + legendHeight);
  const span = Math.max(1, width - LABEL_WIDTH - 4);
  const keys = ["protein", "carbs", "fat"] as const;
  return {
    width, height, fontSize: FONT_SIZE, labelWidth: LABEL_WIDTH,
    rows: model.weeks.map((week, index) => {
      const segments = week.shares ? keys.map((key, keyIndex) => ({
        key,
        x: LABEL_WIDTH + span * keys.slice(0, keyIndex).reduce((sum, previous) => sum + week.shares![previous], 0),
        width: span * week.shares![key],
        share: week.shares![key],
      })) : [];
      return { ...week, y: index * ROW_HEIGHT + 4, segments };
    }),
  };
}

/** Weekly share of macro-derived calories, including unavailable and insufficient-data weeks. */
export function SplitChart({ model, width }: { model: SplitModel; width?: number }) {
  return <figure className="chart macro-split">
    <h3>{model.title}</h3>
    {model.weeks.length === 0 ? <p role="status" className="leftnote">No weekly macro split in this range.</p> : (
      <MeasuredChart width={width}>{(drawingWidth) => <SplitGraphic model={model} width={drawingWidth} />}</MeasuredChart>
    )}
    <figcaption>{model.summary}</figcaption>
    <details><summary>Data</summary><table>
      <thead><tr><th scope="col">Week</th><th scope="col">Split</th></tr></thead>
      <tbody>{model.weeks.map((week) => <tr key={week.key}><td>{week.label}</td><td>{week.text}</td></tr>)}</tbody>
    </table></details>
  </figure>;
}

function SplitGraphic({ model, width }: { model: SplitModel; width: number }) {
  const g = splitGeometry(model, width);
  return <svg viewBox={`0 0 ${g.width} ${g.height}`} width="100%" role="img" aria-label={model.summary}>
    {g.rows.map((row) => <g key={row.key}>
      <text x={g.labelWidth - 6} y={row.y + 14} textAnchor="end" fontSize={g.fontSize} fill="var(--dim)">{row.label}</text>
      {row.shares ? row.segments.map((segment) => <g key={segment.key}>
        <rect x={segment.x} y={row.y} width={segment.width} height={ROW_HEIGHT - 6} fill={COLORS[segment.key]} />
        {segment.width >= 34 ? <text x={segment.x + segment.width / 2} y={row.y + 13} textAnchor="middle" fontSize="10" fill={TEXT[segment.key]}>{Math.round(segment.share * 100)}%</text> : null}
      </g>) : <text x={g.labelWidth + 4} y={row.y + 13} fontSize={g.fontSize} fill="var(--dim)">{row.text.toLowerCase()}</text>}
    </g>)}
    <g fontSize="10" fill="var(--dim)">
      <rect x={g.labelWidth} y={g.height - 14} width="10" height="10" fill={COLORS.protein} /><text x={g.labelWidth + 14} y={g.height - 5}>protein</text>
      <rect x={g.labelWidth + 70} y={g.height - 14} width="10" height="10" fill={COLORS.carbs} /><text x={g.labelWidth + 84} y={g.height - 5}>carbs</text>
      <rect x={g.labelWidth + 130} y={g.height - 14} width="10" height="10" fill={COLORS.fat} /><text x={g.labelWidth + 144} y={g.height - 5}>fat</text>
    </g>
  </svg>;
}
