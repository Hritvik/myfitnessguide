import { useEffect, useId, useState } from "react";
import { Text } from "../layout/Text";
import { callTool } from "../../api";
import { useDebounced, useWrites } from "../../hooks";
import { amountChips, referenceChip } from "../../food";
import { foodLabel } from "../../format";
import { afterSave, blankMeal, fromRecipe, mealInput, mealPlan, needsCookedWeight, newLine, previewLines, recipeChanges, type KeepChoice, type MealDraft } from "../../meal";
import { plainQuestion, type Plan } from "../../writes";
import type { CatalogueHit, CatalogueLookup, FoodSourceDetail, PreviewMeal, RecipeDetail } from "../../types";
import { closeOnSaved, KEEP_ENTRY, SaveLine, type TabProps } from "../Sheet";
import { FormError } from "../FormError";

export function MealPanel({ who, state, onSaved, online, recipe, onBack }: TabProps & { recipe: RecipeDetail | null; onBack: (saved?: string) => void }) {
  const [draft, setDraft] = useState<MealDraft>(() => (recipe ? fromRecipe(recipe) : blankMeal()));
  const [asking, setAsking] = useState(false);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState("");
  const [hits, setHits] = useState<CatalogueHit[]>([]);
  const [chosen, setChosen] = useState<FoodSourceDetail | null>(null);
  const [chip, setChip] = useState(0);
  const [amountText, setAmountText] = useState("");
  const [held, setHeld] = useState<Plan | null>(null);
  const eatersId = useId();
  const write = useWrites(onSaved, KEEP_ENTRY).slot("save");
  const built = mealInput(draft, state.date, state.slot);
  const settled = useDebounced("input" in built ? JSON.stringify(built.input) : "", 500);
  const [preview, setPreview] = useState<string[]>([]);
  useEffect(() => {
    if (!settled || !online) return setPreview([]);
    let live = true;
    void callTool<PreviewMeal>("preview_meal", JSON.parse(settled)).then((o) => {
      if (live) setPreview(o.kind === "ok" ? previewLines(o.data) : o.kind === "needs_clarification" ? [plainQuestion(o.reason, o.question)] : []);
    });
    return () => {
      live = false;
    };
  }, [settled, online]);
  const q = useDebounced(adding.trim(), 250);
  useEffect(() => {
    if (!q || !online) return setHits([]);
    let live = true;
    void callTool<{ results: CatalogueHit[] }>("catalogue_search", { query: q, kinds: ["food_source"] }).then((o) => {
      if (live && o.kind === "ok") setHits(o.data.results);
    });
    return () => {
      live = false;
    };
  }, [q, online]);
  const choose = (ref: string) =>
    void callTool<CatalogueLookup>("catalogue_lookup", { refs: [ref] }).then((o) => {
      const source = o.kind === "ok" ? o.data.food_sources[0] : undefined;
      if (source) {
        setChosen(source);
        // The food's own unit, as the Food tab starts: a measure is a choice, never the default (click test P2-6).
        setChip(referenceChip(source));
        setAmountText("");
      }
    });
  const line = chosen ? newLine(chosen, chip, amountText, `new-${Date.now()}-${draft.lines.length}`) : null;
  const addLine = () => {
    if (!line || "error" in line) return;
    setDraft({ ...draft, lines: [...draft.lines, line] });
    setChosen(null);
    setAdding("");
  };

  const setLine = (key: string, value: string) => setDraft({ ...draft, lines: draft.lines.map((l) => (l.key === key ? { ...l, value, edited: true } : l)) });
  // The plan's after-save: SaveLine's "Try again" runs it too, so a retried Save that lands closes the panel (decision 74).
  const save = (keep: KeepChoice) => {
    const plan = mealPlan(draft, state.date, state.slot, keep, newName);
    if ("error" in plan) return;
    void write.run(plan, (out) => {
      if (out.status.state === "saved") onBack(out.status.message);
      else if (afterSave(out).hold) setHeld(plan);
    });
  };
  const tryAgain = () => {
    if (held) void write.run(held, closeOnSaved(onBack));
  };
  // The meal is saved though the recipe step is not: leaving must show the meal on the day.
  const leave = () => {
    if (held) onSaved();
    onBack();
  };
  const locked = held !== null;
  const onSave = () => (recipeChanges(draft) ? setAsking(true) : void save("once"));

  return (
    <div className="amount">
      <button type="button" className="btn" onClick={leave}>Back</button>
      <label className="field"><span>Dish</span><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
      <ul className="lines">
        {draft.lines.map((l) => (
          <li key={l.key}>
            <span>{l.label}</span>
            <input inputMode="decimal" aria-label={`${l.label} amount`} value={l.value} onChange={(e) => setLine(l.key, e.target.value)} />
            <span className="unit">{l.measure ?? l.unit}</span>
            <button type="button" className="btn" aria-label={`Remove ${l.label}`} onClick={() => setDraft({ ...draft, lines: draft.lines.filter((x) => x.key !== l.key) })}>Remove</button>
          </li>
        ))}
      </ul>
      <label className="field"><span>Add an ingredient</span><input type="search" value={adding} onChange={(e) => setAdding(e.target.value)} /></label>
      {hits.filter((h): h is Extract<CatalogueHit, { kind: "food_source" }> => h.kind === "food_source").map((h) => (
        <button key={h.ref} type="button" className="pick" onClick={() => choose(h.ref)}>
          <Text mode="truncate" reach="title">{foodLabel(h.name, h.state)}</Text>
        </button>
      ))}
      {chosen ? (
        <div className="amount" role="group" aria-label={`Add ${chosen.name}`}>
          <div className="chips" role="group" aria-label="Measure">
            {amountChips(chosen).map((c, i) => (
              <button key={c.label} type="button" className="chip" aria-pressed={chip === i} onClick={() => setChip(i)}>{c.label}</button>
            ))}
          </div>
          <label className="field"><span>How much {chosen.name}</span><input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} /></label>
          <button type="button" className="btn" disabled={!line || "error" in line} onClick={addLine}>Add ingredient</button>
        </div>
      ) : null}
      <h3 id={eatersId}>Who ate</h3>
      <p className="hint">Leave out anyone who wasn't there: that is different from eating none.</p>
      {/* Named by its heading, so its chips are told apart from the sheet's For chips, which carry the same member names. */}
      <ul className="eaters" aria-labelledby={eatersId}>
        {who.members.map((m) => {
          const share = draft.eaters[m];
          return (
            <li key={m}>
              <button type="button" className="chip" aria-pressed={share !== undefined} onClick={() => setDraft({ ...draft, eaters: { ...draft.eaters, [m]: share ? undefined : { mode: "percent", value: "" } } })}>{m}</button>
              {share ? (
                <>
                  <input inputMode="decimal" aria-label={`${m}'s share`} value={share.value} onChange={(e) => setDraft({ ...draft, eaters: { ...draft.eaters, [m]: { ...share, value: e.target.value } } })} />
                  <span className="unit">{share.mode === "percent" ? "%" : "g"}</span>
                  <button type="button" className="btn" onClick={() => setDraft({ ...draft, eaters: { ...draft.eaters, [m]: { ...share, mode: share.mode === "percent" ? "grams" : "percent" } } })}>{share.mode === "percent" ? "In grams" : "In %"}</button>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      {needsCookedWeight(draft) ? (
        <label className="field">
          <span>Whole pot, weighed (g)</span>
          <input inputMode="decimal" value={draft.cookedWeight} onChange={(e) => setDraft({ ...draft, cookedWeight: e.target.value })} />
        </label>
      ) : null}
      <div className="preview" aria-live="polite"><FormError text={"error" in built ? built.error : null} />{"error" in built ? null : preview.map((line) => <p key={line}>{line}</p>)}</div>
      {asking ? (
        <div className="keep" role="group" aria-label="Keep these changes for next time?">
          <p>Keep these changes for next time? Updating the recipe changes it for everyone.</p>
          <button type="button" className="btn" disabled={write.busy || write.canRetry || locked} onClick={() => save("once")}>Just this time</button>
          <button type="button" className="btn" disabled={write.busy || write.canRetry || locked} onClick={() => save("update")}>Update {draft.recipe?.name} for everyone</button>
          <label className="field"><span>New recipe's name</span><input value={newName} onChange={(e) => setNewName(e.target.value)} /></label>
          <button type="button" className="btn" disabled={write.busy || write.canRetry || locked || !newName.trim()} onClick={() => save("new")}>Save as a new recipe</button>
        </div>
      ) : (
        <button type="button" className="btn primary" disabled={"error" in built || write.busy || locked} onClick={onSave}>Save</button>
      )}
      <SaveLine write={write} online={online} />
      {held && !write.canRetry && !write.busy ? (
        <button type="button" className="btn" disabled={!online} onClick={tryAgain}>Try again</button>
      ) : null}
    </div>
  );
}
