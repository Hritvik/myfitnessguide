import type { Who } from "../../load";
import { cataloguePath, type CatalogueView } from "../../route";
import { ExercisesPane } from "./Exercises";
import { FoodRecord } from "./FoodRecord";
import { FoodsList } from "./FoodsList";
import { GymsPane } from "./Gyms";
import { NewFood } from "./NewFood";
import { NewRecipe } from "./NewRecipe";
import { RecipeRecord } from "./RecipeRecord";
import { Panes, type Go } from "./Panes";
import { WorkoutsPane } from "./Workouts";
import { WordsPane } from "./Words";

/** The catalogue (desktop spec §5): one component set for both layouts, one pane at a time on the phone. */
export function CatalogueScreen({ who, view, wide, go }: { who: Who; view: CatalogueView; wide: boolean; go: Go }) {
  switch (view.pane) {
    case "foods":
      return <FoodsPane who={who} view={view} wide={wide} go={go} />;
    case "workouts":
      return <WorkoutsPane view={view} wide={wide} go={go} />;
    case "exercises":
      return <ExercisesPane who={who} view={view} wide={wide} go={go} />;
    case "gyms":
      return <GymsPane view={view} wide={wide} go={go} />;
    case "words":
      return <WordsPane wide={wide} go={go} />;
  }
}

/** Foods & recipes: the list, and beside it a food, a recipe, or the new-food or new-recipe form. */
function FoodsPane({ who, view, wide, go }: { who: Who; view: Extract<CatalogueView, { pane: "foods" }>; wide: boolean; go: Go }) {
  // The form is in the route (/catalogue/new/food), so the list, the pills and the back link leave it; its draft stays in the catalogue store.
  const creating = view.creating ?? null;
  const rec = view.record;
  const close = () => go(cataloguePath({ pane: "foods", record: null }));
  const open = (kind: "food" | "recipe") => go(cataloguePath({ pane: "foods", record: null, creating: kind }));
  const record =
    creating === "food" ? (
      <NewFood go={go} onClose={close} />
    ) : creating === "recipe" ? (
      <NewRecipe go={go} onClose={close} />
    ) : rec?.kind === "food" ? (
      <FoodRecord key={rec.ref} who={who} refText={rec.ref} go={go} />
    ) : rec?.kind === "recipe" ? (
      <RecipeRecord key={rec.ref} who={who} refText={rec.ref} go={go} />
    ) : null;
  const footer = (
    <div className="acts l-cluster">
      <button type="button" className="btn" onClick={() => open("food")}>
        New food
      </button>
      <button type="button" className="btn" onClick={() => open("recipe")}>
        New recipe
      </button>
    </div>
  );
  return <Panes wide={wide} pane="foods" go={go} back="Foods & recipes" list={<FoodsList go={go} current={rec} footer={footer} />} record={record} />;
}
