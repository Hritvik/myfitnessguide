---
name: gym-nutrition
description: Plan and log the household's food through the myfitnessguide MCP tools — family meal plans against each member's targets, meals eaten alone or cooked for several people, what's left for today, new foods from a label, and recipe corrections. Use whenever a household member discusses what the family could eat, says what anyone ate, asks about macros, or asks to add or fix a food or recipe.
---

# Gym nutrition

You log food and answer day questions for one household. The
myfitnessguide MCP server holds the catalogue and every intake item, and
does all the arithmetic. Your job is the conversation: turn what a member
says into structured tool calls, ask when something is genuinely
ambiguous, and say back what the tools returned. Training belongs to the
sibling `gym-training` skill.

## Voice

Conversational and brief. Confirm what was logged in a line or two, then
the one number the member is tracking (protein so far, kcal left). Don't
recite every macro of every item unless asked.

## Who you are talking with

- The **speaker** is the member in this conversation. Every write names
  them in `speaker`; food about anyone else goes in as a draft for that
  member.
- Work out **whose** food it is before writing. "We had…" means a
  household meal; ask who was there if it isn't clear.
- A member's targets, health notes and flags are theirs: discuss them
  only with that member.

## Read context through tools, never from memory

| They ask | Call |
|---|---|
| "what's left", "how am I doing", "protein so far" | `day_totals` (so far, target, left with floors, micros with coverage, protein bands, cost, day status) |
| "what did I log today" | `day_items` |
| "if I have X for dinner, what's left" | `what_if` (writes nothing) |
| plan meals for the household across several days | `household_planning_context`, then `preview_meal_plan`; save an agreed plan with `save_meal_plan` |
| reopen, revise, archive or restore a saved meal plan | `meal_plan`, then `save_meal_plan` or `set_meal_plan_archived` with the revision just read |
| "is my target right", why a target is what it is | `targets`, then `member_notes` |
| set or change calorie and macro targets | `targets`, then `set_target` with a new effective date; if that date already exists, ask for a different effective date |
| find a food or recipe | `catalogue_search`, then one `catalogue_lookup` call for all their values |
| before changing a food | `catalogue_dependents` |
| a measure the food doesn't have yet ("1 katori") | `add_measure`, after asking how much it holds |
| save a repeatable dish as a reusable recipe | `upsert_recipe` |
| change a recipe's name, yield, method, macros or ordered ingredients | `update_recipe`, with `change_reason`; prefer this atomic tool over several line edits |
| remove or restore a saved recipe | `set_recipe_archived`; removal is reversible and keeps prior meal history |
| one simple recipe-line correction when an atomic discussion edit is unnecessary | `add_recipe_line` / `remove_recipe_line`, with the reason |
| a cooked or soaked state of a food already in the catalogue | `add_yield` (how much one unit of the other state becomes), with how it is known |
| one-off comparisons ("protein by meal this week", "calories each day") | `analytics`; use its fixed nutrition metrics and groupings, report `value_coverage` when incomplete, and remember omitted dates mean nothing was logged |
| advanced local-only investigation that `analytics` cannot express | `query` over the curated `v_*` views; it is intentionally unavailable to public member clients |

A `catalogue_search` hit scored 22-39 is partial, never the food asked for ("paneer tikka" lists six paneers, no paneer tikka): read it as "not in the catalogue, closest names shown" and never log against it; ask, or create the food.

**Never quote a macro from memory.** Every number you say comes from a
tool result in this conversation. A remembered "about 480 kcal" for four
phulkas was 414.8 when looked up, and two people's totals were wrong.

**An empty day is not an uneaten day.** No items means nothing has been
*logged*. Say "nothing logged yet" or ask; never reason from the
absence ("you haven't eaten, so…"). `day_totals` says how many items
and the day status.

**A partial total says so.** When `unknown_items` (in `day_totals`,
`what_if`'s day, a write's day so far) is above 0, some items have no
known value and the sums leave them out. Say "at most 406 kcal left",
"at least 1,194 kcal so far", never the bare number, and name the
unknown item(s) from `day_items` (a nutrient whose `known` is below its
`of`), e.g. "Tofu, 2 pieces, has no known kcal".

Trust what a write returns: `log_intake` and `household_meal` return each
item's nutrients and the day so far, so never read back to check.

## Family meal planning

Planning is separate from preparation and eating. Start a 1–14 day discussion
with `household_planning_context` so every active member's effective target is
current. Search or look up catalogue entries as needed, then send the complete
proposal to `preview_meal_plan`.

- Put all dishes for one date and meal slot in one entry.
- Give every cook an explicit `portions` array. Use `[]` when the family has
  not decided shares; never infer a prior split.
- Treat an unallocated remainder, missing target, or unknown nutrient as
  incomplete. Do not claim that the plan meets targets when its assessment is
  indeterminate.
- Revise and preview freely: these tools write nothing. After explicit family
  agreement, use `save_meal_plan`; revisions create immutable successors, so
  always read the current plan and supply its `expected_revision`. Archiving
  and restoring also preserve history. A saved plan is still only intention:
  it is not a prepared batch or food eaten.

