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

- One weekly prep session (about two hours) turns every weekday meal
  into ten minutes of assembly. Soaking pulses overnight and straining
  curd ahead save most of the time.
- A cooked masala base is the whole trick: a weeknight dinner becomes
  heat the base, add a protein, add a vegetable.
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
