import type { PlateLayout } from "../plates";

const W = 14;
const GAP = 3;
const H = 56;
const TOP = 12;
const LABELS = 34;
const FONT = 9;

/**
 * One side of the bar: the bar's label above, the sleeve, the collar, then the plates in loading order,
 * each labelled in its own unit beneath it. kg plates in ink, lb plates in steel.
 */
export function PlateDiagram({ layout }: { layout: PlateLayout }) {
  const barWidth = layout.bar ? layout.bar.length * 5 + 4 : 0;
  const width = Math.max(28 + layout.plates.length * (W + GAP) + (layout.hidden > 0 ? 28 : 8), barWidth);
  const mid = TOP + H / 2;
  const bottom = TOP + H + 6;
  return (
    <figure className="plates">
      <svg viewBox={`0 0 ${width} ${TOP + H + LABELS}`} width={width} height={TOP + H + LABELS} role="img" aria-label={layout.text}>
        {layout.bar ? (
          <text x="0" y={FONT} fontSize={FONT} fill="var(--dim)">
            {layout.bar}
          </text>
        ) : null}
        <line x1="0" y1={mid} x2={width} y2={mid} stroke="var(--steel-2)" strokeWidth="6" strokeLinecap="round" />
        <rect x="18" y={mid - 10} width="6" height="20" rx="1" fill="var(--dim)" />
        {layout.plates.map((p, i) => {
          const h = Math.max(12, p.height * H);
          const x = 28 + i * (W + GAP);
          return (
            <g key={i}>
              <rect x={x} y={mid - h / 2} width={W} height={h} rx="2" fill={p.unit === "kg" ? "var(--ink)" : "var(--steel-2)"} stroke="var(--ink)" strokeWidth={p.unit === "kg" ? 0 : 1} />
              <text transform={`translate(${x + W / 2 + 3} ${bottom}) rotate(90)`} fontSize={FONT} fill="var(--ink)">
                {p.label}
              </text>
            </g>
          );
        })}
        {layout.hidden > 0 ? (
          <text x={28 + layout.plates.length * (W + GAP) + 4} y={mid + 4} fontSize="12" fill="var(--dim)">
            +{layout.hidden}
          </text>
        ) : null}
      </svg>
      <figcaption>{layout.text}</figcaption>
    </figure>
  );
}
