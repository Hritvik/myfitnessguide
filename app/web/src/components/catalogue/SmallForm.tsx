import { useEffect, useId, useState } from "react";
import { callTool } from "../../api";
import { foodSuggestions } from "../../catalogue";
import { useDebounced, useOnline } from "../../hooks";
import type { CatalogueHit } from "../../types";
import type { Plan } from "../../writes";
import { useCatalogueStore, useFormDraft } from "../CatalogueStore";
import { WriteLine } from "../WriteLine";
import { ReasonField } from "./ReasonField";
import { isComposing } from "../../keys";

export interface FieldDef {
  key: string;
  label: string;
  numeric?: boolean;
  options?: readonly { value: string; label: string }[];
  /** "food": suggest the catalogue's food names as the member types (click test P2-25). */
  suggest?: "food";
}

/** The catalogue's food names for what is typed in a field, from catalogue_search, debounced. */
export function useFoodSuggestions(text: string, on: boolean): string[] {
  const q = useDebounced(text.trim(), 250);
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (!on || q.length < 2) return setNames([]);
    let live = true;
    void callTool<{ results: CatalogueHit[] }>("catalogue_search", { query: q, kinds: ["food_source"] }).then((o) => {
      if (live && o.kind === "ok") setNames(foodSuggestions(o.data.results));
    });
    return () => {
      live = false;
    };
  }, [q, on]);
  return names;
}

/**
 * One small catalogue write (add a measure, teach a word, remove a line):
 * a button until opened, then its fields, a reason (never pre-filled), the
 * named action and Cancel. The draft and a held plan live in the catalogue
 * store, so neither is lost across the breakpoint; a held plan offers only
 * Try again (the same keys). `asks` answers a question the API raised.
 */
export function SmallForm({
  storeKey, open, submit = "Save", fields, empty, plan, asks, onSaved, edit,
}: {
  storeKey: string;
  open: string;
  submit?: string;
  fields: readonly FieldDef[];
  empty: Record<string, string>;
  plan: (fields: Record<string, string>, reason: string, answer: string | null) => Plan | { error: string };
  asks?: { reason: string; options: { label: string; answer: string | null }[] };
  onSaved?: (results: Record<string, unknown>[]) => void;
  /** The record's main change: its opener is what E presses (desktop spec §6). */
  edit?: boolean;
}) {
  const store = useCatalogueStore();
  const form = useFormDraft(storeKey, empty);
  const online = useOnline();
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const suggestField = fields.find((f) => f.suggest === "food");
  const suggestions = useFoodSuggestions(suggestField ? (form.fields[suggestField.key] ?? "") : "", !!suggestField && form.open && online);
  const status = store.writes.status(storeKey);
  const held = store.writes.canRetry(storeKey);
  const busy = status?.state === "pending";
  const send = (answer: string | null) => {
    if (held) return;
    const p = plan(form.fields, form.reason, answer);
    if ("error" in p) return setError(p.error);
    setError(null);
    // Closing the form (and onSaved) is the plan's after-save, so a "Try again" that lands does both too (decision 74).
    void store.writes.run(storeKey, p, (out) => {
      if (out.status.state !== "saved") return;
      store.setDraft(storeKey, null);
      onSaved?.(out.results);
    });
  };
  if (!form.open) {
    return (
      <div className="small-form">
        <button type="button" className="btn" data-edit={edit ? "" : undefined} onClick={form.start}>
          {open}
        </button>
        <WriteLine writes={store.writes} id={storeKey} online={online} />
      </div>
    );
  }
  const asked = asks && status?.state === "question" && status.reason === asks.reason ? asks : null;
  return (
    <form
      className="small-form open"
      aria-label={open}
      onSubmit={(e) => {
        e.preventDefault();
        send(null);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || isComposing(e.nativeEvent)) return;
        e.stopPropagation();
        // A save going through is never dropped by Esc.
        if (!busy) form.close();
      }}
    >
      {fields.map((f) =>
        f.options ? (
          <label key={f.key} className="field">
            <span>{f.label}</span>
            <select value={form.fields[f.key] ?? ""} disabled={held} onChange={(e) => form.set(f.key, e.target.value)}>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label key={f.key} className="field">
            <span>{f.label}</span>
            <input inputMode={f.numeric ? "decimal" : undefined} disabled={held} value={form.fields[f.key] ?? ""} list={f.suggest ? listId : undefined} autoComplete={f.suggest ? "off" : undefined} onChange={(e) => form.set(f.key, e.target.value)} />
            {f.suggest ? (
              <datalist id={listId}>
                {suggestions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            ) : null}
          </label>
        ),
      )}
      <ReasonField value={form.reason} onChange={form.setReason} disabled={held} />
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {asked ? (
        <div className="acts l-cluster" role="group" aria-label="Answer">
          {asked.options.map((o) => (
            <button key={o.label} type="button" className="btn" disabled={!online || busy} onClick={() => (o.answer === null ? form.close() : send(o.answer))}>
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="acts l-cluster">
        <button type="submit" className="btn primary" disabled={!online || busy || held}>
          {submit}
        </button>
        <button type="button" className="btn" data-cancel disabled={busy} onClick={form.close}>
          Cancel
        </button>
      </div>
      <WriteLine writes={store.writes} id={storeKey} online={online} />
    </form>
  );
}
