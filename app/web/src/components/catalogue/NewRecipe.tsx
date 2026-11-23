import { useEffect, useId, useRef, useState } from "react";
import { addLineRow, NEW_RECIPE_START, newRecipePlan } from "../../catalogue";
import { useOnline } from "../../hooks";
import { useCatalogueStore, type EditDraft } from "../CatalogueStore";
import { useNewRecord } from "./useNewRecord";
import { WriteLine } from "../WriteLine";
import type { Go } from "./Panes";
import { ReasonField } from "./ReasonField";
import { useFoodSuggestions } from "./SmallForm";
import { isComposing } from "../../keys";
import { FOOD_STATES, stateLabel } from "../../format";

const KEY = "new-recipe";

/** A new recipe (desktop spec §5): upsert_recipe; each line resolves like any amount, and an ambiguous food asks. */
export function NewRecipe({ go, onClose }: { go: Go; onClose: () => void }) {
  const store = useCatalogueStore();
  const { writes, land } = useNewRecord(KEY, "recipe", go, onClose);
  const online = useOnline();
  const [error, setError] = useState<string | null>(null);
  const draft: EditDraft = store.draft(KEY) ?? { start: NEW_RECIPE_START, fields: NEW_RECIPE_START, reason: "", override: null };
  const held = store.writes.canRetry(KEY);
  const status = store.writes.status(KEY);
  const set = (patch: Partial<EditDraft>) => store.setDraft(KEY, { ...draft, ...patch });
  const field = (key: string, value: string) => set({ fields: { ...draft.fields, [key]: value } });
  const rows = Number(draft.fields.lines ?? "1");
  const busy = status?.state === "pending";
  const formRef = useRef<HTMLFormElement>(null);
  // The catalogue's food names for the line being typed, as "Add a line" offers them (click test P2-25, ticket 68).
  const [typing, setTyping] = useState<number | null>(null);
  const suggestions = useFoodSuggestions(typing === null ? "" : (draft.fields[`line-${typing}-food`] ?? ""), typing !== null && online);
  const listId = useId();
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>("input, textarea")?.focus();
  }, []);
  const save = () => {
    if (held) return;
    const plan = newRecipePlan(draft.fields, draft.reason);
    if ("error" in plan) return setError(plan.error);
    setError(null);
    // Opening the new record is the plan's after-save, so a "Try again" that lands opens it too (decision 74).
    void store.writes.run(KEY, plan, land);
  };
  const cancel = () => {
    store.setDraft(KEY, null);
    store.writes.clear(KEY);
    onClose();
  };
  const text = (key: string, label: string, numeric = false) => (
    <label className="field">
      <span>{label}</span>
      <input inputMode={numeric ? "decimal" : undefined} autoComplete="off" disabled={held} value={draft.fields[key] ?? ""} onChange={(e) => field(key, e.target.value)} />
    </label>
  );
  return (
    <form
      ref={formRef}
      className="record edit-form"
      aria-label="New recipe"
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
      <h2>New recipe</h2>
      <fieldset>
        {text("name", "Name")}
        {text("servings", "Servings", true)}
        {text("meal_type", "Meal type")}
      </fieldset>
      <label className="field wide">
        <span>Method</span>
        <textarea rows={3} disabled={held} value={draft.fields.method ?? ""} onChange={(e) => field("method", e.target.value)} />
      </label>
      <fieldset className="recipe-lines">
        <legend>Lines</legend>
        {Array.from({ length: Number.isInteger(rows) && rows > 0 ? rows : 1 }, (_, i) => (
          <div key={i} className="recipe-line">
            <label className="field">
              <span>{`Line ${i + 1}: food`}</span>
              <input
                autoComplete="off"
                list={listId}
                disabled={held}
                value={draft.fields[`line-${i}-food`] ?? ""}
                onFocus={() => setTyping(i)}
                onChange={(e) => field(`line-${i}-food`, e.target.value)}
              />
            </label>
            {text(`line-${i}-value`, "Amount", true)}
            <label className="field">
              <span>Unit</span>
              <select disabled={held} value={draft.fields[`line-${i}-unit`] ?? "g"} onChange={(e) => field(`line-${i}-unit`, e.target.value)}>
                <option value="g">g</option>
                <option value="ml">ml</option>
                <option value="piece">piece</option>
              </select>
            </label>
            <label className="field">
              <span>State, if it asks</span>
              <select disabled={held} value={draft.fields[`line-${i}-state`] ?? ""} onChange={(e) => field(`line-${i}-state`, e.target.value)}>
                <option value="">Not sure</option>
                {FOOD_STATES.map((v) => (
                  <option key={v} value={v}>
                    {stateLabel(v)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ))}
        <datalist id={listId}>
          {suggestions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <button type="button" className="btn" disabled={held} onClick={() => set({ fields: addLineRow(draft.fields) })}>
          Add another line
        </button>
      </fieldset>
      <ReasonField value={draft.reason} onChange={(v) => set({ reason: v })} label="Why add it?" disabled={held} />
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      <div className="acts l-cluster">
        <button type="submit" className="btn primary" disabled={!online || busy || held}>
          Add the recipe
        </button>
        <button type="button" className="btn" data-cancel disabled={busy} onClick={cancel}>
          Cancel
        </button>
      </div>
      <WriteLine writes={writes} id={KEY} online={online} />
    </form>
  );
}
