# Domain rules: decisions taken where the spec was ambiguous

Each entry names the ambiguity, the choice, and why it is the one most
consistent with `CONTEXT.md` and the resolved tickets. Hritvik can veto
any line.

## Porting gymcalc

1. **Rounding matches Python's `round()`.** gymcalc's e1RM and volume round
   to 1 dp with Python's correctly rounded, ties-to-even behaviour. The port
   uses the same rule (`roundHalfEven`), so the parity report compares like
   with like. Only the gymcalc-shaped helpers (`e1rm`, `volume`) round;
   every other function returns unrounded values, since the Training schema
   says totals are "computed exactly and never stored rounded".
2. **Exact pound.** The port uses 1 lb = 0.45359237 kg exactly, where
   gymcalc used `LB_PER_KG = 2.20462`. Every gymcalc fixture still passes,
   and the Guide's own conversion (row 107) is the exact one to 4 dp.
3. **Dates are ISO strings only.** gymcalc accepted a `date` or a string;
   the domain takes `'YYYY-MM-DD'` everywhere and rejects malformed or
   impossible dates with `RangeError`. `weekOf` takes a per-person anchor,
   defaulting to 2026-07-26 (Training schema: "week is derived from a
   per-person anchor date").
4. **`next_session` is split.** The gymcalc function survives as
   `nextInRotation` (its tests ported unchanged). `nextSession` takes the
   programme's declared schedule. A rotation follows the last session and
   returns no date. A weekday plan returns the first planned day starting
   today, or tomorrow once a session is logged today, with a one-off swap
   replacing only its own date (a swap to `null` makes that day rest). It
   looks two weeks ahead and returns null for a plan with no training days.
5. **gymcalc's `e1rm` stays unconditional; the set rule is separate.**
   gymcalc computes Epley for any set (its fixtures include 15 and 20 reps).
   The Training schema restricts e1RM to RIR-0 sets of 12 reps or fewer. Both
   hold: `e1rm(load, reps)` is the ported formula with its tests, and
   `setDerived` applies the schema's gate. "RIR 0" means the whole reported
   range is 0 (`high === 0`); a "0-1" set gets no e1RM.
6. **One progression check, not two.** `progressionCheck` replaces
   gymcalc's `progression_check` and carries the new reasons. gymcalc's
   three answers map onto it: `eligible` = `fired`, `needs_confirmation` =
   `needs_confirmation`, `not_yet` = `not_yet`. The ported tests assert
   through that mapping, so every gymcalc assertion is kept word for word.
   (Until ticket 27, `needs_confirmation` was a `needsConfirmation` boolean
   on `fired`, which the Worker never set, so it was lost in the port; see
   35.)
   gymcalc's `confirmed` flag is renamed `repsConfirmed`, because
   "confirmed" means a set's draft/confirmed state in `CONTEXT.md`.
7. **Set types.** The Training schema lists warm-up, working, back-off and
   substitution; the Sheets Log also has `calibration`. The domain keeps all
   five so imported calibration probes keep their meaning; only `working`
   counts. gymcalc's `substitute` is spelled `substitution`, as in the
   schema. An unknown type throws `RangeError`, as gymcalc's `ValueError` did.
8. **`parseRir`** reads `2`, `'1-2'` and `'4+'` (as 4-4). Blank,
   unreadable text and anything above 10 come back null (not recorded), so
   a Sheets date serial such as `46024` (import hazard 35) can never pass as
   a huge RIR.

### gymcalc tests not ported

- **`TestAppendRow` (4 tests).** `append_row` computes the 1-based Sheets
  row to append at from a column read. It's a Sheets-write helper, and the
  app writes to D1 through the API, so it has no counterpart in a pure
  domain package. Every other test in `shared/test_gymcalc.py` and
  `shared/test_catalogue_integrity.py` is ported.
- **`test_accepts_iso_string`** is ported, but the Python `date` overload
  it sits beside has no TS equivalent (see 3).

## Training

9. **Load basis arithmetic.**
   - `per_side`: 2 x plates + the implement's `barKg` (0 if it has none).
   - `plates_only`: 2 x plates and no sled, flagged
     `comparableAcrossImplements: false` (Guide 125-126).
   - `per_hand` / `per_leg`: what one limb moves, so x2 by default. A set
     done one limb at a time sets `unilateral: true` and counts once. The
     schema doesn't say how unilateral work is entered; this is the
     smallest addition that keeps "single-leg calf raise, dumbbell in the
     working hand" from being doubled.
   - The bar weight lives on the implement in kg (`barKg`), because the
     plates and the bar can be in different units (kg bar, lb plates).
10. **Assisted = negative load, set by the implement.** An implement with
   `assisted: true` makes the total negative. Volume and e1RM are null for
   assisted sets (Guide 136), never a negative number.
11. **Set-level derived values are unrounded.** `setDerived` returns exact
   volume and e1RM. Rounding is a display concern (`round1`), and the
   parity report compares rounded values against the typed sheet values.
12. **Snapping never changes a logged value.** `snapToImplement` converts the
   entered value into the implement's unit and reports `on_list`,
   `off_list` (with the loads either side and the nearest, ties to the
   lighter one) or `no_inventory`. The Training schema says an off-list
   load "becomes a flagged draft offering to add it", so the domain flags
   it and leaves the choice to the person. Equal within 1e-6 counts as on
   the list, to absorb unit-conversion float noise.
13. **Implausible-load threshold.** No ticket gives numbers. A load is
    questioned when it is 1.6x or more above, or 1/1.6 or less below, the
    heaviest set of the most recent date in that exercise's history. 1.6
    clears ordinary jumps on light loads (5 kg to 7.5 kg is 1.5x) and still
    catches the lb/kg factor (2.2) and a per-side value entered as a total
    (2x). A ratio within 5% of 2.2046, 1/2.2046, 2 or 0.5 names the likely
    cause; anything else is `unknown`. The warning never blocks a write, and
    the caller chooses which history counts (same exercise; same implement
    for plates-only loads).
14. **What "never" means.** `never` is reserved for structural reasons that
    no amount of lifting fixes: the prescription's rep cap is below the
    rule's rep requirement, the increment lands on no producible load
    (`increment_not_on_implement`), or the current load is already the
    implement's highest (`at_highest_load`, whose message says so when the
    maximum is unknown, Guide 123). Structural checks run first, so
    "never" is answered even before any sets are logged. "RIR not
    recorded" is `not_yet`, not `never`: the next session can record it.
