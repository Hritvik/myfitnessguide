# Nutrition doctrine

Generic guidance that holds for any member. A member's own numbers
(targets, meal times, why a target is what it is) are in `targets` and
`member_notes`, never here. Targets, floors and "left" are computed by
`day_totals`; this file is only how to talk about them.

## Protein and a deficit

- Protein protects muscle in a deficit; it is the target to hold when
  others slip.
- **Spread protein across the day's meals** rather than loading it into
  one. The failure mode is a light breakfast and a heroic dinner: if
  breakfast doesn't clear a meaningful part of the target, the day is usually lost.
- Keep most carbohydrate around training.
- Protein powder is efficient, but cap it at a couple of scoops a day:
  liquid calories don't satisfy hunger. Protein bars cost far more kcal
  and money per gram of protein than powder; fine at maintenance,
  expensive in a deficit.
- Losing faster than planned costs muscle.
- **Cut first, then build:** fat loss compresses into a short phase;
  strength and muscle take long fed phases and are hard to build while
  dieting.
- Heavy sweating means real sodium loss, which matters more in a deficit.

## Meal prep

- Prep is **structured**, not prose: a recipe's ordered `prep_steps` say the
  action, the lead window (`hours_before` 8–12 for a soak, `evening_before`
  for overnight oats), who does it, and whether a batch can serve several
  meals (`batchable`, `keeps_days`, `batch_days`, `freezer_ok`). Write them
  with `upsert_recipe` / `update_recipe`, never only into this note.
- `preview_meal_plan` and `save_meal_plan` expand those steps into a dated
  `prep_schedule`: merged same-night soaks, a batch split into fridge and
  freezer parts with a thaw task, and the cook's tasks separately from the
  eater's. A plan with no prep steps returns `prep_schedule: []`.
- After a meal, `log_intake` / `household_meal` return `next_prep`: the tasks
  whose window opens now (about the next 18 hours) for that member, including
  household `anyone` tasks but not the cook's.
- `day_prep` is the phone app's Prep strip; `needs_you` and `waiting` show a
  due prep task as a due line. `settle_prep_task` marks one done or skipped.
  Give a cook who is not a household member `cook_sheet`: the day's dishes and
  the cook's own pending tasks, with no member or health data.
- One weekly prep session (about two hours) still turns every weekday meal
  into ten minutes of assembly: set the plan's `batch_day` so the schedule
  batches there where shelf life allows. A cooked masala base is the whole
  trick: a weeknight dinner becomes heat the base, add a protein, add a
  vegetable.
- Each thing prepared is a **cook**, logged when eaten through `household_meal`
  portions, so every member's portion is counted from the real quantities.
- The household's own prep plan, quantities, storage times and
  techniques are in the household Meal Prep document:
  `member_notes` with `member: null`.
- Handling: squeeze cooked soya very dry before storing; thaw frozen
  portions one at a time.

## Food safety: the rules that matter

1. **Cool fast:** hot to the fridge within an hour, in shallow
   containers. 5-60 °C is the danger zone.
2. **Portion before storing**, and reheat each portion once.
3. **Reheat properly:** steaming hot all the way through, 75 °C or more.

- **Cooked rice is the one genuine risk.** *Bacillus cereus* makes a
  heat-stable toxin that reheating does not destroy. Eat cooked rice
  within 1-2 days, or freeze it.
- Cooking ahead is itself safe; sloppy cooling is the risk.
- Freezing stops the clock completely; it is the best tool there is.
- Nutrient loss over 3-5 days in the fridge is negligible for anyone
  tracking macros.
- Soya and "phytoestrogens" are not a concern at normal dietary intakes.
- **When in doubt, throw it out.** A wasted portion costs a few rupees;
  food poisoning costs a training week. (Record it with `mark_remainder`
  as discarded.)
