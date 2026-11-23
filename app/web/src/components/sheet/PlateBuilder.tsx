import { useEffect, useRef, useState } from "react";
import { qty } from "../../format";
import { addPlate, availablePlates, otherPlatePlan, plateText, removePlate, NO_BAR, nextBarText, parseBarValue, setBar, type PlateBuild } from "../../plateBuilder";
import { useWrites } from "../../hooks";
import type { Inventory } from "../../types";
import { KEEP_ENTRY, SaveLine } from "../Sheet";

export function PlateBuilder({ inv, build, onChange, online, onRecorded }: { inv: Inventory | null; build: PlateBuild; onChange: (b: PlateBuild) => void; online: boolean; onRecorded: () => void }) {
  const [other, setOther] = useState<{ value: string; unit: "kg" | "lb" } | null>(null);
  const [barText, setBarText] = useState(build.bar && build.bar.value > 0 ? String(build.bar.value) : "");
  const [barUnit, setBarUnit] = useState<"kg" | "lb">(build.bar?.unit ?? "kg");
  // The build as it is now: a plate recorded through a later "Try again" joins the latest build, not the one at the tap.
  const latest = useRef({ build, onChange });
  latest.current = { build, onChange };
  useEffect(() => {
    setBarText((t) => nextBarText(t, build.bar));
    if (build.bar) setBarUnit(build.bar.unit);
  }, [build.bar]);
  const write = useWrites(onRecorded, KEEP_ENTRY).slot("plate");
  return (
    <div className="plate-builder">
      <p className="plate-text">{plateText(build)}</p>
      <div className="row" role="group" aria-label="Bar">
        <label className="field"><span>Bar</span>
          <input inputMode="decimal" aria-label="Bar weight" placeholder="the gym's own" value={barText} onChange={(e) => {
            setBarText(e.target.value);
            const v = parseBarValue(e.target.value);
            if (v !== "bad") onChange(setBar(build, v === null ? null : { value: v, unit: barUnit }));
          }} />
        </label>
        <button type="button" className="btn" aria-label="Bar unit" onClick={() => {
          const unit = barUnit === "kg" ? "lb" : "kg";
          setBarUnit(unit);
          const v = parseBarValue(barText);
          if (typeof v === "number") onChange(setBar(build, { value: v, unit }));
        }}>{barUnit}</button>
        <button type="button" className="chip" aria-pressed={build.bar === null} onClick={() => { setBarText(""); onChange(setBar(build, null)); }}>The gym's own</button>
        <button type="button" className="chip" aria-pressed={build.bar !== null && build.bar.value === 0} onClick={() => { setBarText(""); onChange(setBar(build, NO_BAR)); }}>No bar</button>
        {parseBarValue(barText) === "bad" ? <small>Enter the bar weight as a number, like 17.5.</small> : null}
      </div>
      <div className="chips" role="group" aria-label="Plates on one side">
        {build.plates.map((g, i) => (
          <button key={`${g.value}${g.unit}`} type="button" className="chip" aria-pressed="true" onClick={() => onChange(removePlate(build, i))} aria-label={`Remove one ${qty(g.value)} ${g.unit}`}>
            {g.count > 1 ? `${g.count} × ` : ""}{qty(g.value)} {g.unit} ×
          </button>
        ))}
      </div>
      <div className="chips" role="group" aria-label="Add a plate">
        {availablePlates(inv).map((p) => (
          <button key={`${p.value}${p.unit}`} type="button" className="chip" onClick={() => onChange(addPlate(build, p))}>
            + {qty(p.value)} {p.unit}
          </button>
        ))}
        <button type="button" className="chip" disabled={!inv} onClick={() => setOther({ value: "", unit: "kg" })}>Other plate…</button>
      </div>
      {other && inv ? (
        <div className="row">
          <input inputMode="decimal" aria-label="Plate" value={other.value} onChange={(e) => setOther({ ...other, value: e.target.value })} />
          <button type="button" className="btn" onClick={() => setOther({ ...other, unit: other.unit === "kg" ? "lb" : "kg" })}>{other.unit}</button>
          <button type="button" className="btn primary" disabled={!(Number(other.value) > 0) || write.busy} onClick={() => {
            const plate = { value: Number(other.value), unit: other.unit };
            void write.run(otherPlatePlan(inv.gym, plate), (o) => {
              if (o.status.state === "saved") {
                latest.current.onChange(addPlate(latest.current.build, plate));
                setOther(null);
              }
            });
          }}>Add to the rack</button>
          <SaveLine write={write} online={online} />
        </div>
      ) : null}
    </div>
  );
}