15. **Next load.** With an inventory, the next load is the lightest
    producible load within `[current + increment.min, current +
    increment.max]` (a rule like "add 2.5-5 kg" sets both). If there's a
    heavier load but none in that window, it's `never` with
    `increment_not_on_implement`. That follows progression.md: with no
    7.5 lb dumbbell, stay at 5 lb and add reps, not jump 100%. Without an
    inventory, the next load is current + min.
16. **Autoregulation branch (Guide 46).** "2+ reps under target" is read
    against the prescription's rep floor (`repLow`): a working set with
    reps at or below `repLow - 2` triggers it (the rule can override the
    2). If the *first* working set is that short, the load was too heavy
    fresh, so it's `drop` to the next lighter producible load (null if
    there's none or no inventory). If only a later set is that short, it's
    fatigue, so it's `hold`. Autoregulation outranks the ordinary not-yet
    reasons. It needs the prescription's rep range, so a check without one
    skips it, as the gymcalc fixtures do.
17. **Gaps.** A prescription is a gap when no working set of its exercise
    is dated on or after `prescribedOn`. Which session a gap is surfaced in
    ("every eligible session") is left to the caller. The domain returns
    the gaps oldest first. Performing a stimulus-matched fallback does not
    close a gap: the Guide's example (farmer walk, dead hang) is about the
    exercise itself being done.
18. **Stimulus tags** are two: `mechanics` (compound/isolation) and
    `position` (lengthened/shortened/mid), the two axes Handover 13 (2)
    names. A fallback covers only if both are present on both sides and
    equal. A missing tag is a mismatch, so an untagged fallback is never
    quietly counted.

## Nutrition

19. **Yields are keyed by state names, not by source ids.** A yield says
    "rice: dry to cooked x3" for a food. That way an amount in a state that
    has no source of its own (raw rice when only cooked rice is in the
    catalogue, shelled eggs when only whites are) still converts.
    A direct source for the entered state always wins over a yield.
20. **Discarded fraction comes off before the factor:**
    `to = from x (1 - discardedFraction) x factor`. For "boil eggs, discard
    the yolks", the factor is 1 and the discarded fraction is the yolk
    share. Cooking gain or loss on what's kept is the factor.
21. **Every failure is a clarification.** Unknown food, ambiguous state,
    unknown state, unknown measure, a unit in the wrong dimension (ml for a
    per-gram food; no density is ever assumed), or a bare number with no
    unit all return `{ kind: "clarify", reason, question, options }`. Nothing
    throws. A named measure that only one state carries settles the state
    ("2 egg" when only the shelled source has an `egg` measure). Through a
    yield, the amount must be in weight or volume, because the missing
    state has no measures of its own.
