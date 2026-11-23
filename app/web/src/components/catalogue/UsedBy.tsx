import { usedBy } from "../../catalogue";
import type { Loaded } from "../../hooks";
import type { Dependents } from "../../types";

/** "Used by" (desktop spec §5): what a change reaches, above the edit buttons. */
export function UsedByBox({ state }: { state: Loaded<Dependents> }) {
  if (state.kind === "loading") return null;
  if (state.kind !== "ready") return <p className="leftnote">What uses it didn't load; it may reach logged days.</p>;
  const u = usedBy(state.data);
  return (
    <section className="used-by" aria-label="Used by">
      <h3>Used by</h3>
      {u.lines.length > 0 ? (
        <ul>
          {u.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : null}
      <p>{u.reach}</p>
    </section>
  );
}
