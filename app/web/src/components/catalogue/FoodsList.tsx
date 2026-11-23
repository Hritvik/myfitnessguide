import type { ReactNode } from "react";
import { callTool, type Outcome } from "../../api";
import { foodRows, listEmpty, recipeRows, searchKinds, searchRows, visibleRows, type FoodsChip } from "../../catalogue";
import { useDebounced, useLoad, useOnline } from "../../hooks";
import { cataloguePath } from "../../route";
import type { CatalogueHit, CatalogueListFood, CatalogueListRecipe } from "../../types";
import { useCatalogueStore } from "../CatalogueStore";
import { Link } from "../Shell";
import type { Go } from "./Panes";
import { usePaged } from "./usePaged";

const CHIPS: { chip: FoodsChip; label: string }[] = [
  { chip: "all", label: "All" },
  { chip: "food", label: "Foods" },
  { chip: "recipe", label: "Recipes" },
];

const NO_HITS: Promise<Outcome<{ results: CatalogueHit[] }>> = Promise.resolve({ kind: "ok", data: { results: [] } });

/** Foods & recipes (desktop spec §5): catalogue_list with an empty search box, catalogue_search while typing. */
export function FoodsList({ go, current, footer }: { go: Go; current: { kind: "food" | "recipe"; ref: string } | null; footer?: ReactNode }) {
  const online = useOnline();
  const { list, setList } = useCatalogueStore();
  const { query, chip } = list;
  const setQuery = (v: string) => setList((m) => ({ ...m, query: v }));
  const setChip = (c: FoodsChip) => setList((m) => ({ ...m, chip: c }));
  const typed = query.trim();
  const q = useDebounced(typed, 250);
  const foods = usePaged<CatalogueListFood>("food_source", foodRows);
  const recipes = usePaged<CatalogueListRecipe>("recipe", recipeRows);
  const search = useLoad(() => (q ? callTool<{ results: CatalogueHit[] }>("catalogue_search", { query: q, kinds: searchKinds(chip), limit: 50 }) : NO_HITS), `cat-search|${chip}|${q}`);
  const searching = typed !== "";
  // The hits answer the typed words only once the debounce has caught up and that search has loaded; until then nothing old shows.
  const settled = searching && typed === q && search.state.kind === "ready";
  const hits = settled && search.state.kind === "ready" ? searchRows(search.state.data.results) : [];
  const rows = visibleRows(chip, searching, foods.rows, recipes.rows, hits);
  const here = current ? cataloguePath({ pane: "foods", record: current }) : null;
  const states = searching ? [search.state] : [foods.state, recipes.state];
  const signedOut = states.some((s) => s.kind === "signed_out");
  const offline = !online || states.some((s) => s.kind === "offline");
  const failed = !signedOut && states.some((s) => s.kind === "error");
  const waiting = !signedOut && !failed && (searching ? !settled && !offline : states.some((s) => s.kind === "loading") && rows.length === 0);
  const loaded = searching ? settled : foods.state.kind === "ready" && recipes.state.kind === "ready";
  const empty = loaded ? listEmpty(chip, q, rows.length) : null;
  return (
    <section className="cat-list" aria-label="Foods and recipes">
      <label className="field wide">
        <span>Search foods and recipes</span>
        <input type="search" data-search value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="chips" role="group" aria-label="Show">
        {CHIPS.map((c) => (
          <button key={c.chip} type="button" className="chip" aria-pressed={chip === c.chip} onClick={() => setChip(c.chip)}>
            {c.label}
          </button>
        ))}
      </div>
      {signedOut ? <p className="error-text">Your sign-in has expired. Reload the page to sign in again.</p> : null}
      {offline && !signedOut ? <p className="banner">Offline: showing what is already loaded.</p> : null}
      {failed && !offline ? <p className="error-text">The list didn't load. Check the connection, then search or reload.</p> : null}
      {waiting ? <p className="leftnote">{searching ? "Searching…" : "Loading…"}</p> : null}
      <ul className="cat-rows">
        {rows.map((r) => (
          <li key={r.key}>
            <Link href={r.href} go={go} className="cat-row" current={r.href === here} row>
              <span>{r.label}</span>
              <span className="leftnote">{r.hint}</span>
            </Link>
          </li>
        ))}
      </ul>
      {empty ? <p className="leftnote">{empty}</p> : null}
      {!searching && chip !== "recipe" && foods.next !== null ? (
        <button type="button" className="btn" disabled={foods.status === "loading"} onClick={() => void foods.loadMore()}>
          {foods.status === "error" ? "Try showing more foods again" : "Show more foods"}
        </button>
      ) : null}
      {!searching && chip !== "food" && recipes.next !== null ? (
        <button type="button" className="btn" disabled={recipes.status === "loading"} onClick={() => void recipes.loadMore()}>
          {recipes.status === "error" ? "Try showing more recipes again" : "Show more recipes"}
        </button>
      ) : null}
      {footer}
    </section>
  );
}