22. **Coverage is counted in contributions.** Every summed nutrient carries
    `{ value, known, of }`. `value` sums only the known contributions,
    `known` counts those with a number (0 included), and `of` counts all
    of them. A nutrient missing from a contribution, or null in it, is
    unknown there. Counts carry through every level (line to cook to
    portion to day), so a day's iron says "4 of 9 lines known". The
    Sheets-era kcal-weighted coverage can be derived later from the same
    data. `value` is a lower bound whenever `known < of`.
23. **Cook lines arrive resolved** (`source` + `multiples`, the output of
    `resolveAmount`), so recomputing a cook never needs to ask. A line
    with no component is in `main`. A weighed portion's fraction is
    `weighedG / cookedWeightG` of its component. A single-component cook
    may give its cooked weight on the cook itself.
24. **Cook problems are reported, not thrown.** Shares adding up to more
    than the whole, a weighed portion without a cooked weight, or a portion
    of a component the cook lacks each add a readable `problems` entry.
    The affected portion gets `fraction: null`. A remainder below 1e-9 is
    treated as none. A remainder is `unaccounted` until a mark says
    `eaten`, `leftover` or `discarded`.
25. **Manual day totals.** Following the Catalogue schema, a legacy DAY
    TOTAL counts only on a day with no items. On a day with both, the
    items win and `conflict: true` flags the day for a ruling. An empty day
    is `source: "empty"` with no totals, never a day of zeros.
26. **Remainder targets use Atwater 4/4/9** and the other macros' *goals*
    (not floors). The Guide's 1900 kcal, 130 g protein and 55 g fat leave
    221.25 g carbs, which the Guide rounds to 220. At most one macro can
    be the remainder. A remainder that would be negative, or two
    remainders, throw `RangeError`: a target is authored data, so that's a
    validation error rather than a question.
27. **"Left today"** is `goal - consumed` and goes negative when over.
    `floorLeft` is how much more is needed to reach the floor, stopping at
    0, and null without a floor. Each line carries its coverage, so a
    partially counted day can't read as a confident low-intake day. Day
    status (open/complete/partial) stays with the caller, since it is a
    stored fact rather than a calculation.
28. **Below-BMR warning** takes BMR as an input (People column N holds it
    today; how BMR is estimated is not specified) and reports how far
    below the kcal target sits.

## Body

29. **7-day average.** This is the plain mean of every fasted reading dated
    date-6 to date inclusive, so two fasted readings on one day both count,
    as an AVERAGEIFS over the Body rows would. It is unrounded (parity
    tolerance is ±0.05 kg). The window also starts no earlier than the
    latest method change on or before the date, because trends never draw
    across one.
30. **Resolution.** `isRealChange(prev, next, resolution)` takes all three in
    the same unit (inches converted to cm give a 1.27 cm step). A
    difference of exactly one step is *not* a change, which is the neck
    case in Handover 17 p3.
31. **Method-change segments.** A reading dated on a method change starts
    the new segment.
32. **Energy availability** is flagged when strictly below 25 kcal/kg FFM.
    Exercise kcal is an input (lifting, cardio and class sessions such as
    dance are summed by the caller). A non-positive FFM throws.
33. **Goal verdict.**
    - Weeks are Sunday-start calendar weeks, matching the Sheets weeks.
    - A week's reading is its latest reading. It is compared only with a
      goal point dated in the same week. A week without a goal point gets
      `no_goal_point`, never an interpolated value (triage rule 4).
    - Within ±band (default 1.0) is `on_track`.
    - Beyond it on the good side is `ahead` at once (Guide 20 states no
      waiting period).
    - Beyond it on the bad side is `behind` only when the three latest
      *consecutive calendar weeks* each have a reading outside the band. A
      week with no reading breaks the run. Until then the verdict stays
      `on_track`, with `weeksBehind` reporting the run so far.
    - `direction` says which side is bad (waist decreases, a lift
      increases).

## Added for the Worker API

34. **A recipe eaten by servings** (schema decision 30) is `recipeIntake`.
    Manual per-serving macros win over lines when both exist, because a
    recipe keeps its lines for reference until it is derived. A recipe with
    neither returns no nutrients at all, so a day counts it as unknown
    (`known < of`) instead of as 0 kcal. Servings that aren't positive throw
    `RangeError`, since the API validates them before calling.

## Closing the thin-skill gaps (ticket 27)