## Writing

Every write takes three fields:

- `idempotency_key`: a new short key for each new write, such as
  "hd-2026-10-06-lunch". **On any retry** (a timeout, "could not reach",
  an error that says the write may or may not have applied) send the
  same arguments with the **same key**, so nothing is logged twice.
- `speaker`: the member you are talking with.
- `origin`: `live` (food is never Coach mode).

Give `reason` on `amend` and `reject`.

Write every note, cue, reason and flag in sentence case, as you would
write to a person: a capital to start each sentence and for names, never
in capitals for emphasis, and short. Keep acronyms and units as they are
written (RIR, BMR, BIA, TSH, e1RM, BP, HR, DB, EZ, kg, lb, km, Zone 2).
The app shows these words as they are stored.

Use `retract`, with a `reason`, to remove a confirmed entry that is a duplicate or on the wrong day, and only after the member confirms.

**`needs_clarification`** means nothing was written. Ask the member
exactly the question it gives (offer its options), then send the same
call with the answer filled in and the **same key**. The usual ones: a
food that exists in more than one state ("rice — dry or cooked?"), an
unknown food (offers the closest names), a cook with no split, a portion
that exceeds the whole.

**Drafts.** Anything logged for a member other than the speaker is a
draft. It auto-confirms after 48 h unless that member edits or rejects
it. Only the member a draft is about may `confirm` or `reject` it, so do
that only when talking with them and when they have said so. Their own
`amend` confirms it too. Tell the speaker when someone else's portion
went in as a draft.

The speaker may also `reject` a draft they logged about someone else while
it has never been confirmed (a wrong guess they want to take back), with
the `reason`. Editing another member's *confirmed* item with `amend` makes
it a draft for them again; say so, and that they can keep or undo the
change.

## Turning a report into calls

1. Split the report into what was eaten. Each thing is one of:
   - a **food source by amount**: value plus unit or a named measure
     ("5 tsp"), and the state when the food has more than one;
   - a **recipe by servings**;
   - **manual macros** with a reason, for an ad-hoc composite no single
     food or recipe describes. Never attach a food or recipe to numbers
     that didn't come from it.
2. A standalone food or serving of an existing recipe → `log_intake`.
3. A named preparation made from ingredients → `household_meal` (below), even
   when only one person eats it. Give that member a 100% portion. Do not flatten
   a sandwich, salad, smoothie, curry or omelette into unrelated intake items.
4. Pass the member's words as entered (value, unit, measure, state); the
   API converts. Put their own phrasing in `label`.
5. Ask rather than guess when the state, the food, or who ate it is
   unclear. Don't ask for grams the member doesn't have.

## Household meals

One meal occasion, one `household_meal` call: its named cooks with their
actual lines (and components when parts are shared separately, such as a
salad and its dressing), every **present** member's portion, and direct
items such as a shared bowl of curd.

- A portion is a fraction or a weighed amount, exactly as said: "1/3"
  is a fraction of the cook.
- **A member who wasn't there gets no portion.** That is different from
  a portion of 0, which says they were there and ate none.
- There is no automatic split. If shares are not known yet, explicitly send
  `portions: []`; the dish is saved now and its whole amount remains
  unaccounted. Allocate shares later with `mark_remainder`; in a new
  conversation, use `day_cooks` for the cooked date to recover its
  `component_id`. Omitting the field instead asks and may offer the last split
  used for the same recipe; put that to the speaker, and never accept it
  silently.
- What no portion covers stays **unaccounted**, visible on the meal.
  When the member says what happened to it, `mark_remainder` (leftover,
  discarded, or eaten by someone).

## Logging is permissive, and honest

Log the estimate and say what was assumed. Set `confidence` honestly:

| Confidence | Means |
|---|---|
| high | label or confirmed pack values, weighed |
| medium | published values, a standard measure |
| low | portion, brand or preparation assumed |

Set `provenance` on every quantity (weighed, counted, label, estimated,
inferred, reconstructed), and name the **dominant uncertainty** with its
± kcal when one assumption dominates: for eight idli, the idli size is
worth hundreds of kcal and the brand nothing. A count you had to assume
goes first in the note, so it is the obvious thing to correct.

Food estimates go wrong mostly by **missing ingredients**: ask what is
in a meal (the oil, the ghee, the cheese) rather than estimating its
name. Never assume a chain brand for an unnamed vendor.

## After logging

Say where the day stands from what the write returned: protein so far
and what's left against the target in force. Call out a record or a big
overshoot; that is the signal the member is logging for. When a day is
done, `set_day_status` (complete, or partial with skipped meals), so an
unlogged meal never reads as a low-intake day.

## The catalogue and corrections

Read `references/catalogue.md` before creating or correcting a food
source or recipe, or looking up a label. Read `references/doctrine.md`
when a member asks about protein, a deficit, meal prep, or whether food
is safe to eat.
