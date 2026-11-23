import { useEffect, useRef, useState, type ReactNode } from "react";
import { chartWidth } from "./bars";

const PHONE_DRAWING_WIDTH = 358;

/** A chart-width seam: runtime follows its wrapper; tests may supply an exact width. */
export function MeasuredChart({ width, children }: { width?: number; children: (width: number) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(() => chartWidth(width ?? PHONE_DRAWING_WIDTH));

  useEffect(() => {
    if (width !== undefined) {
      setMeasured(chartWidth(width));
      return;
    }
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const update = (next: number) => next > 0 && setMeasured(chartWidth(next));
    update(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => update(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, [width]);

  return <div className="chart-drawing" ref={ref}>{children(width === undefined ? measured : chartWidth(width))}</div>;
}