35. **`needs_confirmation` is a verdict, not a flag on `fired`.** A
    caller that reads only `verdict` must not move a load on reps nobody
    counted, so a rule that would fire on any inferred qualifying set
    returns `needs_confirmation` (reason `reps_inferred`) with the
    `nextLoad` it would move to and `inferredSets`, the 1-based positions
    of the inferred sets among the qualifying sets. Structural `never`,
    autoregulation and every `not_yet` reason still come first: inferred
    reps that wouldn't fire need no confirmation. An inferred set beyond
    the rule's target sets doesn't count, as it doesn't qualify.
36. **No e1RM on a bodyweight-dominant exercise.** `setDerived` takes
    `bodyweightDominant`, and when it is set the e1RM is null whatever the
    load, reps and RIR; volume is still the external load's (the old
    rule: "record volume from the external load only and leave e1RM
    blank"). It is a property of the exercise, not a load threshold: no
    ticket says how small "a small external load" is, and a goblet squat
    with 30 kg is still mostly bodyweight. `e1rm()` itself, the gymcalc
    port, stays unconditional (5).
37. **Label energy check.** `labelEnergyCheck` computes the label's
    energy by Atwater (4/4/9, `KCAL_PER_G`) and says it reconciles when
    |Atwater - stated| <= max(10% of the stated kcal, 15 kcal), the
    ticket's tolerance. Exactly at the tolerance reconciles. Over is as
    suspect as under (a macro counted twice, a per-100 g value on a
    per-serving row). Fibre isn't modelled separately: a label whose carbs
    exclude fibre usually still lands inside 10%.

## Rehearsing the import (ticket 25)

38. **Superseded by 40.** **e1RM is on the per-implement load.** `setDerived` divides the
    exact total by `implementsSharing(load)` before Epley: 1 for a `total`
    load or a unilateral per-hand / per-leg set, 2 for per_hand, per_leg,
    per_side and plates_only. Volume and `totalKg` are unchanged (every
    limb). This is the Sheets convention Hritvik ruled right (6 Oct). A
    per-side load on a bar puts half the bar on each side, so a bar-less
    cable or sled reads exactly its per-side value. `e1rm()`, the gymcalc
    port, still takes whatever load it is given (5).
