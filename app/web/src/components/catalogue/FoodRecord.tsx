import { useEffect, type ReactNode } from "react";
import { callTool } from "../../api";
import { addMeasurePlan, addYieldPlan, FOOD_FIELDS, foodView, otherStates, reachLine, startFields, teachWordPlan, WORD_TAKEN, type FoodView } from "../../catalogue";
import { useLoad, useOnline, useTitle } from "../../hooks";
import { useWide } from "../../wide";
import type { Who } from "../../load";
import type { CatalogueHit, CatalogueRecords, Dependents, FoodRecord as Food, Learned } from "../../types";
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

/** A food (desktop spec §5): its values, measures, yields, price and words; "Used by" above its actions. */
export function FoodRecord({ who, refText }: { who: Who; refText: string; go: Go }) {
  const store = useCatalogueStore();
  const online = useOnline();
  const wide = useWide();
  const look = useLoad(() => callTool<CatalogueRecords>("catalogue_lookup", { refs: [refText] }), `cat-lookup|${refText}`);
  const deps = useLoad(() => callTool<Dependents>("catalogue_dependents", { ref: refText }), `cat-deps|${refText}`);
  const words = useLoad(() => callTool<Learned>("learned", {}), "learned");
  // Every catalogue write re-reads the record once it lands (desktop spec §5).
  useEffect(() => {
    if (!store.saved) return;
    look.reload();
    deps.reload();
    words.reload();
    // Only a new catalogue Save re-reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.saved]);
  const food = look.state.kind === "ready" ? (look.state.data.food_sources[0] ?? null) : null;
  const view = food ? foodView(food, words.state.kind === "ready" ? words.state.data.aliases : []) : null;
  useTitle(view?.title ?? null);
  if (look.state.kind !== "ready") return <RecordState state={look.state} what="This food" retry={look.reload} />;
  if (!food || !view) return <p className="leftnote">There is no food at this link. It may have been renamed or removed; search the list.</p>;
  const editKey = `food:${food.id}:edit`;
  const editing = store.draft(editKey) !== null;
  const edit = editing ? <EditForm storeKey={editKey} specs={FOOD_FIELDS} record={{ table: "food_source", id: food.id }} label={`Edit ${view.title}`} reach={reachLine(deps.state)} /> : null;
  const wordList = <WordList words={view.words} canForget />;
  const usedBy = <UsedByBox state={deps.state} />;
  return (
    <article className="record" aria-labelledby="record-title">
      <header className="record-head">
        <h2 id="record-title">{view.title}</h2>
        <HistoryLink table="food_source" id={food.id} timeZone={who.time_zone} />
      </header>
      <p className="leftnote">{view.facts}</p>
      {wide ? (
        // Catalogue A (wide-layout spec §5): the sections as cards in a grid, Used by above the buttons; an open edit spans the grid.
        <Grid wide min={340} max={3} gap={16} className="record-sections">
          {edit ?? <FoodSections view={view} usedBy={usedBy} words={wordList} />}
          {edit ? usedBy : null}
          {edit ? wordList : null}
        </Grid>
      ) : (
        <>
          {edit ?? <FoodFacts view={view} />}
          {wordList}
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
              const start = startFields(FOOD_FIELDS, food);
              store.writes.clear(editKey);
              store.setDraft(editKey, { start, fields: start, reason: "", override: null });
            }}
          >
            Edit
          </button>
          <SmallForm
            storeKey={`food:${food.id}:measure`}
            open="Add a measure"
            fields={[{ key: "name", label: "Measure, like katori" }, { key: "amount", label: `Amount (${food.reference_unit})`, numeric: true }]}
            empty={{ name: "", amount: "" }}
            plan={(f, why) => addMeasurePlan(food.ref, { name: f.name ?? "", amount: f.amount ?? "" }, why)}
          />
          <YieldForm food={food} />
          <SmallForm
            storeKey={`food:${food.id}:word`}
            open="Teach a word"
            fields={[{ key: "word", label: "Word" }]}
            empty={{ word: "" }}
            plan={(f, why, answer) => teachWordPlan("food_source", food.ref, { word: f.word ?? "" }, why, answer === "replace")}
            asks={WORD_TAKEN}
          />
        </div>
      )}
      {editing ? null : <WriteLine writes={store.writes} id={editKey} online={online} />}
    </article>
  );
}

