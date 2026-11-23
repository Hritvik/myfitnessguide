import { useEffect } from "react";
import { callTool } from "../../api";
import { barPlan, gymRows, implementRows, loadsPlan, plateRows, recordPlatesPlan } from "../../catalogue";
import { useLoad, useTitle } from "../../hooks";
import type { IdPane } from "../../route";
import type { CatalogueListGym, Inventory } from "../../types";
import { useCatalogueStore } from "../CatalogueStore";
import { Link } from "../Shell";
import { Panes, RecordState, type Go } from "./Panes";
import { SmallForm } from "./SmallForm";
import { usePaged } from "./usePaged";

const UNITS = [
  { value: "kg", label: "kg" },
  { value: "lb", label: "lb" },
];
const unitOf = (u: string | undefined): "kg" | "lb" => (u === "lb" ? "lb" : "kg");

/** Gyms & equipment (desktop spec §5): each gym's equipment and plates, as the inventory tools' screens. */
export function GymsPane({ view, wide, go }: { view: IdPane; wide: boolean; go: Go }) {
  const paged = usePaged<CatalogueListGym>("gym", gymRows);
  const listNode = (
    <section className="cat-list" aria-label="Gyms">
      {paged.state.kind !== "ready" ? <RecordState state={paged.state} what="The gyms" retry={paged.reload} /> : null}
      {paged.state.kind === "ready" && paged.rows.length === 0 ? <p className="leftnote">No gyms yet.</p> : null}
      <ul className="cat-rows">
        {paged.rows.map((r) => (
          <li key={r.key}>
            <Link href={r.href} go={go} className="cat-row" current={r.key === `gym:${view.id}`} row>
              <span>{r.label}</span>
              <span className="leftnote">{r.hint}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
  const record = view.id === null ? null : <GymRecord key={view.id} gymId={view.id} />;
  return <Panes wide={wide} pane="gyms" go={go} back="Gyms & equipment" list={listNode} record={record} />;
}

function GymRecord({ gymId }: { gymId: number }) {
  const store = useCatalogueStore();
  const inv = useLoad(() => callTool<Inventory>("inventory", { gym: gymId }), `cat-gym|${gymId}`);
  useEffect(() => {
    if (store.saved) inv.reload();
    // Only a new catalogue Save re-reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.saved]);
  const data = inv.state.kind === "ready" ? inv.state.data : null;
  useTitle(data?.gym ?? null);
  if (inv.state.kind !== "ready" || !data) return <RecordState state={inv.state.kind === "ready" ? { kind: "loading" } : inv.state} what="This gym" retry={inv.reload} />;
  return (
    <article className="record" aria-labelledby="record-title">
      <header className="record-head">
        <h2 id="record-title">{data.gym}</h2>
      </header>
      <table className="wide-table equipment">
        <thead>
          <tr>
            <th scope="col">Equipment</th>
            <th scope="col">Loads</th>
            <th scope="col">
              <span className="visually-hidden">Change</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {implementRows(data).map((i) => (
            <tr key={i.id}>
              <th scope="row">{i.name}</th>
              <td>
                {i.loads}
                {i.bar ? ` · ${i.bar}` : ""}
                {i.note ? <p className="leftnote">{i.note}</p> : null}
              </td>
              <td className="line-acts">
                {i.barred ? (
                  <SmallForm storeKey={`impl:${i.id}:bar`} open="Change the bar's weight" fields={[{ key: "value", label: "Weight", numeric: true }, { key: "unit", label: "Unit", options: UNITS }]} empty={{ value: "", unit: i.unit }} plan={(f, why) => barPlan(i.id, f.value ?? "", unitOf(f.unit), why)} />
                ) : (
                  <>
                    <SmallForm storeKey={`impl:${i.id}:remove`} open="Remove a load" submit="Remove" fields={[{ key: "loads", label: "Loads it doesn't have" }, { key: "unit", label: "Unit", options: UNITS }]} empty={{ loads: "", unit: i.unit }} plan={(f, why) => loadsPlan("remove_implement_load", i.id, unitOf(f.unit), f.loads ?? "", why)} />
                    <SmallForm storeKey={`impl:${i.id}:add`} open="Add a load" submit="Add" fields={[{ key: "loads", label: "Loads it has" }, { key: "unit", label: "Unit", options: UNITS }]} empty={{ loads: "", unit: i.unit }} plan={(f, why) => loadsPlan("add_implement_load", i.id, unitOf(f.unit), f.loads ?? "", why)} />
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <section aria-label="Plates">
        <h3>Plates</h3>
        {data.plates.length === 0 ? <p className="leftnote">No plates recorded.</p> : null}
        <ul className="foot">
          {plateRows(data).map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <SmallForm
          storeKey={`gym:${gymId}:plates`}
          open="Record plates"
          edit
          fields={[{ key: "unit", label: "Unit", options: UNITS }, { key: "available", label: "Seen on the rack" }, { key: "absent", label: "Not there" }]}
          empty={{ unit: "kg", available: "", absent: "" }}
          plan={(f, why) => recordPlatesPlan(gymId, unitOf(f.unit), f.available ?? "", f.absent ?? "", why)}
        />
      </section>
    </article>
  );
}