39. **"Add the smallest increment" is its own increment.** A rule's
    `increment` may be `"smallest_step"` (Hritvik's override `increment
    {min_kg: 0, max_kg: 0}`): the next load is the lightest producible
    load above the current one, whatever its size, and at the top of the
    list it is `never` / `at_highest_load` like any other rule. Without an
    inventory there is no step to name, so a fired check carries
    `nextLoad: null` rather than inventing one. On an assistance list
    (negative loads) the next load is the one with less help.

## Rehearsing the import, second build (ticket 25, batch 4)

40. **The split e1RM convention** (Hritvik, batch 4), replacing 38.
    `implementsSharing` is 1 for a `total` or `plates_only` load and for
    a `per_side` load on any implement that isn't a cable (a barbell or a
    plate-loaded machine is one lift, so its e1RM is the total), and 2 for
    a per-side load on a cable and for a per-hand or per-leg load unless it
    is unilateral. Volume and the total count every limb, as before. The
    kind comes from `Implement.kind` (new, optional); per side on an
    implement of unknown kind counts as a total, since only a cable splits
    by side. A per-leg set on a stack or a bodyweight exercise is per leg,
    as the brief says "per hand / per side / per leg" for everything that
    isn't a barbell or plate-loaded machine.
41. **Reading a load's native unit** (`readNativeLoad`). Hritvik's rule
    is "the unit that makes it a whole or half number". As code:
    - stated clean (a multiple of 0.5 within 1e-9): as stated, unless its
      conversion is within 0.01 of a half number too (22 kg is 48.502 lb),
      which is ambiguous, clean in both;
    - otherwise it is the other unit's whole or half number whose exact
      conversion rounds to the stated value at the decimals it was typed
      with (9.1 kg is 20 lb at 1 dp, 33.07 lb is 15 kg at 2 dp); none (or
      two) is ambiguous, clean in neither;
    - zero is clean in any unit, and a negative (assistance) load keeps
      its sign.
    The conversion is the exact pound only. A 1/2.2 conversion would also
    read a mixed-plate load (a kg plate plus a small lb plate) as a whole
    number of pounds, which it isn't: that is what compositions are for.
42. **A load list mixes units.** `Implement.loads` takes bare numbers (in
    the implement's unit) or `{ value, unit }` amounts. `producibleLoads`
    returns `ProducibleLoad`s (`value`, `unit`, `kg`, and `plates` for a
    plate combination), lightest first by kg; `absent` loads are left out.
    Every comparison is in kg within 1e-6 (snapping) or 0.003 kg
    (progression, which absorbs an increment converted and rounded to
    0.01 of the other unit).
43. **The snap result says units.** `snapToImplement` reads a single value
    in its native unit first (a pound load typed in kg snaps onto the pound
    load), or takes a composition's plates. `value`/`unit` are that
    reading (or the matching listed load); off the list, `below`, `above`
    and `nearest` are `{ value, unit, plates? }` instead of numbers, and
    `mayExist` says the list's top is unknown and the value is above it,
    or the gym's plates aren't all known. This replaces the numbers-in-the-
    implement's-unit shape; a mixed list has no single unit to report in.
44. **Plate-loaded kit derives its loads.** An implement with `plates`
    (`available`, `absent`, `complete`) produces every symmetric per-side
    combination of the available plates, any units mixed, each plate
    assumed to come in enough pairs, at most `MAX_PLATES_PER_SIDE` (8) on
    a side (a sleeve's room; without it twelve small plates would count as
    a step). Each amount uses the fewest plates of its unit; a combination
    of one unit reads in that unit, a mixed one in kg with its plates.
    Combinations are worked out up to a cap the caller gives (default
    100 kg a side).
45. **A composition is a load.** `Load.plates` (per side, `{ value, unit,
    count }`) replaces `value`/`unit`: the per-side load is the plates'
    exact sum, and the bar or sled is the implement's `barKg` as before.
    `compositionAmount` gives the sum as one value (in the plates' unit
    when they share one, else kg), which the Worker stores beside it.
46. **The next step above an unknown top is proposed, unverified**
    (Hritvik, batch 4: "check it exists" instead of "never"). When the
    next load would go above what is known (a list whose top is unknown,
    or plates not all known) the check fires with the next normal step and
    `unverified: true`:
    - `smallest_step`: the current load plus the kind's normal step; on
      plates not all known, also when that step is lighter than the next
      known combination (an unknown plate may make it);
    - an increment: the lightest value on the kind's step from the current
      load that reaches `current + min`, else `current + min` itself;
    - in the current load's unit, skipping any load known absent.
    The normal step (`NORMAL_STEP`) per kind and unit: dumbbell 2.5 kg /
    5 lb; barbell 1.25 kg / 2.5 lb a side; plate-loaded and plates 2.5 kg /
    5 lb a side; machine, cable and fixed bar 5 kg / 10 lb; kettlebell
    4 kg / 10 lb; anything else 2.5 kg / 5 lb. No ticket gives these; they
    are the common smallest steps. A complete list at its top is still
    `never` / `at_highest_load`, and a gap inside a known list is still
    `increment_not_on_implement`: only the top is unknown.
47. **Where the load moves, with its unit.** `fired` and
    `needs_confirmation` carry `nextLoad` (the value, in its native unit),
    `nextLoadUnit`, `nextLoadPlates` for a plate combination, and
    `unverified`; autoregulation's drop carries `dropToUnit`. The numbers
    keep their old names so a single-unit list reads as before.
    `ProgressionContext.currentLoad` may be an amount in its own unit.


48. **Implausible body readings** (click test P1-2: a 700 kg weight and a
    94 in waist went in without a word). `implausibleReading(metric,
    value, previous)`, canonical units, mirrors decision 13's load check:
    a reading outside a wide adult range for its metric (`READING_BOUNDS`,
    e.g. weight 20-300 kg, waist 40-200 cm, systolic 60-260 mmHg), or, for a
    metric that changes slowly (weight, height, the circumferences), more
    than 1.25 times (or under 1/1.25 of) the last reading in the same
    method segment, since a unit slip (in for cm 2.54, lb for kg 2.2, mm
    for cm 10) is likelier than a real change that size. Skinfolds, BIA,
    blood pressure, heart rate and sleep get the range only: they move too
    much between readings. A metric with no bounds is never flagged. The
    result is a question, never a refusal.

49. **A more-than-whole cook names its shares** (click test P1-7). The
    problem "portions of X add up to 1.05, more than the whole cook" now
    ends "; shares: portion:3 40%, portion:5 35%, serving:2 30%" (each
    share by its key, percent to one decimal), so a refusal can say what
    makes the pot full, a leftover helping included. The Worker words the
    keys.

50. **Of two readings on one day, the later one is the week's.**
    `goalVerdict` takes readings in date-then-entry order (the Worker
    reads them `ORDER BY measured_on, id`) and keeps the last of a week's
    latest day, so Progress's headline verdict reads the same value as the
    chart's last point (click test: 96.5 cm "On track" beside a chart
    ending 238.8 cm on the same day).
