import { useEffect, useRef, useState } from "react";
import { energyAsked, NEW_FOOD_FIELDS, NEW_FOOD_START, newFoodPlan, statusAboveOverride, type FieldSpec } from "../../catalogue";
import { stateLabel } from "../../format";
import { useOnline } from "../../hooks";
import { useCatalogueStore, type EditDraft } from "../CatalogueStore";
import { useNewRecord } from "./useNewRecord";
import { WriteLine } from "../WriteLine";
import type { Go } from "./Panes";
import { ReasonField } from "./ReasonField";
import { isComposing } from "../../keys";

const KEY = "new-food";

/**
 * A new food (desktop spec §5): upsert_food_source with the member's reason.
 * The API allocates the ref and it is never shown; a learned word, a
 * duplicate name or macros that don't reconcile come back as the API's
 * question where the Save is, and the form stays open with what was typed.
 * A held plan disables the inputs and offers only Try again; once it lands
 * (first try or retry) the new record opens.
 */
export function NewFood({ go, onClose }: { go: Go; onClose: () => void }) {
  const store = useCatalogueStore();
  const { writes, land } = useNewRecord(KEY, "food", go, onClose);
  const online = useOnline();
  const [error, setError] = useState<{ error: string; field: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>("input, select")?.focus();
  }, []);
  const draft: EditDraft = store.draft(KEY) ?? { start: NEW_FOOD_START, fields: NEW_FOOD_START, reason: "", override: null };
  const status = store.writes.status(KEY);
  const asked = energyAsked(status);
  const held = store.writes.canRetry(KEY);
  const busy = status?.state === "pending";
  const set = (patch: Partial<EditDraft>) => store.setDraft(KEY, { ...draft, ...patch });
  const field = (key: string, value: string) => set({ fields: { ...draft.fields, [key]: value } });
  const save = () => {
    if (held) return;
    const plan = newFoodPlan(draft.fields, draft.reason, asked ? (draft.override ?? "") : null);
    if ("error" in plan) return setError(plan);
    setError(null);
    // Opening the new record is the plan's after-save, so a "Try again" that lands opens it too (decision 74).
    void store.writes.run(KEY, plan, land);
  };
  const cancel = () => {
    store.setDraft(KEY, null);
    store.writes.clear(KEY);
    onClose();
  };
  const groups = [...new Set(NEW_FOOD_FIELDS.map((s) => s.group ?? ""))];
  const numeric = (s: FieldSpec) => s.kind === "number" || s.kind === "positive" || s.kind === "optional";
  const invalid = (key: string) => (error?.field === key ? true : undefined);
  const statusFirst = statusAboveOverride(status);
  const line = <WriteLine writes={writes} id={KEY} online={online} />;
  const alert = (
    <p className="error-text" role="alert">
      {error?.error}
    </p>
  );
  return (
    <form
      ref={formRef}
      className="record edit-form"
      aria-label="New food"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || isComposing(e.nativeEvent)) return;
        e.stopPropagation();
        if (!busy) cancel();
      }}
    >
      <h2>New food</h2>
      {groups.map((g) => (
        <fieldset key={g} disabled={held}>
          {g ? <legend>{g}</legend> : null}
          {NEW_FOOD_FIELDS.filter((s) => (s.group ?? "") === g).map((s) => (
            <label key={s.key} className="field">
              <span>
                {s.label}
                {s.unit ? ` (${s.unit})` : ""}
              </span>
              {s.kind === "choice" ? (
                <select value={draft.fields[s.key] ?? ""} onChange={(e) => field(s.key, e.target.value)}>
                  {(s.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {s.key === "state" ? stateLabel(o) : o}
                    </option>
                  ))}
                </select>
              ) : (
                <input inputMode={numeric(s) ? "decimal" : undefined} autoComplete="off" value={draft.fields[s.key] ?? ""} aria-invalid={invalid(s.key)} onChange={(e) => field(s.key, e.target.value)} />
              )}
            </label>
          ))}
        </fieldset>
      ))}
      {statusFirst ? line : null}
      {asked ? (
        <label className="field wide">
          <span>Keep these values anyway? Say why</span>
          <input value={draft.override ?? ""} autoComplete="off" disabled={held} aria-invalid={invalid("override")} onChange={(e) => set({ override: e.target.value })} />
        </label>
      ) : null}
      {error?.field === "override" ? alert : null}
      <ReasonField value={draft.reason} onChange={(v) => set({ reason: v })} label="Why add it?" disabled={held} />
      {error && error.field !== "override" ? alert : null}
      <div className="acts l-cluster">
        <button type="submit" className="btn primary" disabled={!online || busy || held}>
          Add the food
        </button>
        <button type="button" className="btn" data-cancel disabled={busy} onClick={cancel}>
          Cancel
        </button>
      </div>
      {statusFirst ? null : line}
    </form>
  );
}
