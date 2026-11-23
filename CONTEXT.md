# MyFitnessGuide

A household nutrition and training tracker for a small group of people. It began as Google Sheets and now runs as a database-backed app that both people and their agents write to.

## Input

**Coach mode**:
A live session in which the agent replies between sets with the next exercise and load, fast enough to act on before the next set.
_Avoid_: live logging, chat mode

**Inbox**:
The holding area where raw, unresolved entries wait until a resolver processes them.
_Avoid_: queue, backlog

**Entry**:
One thing a person reported, in their own words, before it is resolved into structured records.
_Avoid_: input, message

**Pending / Draft / Confirmed**:
The three states of an entry's records: received but unresolved, resolved but not yet accepted by a person, and accepted.
_Avoid_: unsaved, saved

**Resolver**:
Whatever turns an entry into draft records and clarifying questions: Hritvik's Claude Code session, or later a hosted model.
_Avoid_: parser, processor

**Router**:
The deterministic step that turns a member's free text into entries using the catalogue, aliases, recent history ("my usual") and today's cooks, and passes only what it can't resolve to a resolver.
_Avoid_: parser, NLP

**Alias**:
Another name for a food source, recipe, exercise or workout, learned from use or added by hand.

## Sheets transition

**Renderer**:
The role of computing and displaying derived values (macros, day totals, volume, e1RM) from raw records.
_Avoid_: view layer, formulas

**Source of truth**:
The one system whose copy of a domain's records is authoritative; exactly one per domain at any time.
_Avoid_: master, primary

**Parity check**:
A comparison of the app's recomputed values against the old Sheets formulas, which must pass before those formulas are deleted.
_Avoid_: reconciliation, diff

**Mirror**:
A per-person copy of the base catalogue that exists only to feed Sheets lookups; to be deleted, never recreated.

## Household

**Household**:
The family as one unit: its members share a catalogue, recipes, cooks and meals.
_Avoid_: family, group, account

**Member**:
One person in the household, signing in with their own identity and owning their own training and health records.
_Avoid_: user, profile

**Household meal**:
One meal occasion for the household, grouping its cooks and direct items with each member's portions.
_Avoid_: shared meal, family meal

## Nutrition

**Food Source**:
A single food in one state (for example rice, dry), with its nutrients per reference amount.
_Avoid_: ingredient, item, food

**Reference amount**:
The typed quantity that a food source's nutrients are given per (for example 100 g, dry).
_Avoid_: serving

**Measure**:
A named unit of one food source that converts to its reference amount (1 tsp, 1 egg shelled).
_Avoid_: portion, serving

**Yield**:
The conversion between two states of the same food (dry rice to cooked rice, ×3).

**Recipe**:
A reusable template of ingredient lines; a recipe of kind `idea` is a meal idea that is never eaten.
_Avoid_: dish

**Cook**:
One real preparation of food on a date, holding the actual ingredient quantities and optionally its cooked weight.
_Avoid_: batch, pot, dish

**Component**:
A separately shared part of a cook (the salad, the dressing).

**Portion**:
One person's share of one component, as a fraction or a weighed amount.
_Avoid_: serving, share (alone)

**Remainder**:
The part of a cook that no portion accounts for, until it is marked eaten, leftover or discarded.

**Intake item**:
One thing a person ate: a food source with an amount, a recipe by servings, a portion, or manual macros.
_Avoid_: nutrition row, log entry

**Manual macros**:
Nutrient values entered directly rather than derived from food sources, always carrying a reason.

**Provenance**:
How a quantity was obtained: weighed, counted, label, estimated, inferred or reconstructed.

**Dominant uncertainty**:
The single assumption that would move an intake item's numbers most, with its size in ± kcal.

**Day status**:
Whether a person's day of intake is open, complete or partial.

## Training

**Gym**:
A place where someone trains, holding its own implements. Each household member trains at a different gym.

**Implement**:
One piece of a gym's equipment (a dumbbell set, a machine stack, a loadable bar, a fixed bar), with an explicit list of the loads it can produce, each in its own unit (a list may mix kg and lb). A barbell or plate-loaded machine instead makes its loads from the gym's plates.
_Avoid_: machine, equipment item

**Plate set**:
A gym's plates of one unit: each denomination confirmed, inferred or absent, and whether every denomination is known.

**Composition**:
A load given as what was on the bar: the bar or sled and the plates on each side, whose units may mix.

**Unverified step**:
A next load above what the gym is known to have, proposed as the normal step for that implement until a member checks it exists.

**Equipment inventory**:
The full set of implements at one gym.
_Avoid_: weights list

**Exercise**:
A canonical movement on a kind of implement (for example, cable lat pulldown), with aliases for the names people actually say.
_Avoid_: lift, movement (alone)

**Session**:
One bout of training by one person on one date at one gym, either strength or cardio, draft until confirmed.
_Avoid_: workout, day

**Set**:
One effort within a session: reps against a load at a reported RIR range.

**Load**:
The weight as entered: a value, its unit, its basis (total, per side, per hand, per leg) and the implement. The total in kg is always computed, never stored rounded.
_Avoid_: weight

**Not recorded**:
The explicit state of a value that was never captured, which is distinct from blank, skipped and zero.

**Workout**:
A saved list of exercises with default sets, reps and loads that a member logs in one go, the training counterpart of a recipe. Household-level.
_Avoid_: routine, template (a session template belongs to a programme)

**Programme**:
A person's set of session templates, each an ordered list of prescriptions.
_Avoid_: plan, routine

**Prescription**:
What a template asks for on one exercise: sets, rep range, RIR target, rest, load, progression rule, cue and fallback.

**Progression rule**:
Structured data saying when a prescription's load moves and to which next producible load.

**Load change**:
A recorded move of a prescription's load, with its reason.
_Avoid_: Last Moved

**Phase**:
A dated period in a person's training, such as a base or cut phase.

**Cardio block**:
One segment of a cardio session, such as an interval or a steady stretch, with its own duration, speed, incline and heart rate.

## Body and health

**Reading**:
One measurement of one metric for one person at one time, with its unit, method and conditions.
_Avoid_: measurement, entry

**Method change**:
A dated marker that a metric or exercise is measured differently from that point on, so trends never draw across it.
_Avoid_: discontinuity, instrument change

**Blood draw**:
One sampling of blood on a date at a lab, holding its results.

**Lab result**:
One marker's value from a blood draw, with that lab's reference range.

**Flag**:
An open or resolved health or data item that must not be lost, such as an untreated result or a report never received.
_Avoid_: alert, issue

**Target**:
A dated set of intake targets for one person, with its reasoning.

**Goal point**:
A dated target value for one metric on a person's trajectory.

**Member note**:
Versioned prose about one member, or about one of their records, such as a protocol, a constraint or the reasoning behind a target.
_Avoid_: handover, guide entry
