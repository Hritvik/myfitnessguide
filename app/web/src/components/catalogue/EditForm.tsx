import { useEffect, useRef, useState } from "react";
import { editPlan, energyAsked, statusAboveOverride, type FieldSpec } from "../../catalogue";
import { useOnline } from "../../hooks";
import { useWide } from "../../wide";
import { useCatalogueStore, type EditDraft } from "../CatalogueStore";
import { WriteLine } from "../WriteLine";
import { Grid } from "../layout/Grid";
import { ReasonField } from "./ReasonField";
import { isComposing } from "../../keys";
import { closeOnSaved } from "../../writes";

/**
 * A record's fields as inputs where they sit (desktop spec §5). Save sends
 * one amend with only the changed fields and the member's reason; Cancel or
 * Esc drops the edit. The typed fields and a held plan live in the
 * catalogue store, so crossing the breakpoint keeps them. A held plan
 * disables the inputs and offers only Try again (the same keys).
 */
export function EditForm({
  storeKey, specs, record, label, reach,
}: { storeKey: string; specs: readonly FieldSpec[]; record: { table: string; id: number }; label: string; reach?: string }) {
  const store = useCatalogueStore();
  const online = useOnline();
  const wide = useWide();
  const [error, setError] = useState<{ error: string; field: string } | null>(null);
  const draft = store.draft(storeKey);
  const status = store.writes.status(storeKey);
  // Edit unmounts as the form opens; focus moves to the first field so Esc (and typing) reach the form.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>("input, textarea")?.focus();
  }, []);
  if (!draft) return null;
  const asked = energyAsked(status);
  const held = store.writes.canRetry(storeKey);
  const set = (patch: Partial<EditDraft>) => store.setDraft(storeKey, { ...draft, ...patch });
  const save = () => {
    if (held) return;
    const plan = editPlan(specs, record, draft, asked);
    if ("error" in plan) return setError(plan);
    setError(null);
    // Closing the edit is the plan's after-save, so a "Try again" that lands closes it too (decision 74).
    void store.writes.run(storeKey, plan, closeOnSaved(() => store.setDraft(storeKey, null)));
  };
  const cancel = () => {
    store.setDraft(storeKey, null);
    store.writes.clear(storeKey);
  };
  const groups = [...new Set(specs.map((s) => s.group ?? ""))];
  const numeric = (s: FieldSpec) => s.kind === "number" || s.kind === "positive" || s.kind === "optional";
  const invalid = (key: string) => (error?.field === key ? true : undefined);
  const busy = status?.state === "pending";
  const statusFirst = statusAboveOverride(status);
  const line = <WriteLine writes={store.writes} id={storeKey} online={online} />;
  const alert = (
    <p className="error-text" role="alert">
      {error?.error}
    </p>
  );
  return (
    <form
      ref={formRef}
      className="edit-form"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || isComposing(e.nativeEvent)) return;
        e.stopPropagation();
        // A save going through is never dropped by Esc (Cancel is disabled then too).
        if (!busy) cancel();
      }}
    >
      {/* The fields in a grid on a wide screen, as the record's sections are (wide-layout spec §5); on the phone, as before. */}
      <Grid wide={wide} min={340} max={3} gap={16} className="edit-groups">
        {groups.map((g) => (
          <fieldset key={g} disabled={held}>
            {g ? <legend>{g}</legend> : null}
            {specs
              .filter((s) => (s.group ?? "") === g)
              .map((s) => (
                <label key={s.key} className="field">
                  <span>
                    {s.label}
                    {s.unit ? ` (${s.unit})` : ""}
                  </span>
                  {s.key === "method" ? (
                    <textarea rows={3} value={draft.fields[s.key] ?? ""} aria-invalid={invalid(s.key)} onChange={(e) => set({ fields: { ...draft.fields, [s.key]: e.target.value } })} />
                  ) : (
                    <input
                      inputMode={numeric(s) ? "decimal" : undefined}
                      autoComplete="off"
                      value={draft.fields[s.key] ?? ""}
                      aria-invalid={invalid(s.key)}
                      onChange={(e) => set({ fields: { ...draft.fields, [s.key]: e.target.value } })}
                    />
                  )}
                </label>
              ))}
          </fieldset>
        ))}
      </Grid>
      {statusFirst ? line : null}
      {asked ? (
        <label className="field wide">
          <span>Keep these values anyway? Say why</span>
          <input value={draft.override ?? ""} autoComplete="off" disabled={held} aria-invalid={invalid("override")} onChange={(e) => set({ override: e.target.value })} />
        </label>
      ) : null}
      {error?.field === "override" ? alert : null}
      <ReasonField value={draft.reason} onChange={(v) => set({ reason: v })} label="Why the change?" disabled={held} />
      {error && error.field !== "override" ? alert : null}
      {reach ? <p className="leftnote">{reach}</p> : null}
      <div className="acts l-cluster">
        <button type="submit" className="btn primary" disabled={!online || busy || held}>
          Save
        </button>
        <button type="button" className="btn" data-cancel disabled={busy} onClick={cancel}>
          Cancel
        </button>
      </div>
      {statusFirst ? null : line}
    </form>
  );
}
