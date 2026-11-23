import { useEffect, useRef, useState } from "react";
import { FOOD_STATES, foodLabel, stateLabel } from "../../format";
import { callTool } from "../../api";
import { amountChips, askedFor, buildPicker, draftFor, foodCheck, oneAtATime, foodItem, foodPlan, newFoodPlan, noMatchLine, potPlan, potShare, previewLine, PROVENANCES, switchMeasure, switchState, type AmountDraft, type NewFoodDraft, type Pick } from "../../food";
import { useDebounced, useLoad, useWrites } from "../../hooks";
import type { CatalogueHit, CatalogueLookup, DayCooks, RecentItems, RecipeDetail, WhatIf } from "../../types";
import { closeOnSaved, KEEP_ENTRY, SaveLine, type TabProps } from "../Sheet";
import { Text } from "../layout/Text";
import { MealPanel } from "./MealPanel";
import { FormError } from "../FormError";

export function FoodTab(props: TabProps) {
  const { state, online } = props;
  const [query, setQuery] = useState("");
  const [pick, setPick] = useState<Pick | null>(null);
  const [adding, setAdding] = useState(false);
  const [meal, setMeal] = useState<{ recipe: RecipeDetail | null } | null>(null);
  // What the last Save from a form here logged: the form closes, so the list says it (decision 91).
  const [note, setNote] = useState<string | null>(null);
  // Bumped when a new food is added, so the same search runs again and finds it.
  const [added, setAdded] = useState(0);
  const back = (saved?: string) => setNote(saved ?? null);
  const q = useDebounced(query.trim(), 250);
  const recents = useLoad(() => callTool<RecentItems>("recent_items", { member: state.forMember, date: state.date }), `recent|${state.forMember}|${state.date}`);
  const cooks = useLoad(() => callTool<DayCooks>("day_cooks", { member: state.forMember, date: state.date }), `cooks|${state.forMember}|${state.date}`);
  const [hits, setHits] = useState<CatalogueHit[] | null>(null);
  const [hitsFor, setHitsFor] = useState("");
  useEffect(() => {
    if (!q || !online) return setHits(null);
    let live = true;
    void callTool<{ results: CatalogueHit[] }>("catalogue_search", { query: q, kinds: ["food_source", "recipe"] }).then((o) => {
      if (live && o.kind === "ok") {
        setHits(o.data.results);
        setHitsFor(q);
      }
    });
    return () => {
      live = false;
    };
  }, [q, online, added]);

  if (meal) return <MealPanel {...props} recipe={meal.recipe} onBack={(saved) => { setMeal(null); back(saved); }} />;
  if (adding) return <NewFood {...props} name={query.trim()} onDone={(saved, added) => {
          setAdding(false);
          back(saved);
          // The search turns to the new food, and runs again even when it was already the query.
          if (added) {
            setQuery(added);
            setAdded((n) => n + 1);
          }
        }} />;
  if (pick?.kind === "pot") return <PotShare {...props} pick={pick} onBack={(saved) => { setPick(null); back(saved); }} />;
  if (pick) return <AmountRow {...props} pick={pick} onBack={(saved) => { setPick(null); back(saved); }} onCook={(r) => setMeal({ recipe: r })} />;

  const rows = buildPicker(
    recents.state.kind === "ready" ? recents.state.data : null,
    cooks.state.kind === "ready" ? cooks.state.data : null,
    online ? hits : null,
    state.forMember,
    online ? undefined : q,
  );
  const groups = [...new Set(rows.map((r) => r.group))];
  const noMatch = online && hitsFor === q && q === query.trim() ? noMatchLine(q, rows, hits) : null;
  return (
    <>
      <label className="field wide">
        <span>Find a food or dish</span>
        <input type="search" data-search value={query} onChange={(e) => { setQuery(e.target.value); setNote(null); }} placeholder="a food, a dish or a word you've taught" autoFocus />
      </label>
      {note ? <p className="status saved" role="status">{note}</p> : null}
      {!online ? <p className="banner">Offline: showing what is already loaded. A Save now won't go through; the entry stays here to try again.</p> : null}
      <button type="button" className="btn" onClick={() => setMeal({ recipe: null })}>
        A dish cooked for the household
      </button>
      {groups.map((g) => (
        <section key={g} className="pick-group">
          <h3>{g}</h3>
          <ul className="pick-list">
            {rows.filter((r) => r.group === g).map((r) => (
              <li key={r.key}>
                <button type="button" className="pick" onClick={() => setPick(r.pick)}>
                  <Text mode="truncate" reach="title">{r.label}</Text>
                  {r.detail ? <small><Text mode="truncate" reach="title">{r.detail}</Text></small> : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {noMatch ? <p className="preview" role="status">{noMatch}</p> : null}
      <button type="button" className="btn" onClick={() => setAdding(true)}>
        + New food
      </button>
    </>
  );
}

function AmountRow({ who, state, onSaved, online, pick, onBack, onCook }: TabProps & { pick: Exclude<Pick, { kind: "pot" }>; onBack: (saved?: string) => void; onCook: (r: RecipeDetail) => void }) {
  const [current, setCurrent] = useState(pick);
  const [draft, setDraft] = useState<AmountDraft>(() => draftFor(pick));
  const write = useWrites(onSaved, KEEP_ENTRY).slot("save");
  const detail = useLoad(() => callTool<CatalogueLookup>("catalogue_lookup", { refs: [current.ref] }), `lookup|${current.ref}`);
  const siblings = useLoad(() => callTool<{ results: CatalogueHit[] }>("catalogue_search", { query: current.name, kinds: ["food_source"] }), `states|${current.name}`);
  const source = detail.state.kind === "ready" ? detail.state.data.food_sources[0] : undefined;
  const recipe = detail.state.kind === "ready" ? detail.state.data.recipes[0] : undefined;
  const states =
    current.kind === "food" && siblings.state.kind === "ready"
      ? siblings.state.data.results.filter((h): h is Extract<CatalogueHit, { kind: "food_source" }> => h.kind === "food_source" && h.name.toLowerCase() === current.name.toLowerCase())
      : [];
  const built = foodItem(current, draft);
  const settled = useDebounced("item" in built ? JSON.stringify(built.item) : "", 400);
  const [preview, setPreview] = useState<string | null>(null);
  // what_if's kcal for the item it was asked about (keyed by the item), for the plausibility check.
  const [kcalFor, setKcalFor] = useState<{ key: string; kcal: number | null } | null>(null);
  const whatIf = (key: string) => callTool<WhatIf>("what_if", { member: state.forMember, date: state.date, items: [JSON.parse(key)] });
  useEffect(() => {
    if (!settled || !online) return setPreview(null);
    let live = true;
    void whatIf(settled).then((o) => {
      if (!live) return;
      setPreview(o.kind === "ok" ? previewLine(o.data) : o.kind === "needs_clarification" ? o.question : null);
      if (o.kind === "ok") setKcalFor({ key: settled, kcal: o.data.items[0]?.nutrients?.kcal?.value ?? null });
    });
    return () => {
      live = false;
    };
    // whatIf reads only the member and date, listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, online, state.forMember, state.date]);
  const itemKey = "item" in built ? JSON.stringify(built.item) : "";
  const usual = current.kind === "food" ? current.usual : null;
  // The item the member said "save it anyway" to, and the question the last Save tap asked (web decision 83).
  const [accepted, setAccepted] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ key: string; text: string } | null>(null);
  const question = askedFor(asking, itemKey);

  // Closing is the plan's after-save, so "Try again" that lands closes the form too (decision 74).
  const send = () => {
    const what = `${current.kind === "food" ? foodLabel(current.name, current.state) : current.name}, ${draft.value.trim()} ${current.kind === "recipe" ? "servings" : (draft.measure ?? draft.unit ?? "")}`.trim();
    if ("item" in built) void write.run(foodPlan(state.forMember, state.date, state.slot, built.item, { what, me: who.member }), closeOnSaved(onBack));
  };
  // An implausible amount asks first (click test P1-1): what_if's kcal when it has answered for this
  // item (asked now if not, online), and the member's usual amount; "Save anyway" sends it as typed.
  const check = async () => {
    if (!("item" in built)) return;
    let kcal = kcalFor?.key === itemKey ? kcalFor.kcal : null;
    if (kcalFor?.key !== itemKey && online) {
      const o = await whatIf(itemKey);
      kcal = o.kind === "ok" ? (o.data.items[0]?.nutrients?.kcal?.value ?? null) : null;
    }
    const text = accepted === itemKey ? null : foodCheck(kcal, draft, usual);
    if (text) setAsking({ key: itemKey, text });
    else send();
  };
  // One check at a time: a double tap while what_if answers sends one plan, with one key (review round).
  const [checking, setChecking] = useState(false);
  const latest = useRef(check);
  latest.current = check;
  const guard = useRef<ReturnType<typeof oneAtATime> | null>(null);
  guard.current ??= oneAtATime(async () => {
    setChecking(true);
    try {
      await latest.current();
    } finally {
      setChecking(false);
    }
  });
  const save = () => guard.current?.run();

  return (
    <div className="amount">
      <button type="button" className="btn" onClick={() => onBack()}>
        Back
      </button>
      <h3>{current.kind === "food" ? foodLabel(current.name, current.state) : current.name}</h3>
      {states.length > 1 && current.kind === "food" ? (
        <div className="chips" role="group" aria-label="State">
          {states.map((s) => (
            <button key={s.ref} type="button" className="chip" aria-pressed={s.ref === current.ref} onClick={() => {
                const next = switchState(current, draft, s.ref, s.state);
                setCurrent(next.pick);
                setDraft(next.draft);
              }}>
              {stateLabel(s.state)}
            </button>
          ))}
        </div>
      ) : null}
      {current.kind === "food" && source ? (
        <div className="chips" role="group" aria-label="Measure">
          {amountChips(source).map((c) => (
            <button key={c.label} type="button" className="chip" aria-pressed={(c.measure ?? null) === draft.measure && (c.unit ?? null) === draft.unit} onClick={() => setDraft(switchMeasure(draft, source, c))}>
              {c.label}
            </button>
          ))}
        </div>
      ) : null}
      <label className="field">
        <span>{current.kind === "recipe" ? "Servings" : "How much"}</span>
        <input inputMode="decimal" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
      </label>
      <div className="chips" role="group" aria-label="How it was measured">
        {PROVENANCES.map((p) => (
          <button key={p} type="button" className="chip" aria-pressed={draft.provenance === p} onClick={() => setDraft({ ...draft, provenance: p })}>
            {p}
          </button>
        ))}
      </div>
      <details>
        <summary>Biggest uncertainty</summary>
        <label className="field">
          <span>What</span>
          <input value={draft.uncertainty} onChange={(e) => setDraft({ ...draft, uncertainty: e.target.value })} placeholder="katori size" />
        </label>
        <label className="field">
          <span>± kcal</span>
          <input inputMode="numeric" value={draft.uncertaintyKcal} onChange={(e) => setDraft({ ...draft, uncertaintyKcal: e.target.value })} />
        </label>
      </details>
      <p className="preview" aria-live="polite"><FormError inline text={"error" in built ? built.error : null} />{"error" in built ? null : (preview ?? "")}</p>
      {question ? (
        <div className="status question" role="status">
          {question}{" "}
          <button type="button" className="btn" disabled={write.busy || write.canRetry} onClick={() => {
              setAccepted(itemKey);
              setAsking(null);
              send();
            }}>
            Save anyway
          </button>
        </div>
      ) : null}
      <button type="button" className="btn primary" disabled={!("item" in built) || write.busy || write.canRetry || question !== null || checking} onClick={() => void save()}>
        Save
      </button>
      <SaveLine write={write} online={online} />
      {current.kind === "recipe" && recipe ? (
        <button type="button" className="btn" onClick={() => onCook(recipe)}>
          Cooked it for the household
        </button>
      ) : null}
    </div>
  );
}

function PotShare({ who, state, onSaved, online, pick, onBack }: TabProps & { pick: Extract<Pick, { kind: "pot" }>; onBack: (saved?: string) => void }) {
  const [mode, setMode] = useState<"percent" | "grams">("percent");
  const [value, setValue] = useState("");
  const write = useWrites(onSaved, KEEP_ENTRY).slot("save");
  const share = potShare(mode, value);
  const save = () => {
    const what = `${"fraction" in share ? `${value.trim()}%` : `${value.trim()} g`} of ${pick.name}`;
    if (!("error" in share)) void write.run(potPlan(pick.componentId, state.forMember, state.date, state.slot, share, "estimated", { what, me: who.member }), closeOnSaved(onBack));
  };
  return (
    <div className="amount">
      <button type="button" className="btn" onClick={() => onBack()}>
        Back
      </button>
      <h3>A share of {pick.name}</h3>
      <div className="chips" role="group" aria-label="Share as">
        <button type="button" className="chip" aria-pressed={mode === "percent"} onClick={() => setMode("percent")}>
          % of the pot
        </button>
        <button type="button" className="chip" aria-pressed={mode === "grams"} onClick={() => setMode("grams")}>
          grams
        </button>
      </div>
      <label className="field">
        <span>{mode === "percent" ? "Share (%)" : "Grams"}</span>
        <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <FormError className="preview" text={"error" in share && value ? share.error : null} />
      <button type="button" className="btn primary" disabled={"error" in share || write.busy || write.canRetry} onClick={save}>
        Save
      </button>
      <SaveLine write={write} online={online} />
    </div>
  );
}

function NewFood({ onSaved, online, onDone, name }: TabProps & { name: string; onDone: (saved?: string, added?: string) => void }) {
  // The search that found nothing names the food (click test P2-24).
  const [f, setF] = useState<NewFoodDraft>({ name, state: "as_sold", per: "g", kcal: "", protein: "", carbs: "", fat: "", measureName: "", measureAmount: "" });
  const [override, setOverride] = useState("");
  const write = useWrites(onSaved, KEEP_ENTRY).slot("save");
  const plan = newFoodPlan(f, override.trim() || undefined);
  const asked = write.status?.state === "question";
  const set = (k: keyof NewFoodDraft) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    if (!("error" in plan)) void write.run(plan, closeOnSaved((saved) => onDone(`${saved} It's in the list below: pick it to log it.`, f.name.trim())));
  };
  return (
    <div className="amount">
      <button type="button" className="btn" onClick={() => onDone()}>
        Back
      </button>
      <h3>New food</h3>
      <label className="field"><span>Name</span><input value={f.name} onChange={set("name")} /></label>
      <label className="field">
        <span>State</span>
        <select value={f.state} onChange={set("state")}>
          {FOOD_STATES.map((s) => <option key={s} value={s}>{stateLabel(s)}</option>)}
        </select>
      </label>
      <div className="chips" role="group" aria-label="Per 100">
        {(["g", "ml"] as const).map((u) => (
          <button key={u} type="button" className="chip" aria-pressed={f.per === u} onClick={() => setF({ ...f, per: u })}>per 100 {u}</button>
        ))}
      </div>
      {(["kcal", "protein", "carbs", "fat"] as const).map((k) => (
        <label key={k} className="field"><span>{k}</span><input inputMode="decimal" value={f[k]} onChange={set(k)} /></label>
      ))}
      <label className="field"><span>A measure (optional)</span><input value={f.measureName} onChange={set("measureName")} placeholder="piece" /></label>
      <label className="field"><span>It holds ({f.per})</span><input inputMode="decimal" value={f.measureAmount} onChange={set("measureAmount")} /></label>
      {asked ? (
        <label className="field"><span>If the label really says this, say so</span><input value={override} onChange={(e) => setOverride(e.target.value)} placeholder="The label says 520 kcal" /></label>
      ) : null}
      <FormError className="preview" text={"error" in plan ? plan.error : null} />
      <button type="button" className="btn primary" disabled={"error" in plan || write.busy || write.canRetry} onClick={save}>Add food</button>
      <SaveLine write={write} online={online} />
    </div>
  );
}
