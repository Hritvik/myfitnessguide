import { useEffect } from "react";
import { callTool } from "../api";
import { useLoad, useSaved } from "../hooks";
import { buildHousehold, glanceRows } from "../household";
import { loadHousehold, type Who } from "../load";

/**
 * Today's wide right column, under the pots (desktop spec §3, review #5):
 * the member table and the fridge from household_overview, read here
 * under the Household tab's cache key, so Today's own load is unchanged
 * and the Household tab opens from the same answer.
 */
export function HouseholdGlance({ who, date }: { who: Who; date: string | null }) {
  const { state, reload } = useLoad(() => loadHousehold((t, i) => callTool(t, i), { date }), `household|${date ?? who.today}`);
  const saved = useSaved();
  useEffect(() => {
    if (saved) reload();
    // Only a new Save in the "+" sheet re-reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);
  if (state.kind === "loading") return null;
  if (state.kind !== "ready") {
    return (
      <p className="leftnote">
        The household didn't load.{" "}
        <button type="button" className="btn" onClick={reload}>
          Try again
        </button>
      </p>
    );
  }
  const rows = glanceRows(state.data);
  const fridge = buildHousehold(state.data, who).leftovers;
  return (
    <section className="glance" aria-label="The household today">
      <h2>The household</h2>
      <table className="wide-table">
        <thead>
          <tr>
            <th scope="col">Member</th>
            <th scope="col">Left</th>
            <th scope="col">Drafts waiting</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <th scope="row">
                {r.name}
                {r.you ? <span className="visually-hidden"> (you)</span> : null}
              </th>
              <td>{r.left}</td>
              <td>{r.drafts}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>In the fridge</h3>
      {fridge.length === 0 ? (
        <p className="leftnote">No leftovers.</p>
      ) : (
        <ul className="glance-fridge">
          {fridge.map((l) => (
            <li key={l.componentId}>
              <span>{l.title}</span> <span>{l.amount}</span> <span className="leftnote">{l.since}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
