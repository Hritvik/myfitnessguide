import { useEffect } from "react";
import { callTool } from "../../api";
import { FOOD_STATES, stateLabel } from "../../format";
import { addLinePlan, lineAmountPlan, reachLine, RECIPE_FIELDS, recipeView, removeLinePlan, startFields, teachWordPlan, WORD_TAKEN, wordsFor, type RecipeView } from "../../catalogue";
import { useLoad, useOnline, useTitle } from "../../hooks";
import { useWide } from "../../wide";
import type { Who } from "../../load";
import type { CatalogueRecords, Dependents, Learned } from "../../types";
import { useCatalogueStore } from "../CatalogueStore";
import { HistoryLink } from "../HistoryLink";
import { WriteLine } from "../WriteLine";
import { Grid } from "../layout/Grid";
import { EditForm } from "./EditForm";
import { RecordState, type Go } from "./Panes";
import { RecordSection } from "./RecordSection";
import { SmallForm } from "./SmallForm";
import { UsedByBox } from "./UsedBy";
import { WordList } from "./WordList";

const STATE_OPTIONS = [{ value: "", label: "Not sure" }, ...FOOD_STATES.map((v) => ({ value: v, label: stateLabel(v) }))];

const UNIT_OPTIONS = [
  { value: "g", label: "g" },
  { value: "ml", label: "ml" },
  { value: "piece", label: "piece" },
];

/** A recipe (desktop spec §5): its fields, lines and per-serving totals from the server; "Used by" above its actions. */
export function RecipeRecord({ who, refText }: { who: Who; refText: string; go: Go }) {
  const store = useCatalogueStore();
  const online = useOnline();
  const wide = useWide();
  const look = useLoad(() => callTool<CatalogueRecords>("catalogue_lookup", { refs: [refText] }), `cat-lookup|${refText}`);
  const deps = useLoad(() => callTool<Dependents>("catalogue_dependents", { ref: refText }), `cat-deps|${refText}`);
  const learned = useLoad(() => callTool<Learned>("learned", {}), "learned");
  useEffect(() => {
    if (!store.saved) return;
    look.reload();
    deps.reload();
    learned.reload();
    // Only a new catalogue Save re-reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.saved]);
  const recipe = look.state.kind === "ready" ? (look.state.data.recipes[0] ?? null) : null;
  const view = recipe ? recipeView(recipe) : null;
  useTitle(view?.title ?? null);
  if (look.state.kind !== "ready") return <RecordState state={look.state} what="This recipe" retry={look.reload} />;
  if (!recipe || !view) return <p className="leftnote">There is no recipe at this link. It may have been renamed or removed; search the list.</p>;
  const editKey = `recipe:${recipe.id}:edit`;
  const editing = store.draft(editKey) !== null;
  const edit = editing ? <EditForm storeKey={editKey} specs={RECIPE_FIELDS} record={{ table: "recipe", id: recipe.id }} label={`Edit ${view.title}`} reach={reachLine(deps.state)} /> : null;
  const lines = <RecipeLines view={view} recipeRef={recipe.ref} />;
  const words = <WordList words={learned.state.kind === "ready" ? wordsFor(learned.state.data.aliases, "recipe", recipe.id) : []} canForget />;
  const usedBy = <UsedByBox state={deps.state} />;
  return (
    <article className="record" aria-labelledby="record-title">
      <header className="record-head">
        <h2 id="record-title">{view.title}</h2>
        <HistoryLink table="recipe" id={recipe.id} timeZone={who.time_zone} />
      </header>
      {edit && !wide ? edit : null}
      {edit ? null : (
        <>
          <p className="leftnote">{view.facts}</p>
          {view.method ? <p className="method">{view.method}</p> : null}
        </>
      )}
      {wide ? (
        // Catalogue A (wide-layout spec §5): Lines, Used by and Words as cards; an open edit spans the grid above them, and so does Lines (decision 116).
        <Grid wide min={340} max={3} gap={16} className="record-sections">
          {edit}
          <RecordSection title="Lines" span>
            {lines}
          </RecordSection>
          {usedBy}
          {words}
        </Grid>
      ) : (
        <>
          {lines}
          {words}
          {usedBy}
        </>
      )}
      {editing ? null : (
        <div className="record-acts">
          <button
            type="button"
            className="btn primary"
            data-edit
            onClick={() => {
              // The values the edit starts from are taken now, and kept with the draft (plan review #4).
              const start = startFields(RECIPE_FIELDS, recipe as unknown as Record<string, unknown>);
              store.writes.clear(editKey);
              store.setDraft(editKey, { start, fields: start, reason: "", override: null });
            }}
          >
            Edit
          </button>
          <SmallForm
            storeKey={`recipe:${recipe.id}:line`}
            open="Add a line"
            fields={[{ key: "food", label: "Food", suggest: "food" }, { key: "value", label: "Amount", numeric: true }, { key: "unit", label: "Unit", options: UNIT_OPTIONS }, { key: "state", label: "State, if it asks", options: STATE_OPTIONS }]}
            empty={{ food: "", value: "", unit: "g", state: "" }}
            plan={(f, why) => addLinePlan(recipe.ref, { food: f.food ?? "", value: f.value ?? "", unit: f.unit ?? "g", state: f.state ?? "" }, why)}
          />
          <SmallForm
            storeKey={`recipe:${recipe.id}:word`}
            open="Teach a word"
            fields={[{ key: "word", label: "Word" }]}
            empty={{ word: "" }}
            plan={(f, why, answer) => teachWordPlan("recipe", recipe.ref, { word: f.word ?? "" }, why, answer === "replace")}
            asks={WORD_TAKEN}
          />
        </div>
      )}
      {editing ? null : <WriteLine writes={store.writes} id={editKey} online={online} />}
    </article>
  );
}

/** A recipe's lines (each with Change amount and Remove), then its per-serving totals and any manual note. */
function RecipeLines({ view, recipeRef }: { view: RecipeView; recipeRef: string }) {
  return (
    <>
      {view.lines.length > 0 ? (
        <table className="wide-table lines">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Line</th>
              <th scope="col">Amount</th>
              <th scope="col">
                <span className="visually-hidden">Change</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {view.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.position}</td>
                <td>{l.food}</td>
                <td>{l.amount}</td>
                <td className="line-acts">
                  <SmallForm storeKey={`line:${l.id}:amount`} open="Change amount" fields={[{ key: "value", label: "Amount", numeric: true }]} empty={{ value: String(l.value) }} plan={(f, why) => lineAmountPlan(l.id, f.value ?? "", l.value, why)} />
                  <SmallForm storeKey={`line:${l.id}:remove`} open="Remove" submit="Remove it" fields={[]} empty={{}} plan={(_f, why) => removeLinePlan(recipeRef, l.id, l.food, why)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="leftnote">No lines.</p>
      )}
      {view.perServing ? <p>{view.perServing}</p> : null}
      {view.manual ? <p className="leftnote">{view.manual}</p> : null}
    </>
  );
}