/** The record's values on the phone, in the desktop build's order: macros, micronutrients, measures, yields, price, category and tags. */
export function FoodFacts({ view }: { view: FoodView }) {
  return (
    <>
      <MacroTable view={view} caption />
      <Micros view={view} />
      <MeasuresYields view={view} />
      <PriceTags view={view} />
    </>
  );
}

/** The same values as section cards on a wide screen, in Catalogue A's order, with Used by and Words among them (wide-layout spec §5). A card with nothing to show is left out. The last is "Price and tags", not the mockup's "Price and history": the record's history stays the head's "history" link. */
export function FoodSections({ view, usedBy, words }: { view: FoodView; usedBy: ReactNode; words: ReactNode }) {
  return (
    <>
      <RecordSection title={view.per}>
        <MacroTable view={view} caption={false} />
      </RecordSection>
      <RecordSection title="Micronutrients">
        <Micros view={view} />
      </RecordSection>
      {view.measures.length > 0 || view.yields.length > 0 ? (
        <RecordSection title="Measures and yields">
          <MeasuresYields view={view} />
        </RecordSection>
      ) : null}
      {usedBy}
      {words}
      {view.price || view.category || view.tags ? (
        <RecordSection title="Price and tags">
          <PriceTags view={view} />
        </RecordSection>
      ) : null}
    </>
  );
}

/** Macros as a small table; on a wide screen its card's heading names the amount, so the caption goes. */
function MacroTable({ view, caption }: { view: FoodView; caption: boolean }) {
  return (
    <table className="wide-table facts">
      {caption ? <caption>{view.per}</caption> : null}
      <thead>
        <tr>
          {view.macros.map((m) => (
            <th key={m.key} scope="col">
              {m.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          {view.macros.map((m) => (
            <td key={m.key}>{m.value}</td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

/** Micronutrients; one nobody measured says "unknown". */
function Micros({ view }: { view: FoodView }) {
  return (
    <dl className="micros">
      {view.micros.map((m) => (
        <div key={m.key}>
          <dt>{m.label}</dt>
          <dd className={m.value === "unknown" ? "unknown" : undefined}>{m.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function MeasuresYields({ view }: { view: FoodView }) {
  return (
    <>
      {view.measures.length > 0 ? <p>Measures: {view.measures.join(" · ")}</p> : null}
      {view.yields.length > 0 ? <p>Yields: {view.yields.join(" · ")}</p> : null}
    </>
  );
}

function PriceTags({ view }: { view: FoodView }) {
  return (
    <>
      {view.price ? <p className="leftnote">{view.price}</p> : null}
      {view.category || view.tags ? <p className="leftnote">{[view.category, view.tags].filter((x): x is string => !!x).join(" · ")}</p> : null}
    </>
  );
}

/** Add a yield: from one of the same food's other states, chosen by state in words. */
function YieldForm({ food }: { food: Food }) {
  const hits = useLoad(() => callTool<{ results: CatalogueHit[] }>("catalogue_search", { query: food.name, kinds: ["food_source"], limit: 50 }), `cat-states|${food.name.toLowerCase()}`);
  const states = hits.state.kind === "ready" ? otherStates(hits.state.data.results, food) : [];
  if (hits.state.kind !== "ready") return null;
  if (states.length === 0) return <p className="leftnote">A yield needs this food in another state (for example dry and cooked).</p>;
  return (
    <SmallForm
      storeKey={`food:${food.id}:yield`}
      open="Add a yield"
      fields={[
        { key: "from", label: "From", options: states.map((s) => ({ value: s.ref, label: s.label })) },
        { key: "factor", label: "1 g becomes (g)", numeric: true },
        { key: "discarded", label: "Thrown away (%)", numeric: true },
      ]}
      empty={{ from: states[0]?.ref ?? "", factor: "", discarded: "" }}
      plan={(f, why) => addYieldPlan(food.ref, { from: f.from ?? "", factor: f.factor ?? "", discarded: f.discarded ?? "" }, why)}
    />
  );
}
