# The catalogue: finding, creating and correcting foods

The catalogue belongs to the household: food sources (one food in one
state, with nutrients per reference amount, measures and yields between
states) and recipes (ingredient lines, or manual per-serving macros with
a reason). Everything a logged item shows is recomputed from it.

## Search before creating

`catalogue_search` first, every time. The same banana, whey scoop and
protein bar recur constantly, and a duplicate splits a food's history in
two. Create only when the food genuinely isn't there. A food in a new
state (dry vs cooked, shelled) is its own source, linked by a yield.

When several manual-macro items turn out to be the *same* food at a
consistent figure, that is a food source waiting to be created, not a
composite. Create it (`upsert_food_source`) and log future items against
it.

## Creating a food source

`upsert_food_source` only creates, and the API gives the new source its
ref: leave `ref` out and quote the one it returns. An existing ref comes
back refused (`ref_exists`), pointing at `amend`, which is how an
existing source changes.

Send the whole definition: name, state, reference amount and unit,
macros, and whatever micronutrients the label prints.

- **Unknown is null, not 0.** Leave a micronutrient out rather than
  guess; 0 means measured zero.
- From a label, capture **sodium** at minimum (Indian labelling law, FSS
  Labelling & Display Regulations 2020, mandates it, so it is always on
  the pack) and **dietary fibre** whenever declared (common, not
  mandatory). Vitamins and minerals appear only on fortified products or
  with a claim; record what is printed, never derive the rest.
- Band the protein: `complete`, `partial` (a plant blend, or an
  unverified "complete protein" claim), `incomplete`, `negligible`.
- Put provenance in `assumptions`: the source, the date checked, what is
  assumed, and what would change the numbers most.
- Add the measures people actually say (1 scoop, 1 tsp, 1 egg shelled).
  A measure an existing source lacks ("1 katori") is `add_measure`, once
  the member has said how much it holds.

## Creating a recipe

`upsert_recipe` for something home-made the household will make again, with
its lines resolved like any amount, its method and its
`source_assumptions`. Like a food source, it only creates and the API
allocates the ref. Change a recipe's fields, or one line's amount, with
`amend`; an ingredient it gains or loses is `add_recipe_line` or
`remove_recipe_line`, each with the reason, which the history keeps. A
yield from another state of a food already in the catalogue (dry rice to
cooked) is `add_yield`, saying how the factor is known; change one with
`amend`. When the member introduces a new recipe, capture
it then: lines, method, meal and prep type, and cost when known. A
recipe of kind `idea` is a meal idea and is never eaten. A recipe with no
known lines takes manual macros with a reason.

## Looking up an unknown food

1. **The member's own link** settles the variant.
2. The manufacturer's page. Indian FMCG sites often put the table in an
   image, so only the headline protein is machine-readable.
3. A retailer listing. Retailers often block fetches; don't retry more
   than once.
4. **After the first blocked or empty fetch, ask for a photo of the
   label.** It is faster than searching and gives high confidence. Try
   at most two sources before asking.
5. A nutrition aggregator is acceptable at low or medium confidence;
   say the values are third-party.

If a label's macros don't square with its stated energy,
`upsert_food_source` (and `amend`) come back with `energy_mismatch`.
Suspect a missing macro or a wrong reference amount, and check the label
again with the member. Only when the label really prints those numbers,
send it again with `energy_override_reason` saying so.

## Restaurant and vendor food

Restaurant food is bought in, so its macros are recorded **directly** on the
food source tagged `Restaurant`: there is no recipe to derive them from, and
splitting the dish into bread, filling, sauce and cheese invents a precision
the vendor never gave. Record the whole dish as one source, name the
**swing-factor** as the dominant uncertainty ("mayonnaise and cheese are most
of the fat; without them it's far lower"), and log it by amount. That sentence
makes an estimate correctable instead of merely wrong.

A source tagged `Home-style` is a stand-in for a dish the household cooks
itself. It should become a derived recipe (ingredient lines, `derived: true`)
rather than keep typed macros; when you meet a Home-style source with direct
macros, propose the recipe that replaces it. Never decompose a `Restaurant`
source into components or rebuild it as a recipe.

## Correcting a food

The payoff of logging by reference: fix a value **once**, at the food
source, and every recipe, cook and logged item that uses it recomputes.

1. `catalogue_dependents` first, so the reach of the edit is known, and
   tell the member what will move.
2. `amend` the food source, with the reason (the energy check runs on
   the corrected values too).
3. Recipes with **manual** macros don't follow a source correction; say
   so if one is affected.

Never correct a logged item's numbers to fix a food. If the item's
amount is wrong, `amend` the item; if it is the wrong food altogether,
`reject` it with the reason and log the right one.
