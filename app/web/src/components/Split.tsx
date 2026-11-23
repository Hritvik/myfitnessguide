import { Fragment, type ReactNode } from "react";
import { arrange, TWO, type Layout, type PartSpec } from "../layout";
import { Grid } from "./layout/Grid";

/**
 * A screen's parts for either layout (wide-layout spec §4). The phone gets
 * them as fragments in the declared order, so its DOM is the screen's as it
 * was. A wide screen gets the full-width parts, then `.cols`: on TWO a left
 * and a right `.col`, always both, as the desktop build drew them; on a named
 * layout `.cols <name>` with one `.col data-region` per region that has a
 * part, in the layout's order (the reading and tab order), a region in
 * `grids` drawn through Grid. A part whose node is null, undefined or false
 * is left out.
 */
export function Split({ wide, specs, nodes, className, layout = TWO }: { wide: boolean; specs: readonly PartSpec[]; nodes: Partial<Record<string, ReactNode>>; className?: string; layout?: Layout }) {
  const present = specs.filter((s) => nodes[s.key] !== null && nodes[s.key] !== undefined && nodes[s.key] !== false);
  const a = arrange(present, wide, layout);
  const put = (keys: readonly string[]) => keys.map((k) => <Fragment key={k}>{nodes[k]}</Fragment>);
  if (!a.wide) return <>{put(a.stack)}</>;
  if (layout === TWO) {
    return (
      <>
        {put(a.full)}
        <div className={className ? `cols ${className}` : "cols"}>
          <div className="col">{put(a.regions.left ?? [])}</div>
          <div className="col">{put(a.regions.right ?? [])}</div>
        </div>
      </>
    );
  }
  return (
    <>
      {put(a.full)}
      <div className={["cols", layout.name, className].filter(Boolean).join(" ")}>
        {layout.regions
          .filter((r) => (a.regions[r] ?? []).length > 0)
          .map((r) => {
            const grid = layout.grids?.[r];
            return grid ? (
              <Grid key={r} wide min={grid.min} max={grid.max} gap={grid.gap} className="col" data-region={r}>
                {put(a.regions[r] ?? [])}
              </Grid>
            ) : (
              <div key={r} className="col" data-region={r}>
                {put(a.regions[r] ?? [])}
              </div>
            );
          })}
      </div>
    </>
  );
}
