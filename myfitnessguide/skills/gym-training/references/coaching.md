# Coaching judgment

The tools compute loads, snapping, layoff policy, progression and gaps.
This file is the judgment around them. Person-specific facts (one
member's injuries, preferences, schedule reasons) are in `member_notes`,
not here. None of this applies to a `record_only` member.

## Presenting a session

Prescribe from `next_prescription`. Show it as one table, always the same
shape, so a phone glance finds the load:

| # | Exercise | Sets × reps @ RIR | Load | Unit / kit | Rest | Key cue |
|---|---|---|---|---|---|---|
| 1 | Hip Thrust | warm-up, then 3 × 8 @ RIR 3 | **50 lb per side** | plates, lb | 2 min | pause 1 s at lockout |
| 2 | Leg Extension | 3 × 12 @ RIR 3 | **25 kg** | pin stack, kg | 90 s | stop with 1 in reserve |

- **Unit / kit is mandatory.** Pound plates and kilo pin stacks sit side
  by side; say the unit once, up front, rather than correcting it three
  times mid-session.
- **Load is said the way it is loaded**: "20 kg bar + 10 lb per side",
  "7.5 kg per hand", using the load as the tool returned it, never a
  converted total that nothing on the floor matches.
- **Key cue** is the prescription's `cue`: the one thing that most often
  goes wrong. It pre-empts "how do I do this" between sets.
- Mark supersets in the Exercise column with their shared rest.
- Mark any exercise never loaded as **calibrate**.
- **Write out the warm-up ramp** for the first loaded compound as
  separate sets below the working load (log them as `warm_up`). Printing
  "50 lb per side" alone once got read as 25 lb, the old warm-up load,
  and three full sets were done at it.

Upper and lower alternating is what matters in a schedule; the A/B labels
only track exercise variants. Detail only the current phase; later
phases are sketches. Strength goals are won in fed phases (maintenance or
surplus), not while dieting; in a deficit, holding loads is a result.

## Layoffs and staleness

`next_prescription` returns a `layoff_policy`. Explain it in one line
and say when progression resumes. Two clocks mean different things:
days since the member trained anything is detraining; days since *this*
session ran is only a stale pattern. A stale session in an otherwise
active week is not a layoff, and cutting its loads guarantees zero
overload. "A missed session is just a missed session" was written for
one miss; if you depart from the tool's policy, say why.

A second session for the same muscles inside the soreness window (about
48 h after the first in a long while) is better swapped for cardio or
rest; offer a `programme_change` swap rather than pushing through.

## Calibrating a never-loaded exercise

1. Start light: the bottom third of a pin stack, the lightest dumbbell
   that is not trivial.
2. The first set is a probe. If it ended with 4+ in reserve, jump a real
   amount, not the progression increment.
3. Stop at the set that lands in the rep range with about 1-2 in reserve.
4. Set the prescription from the result, not from the heaviest set: if
   the heaviest set missed the rep range, the baseline is the load below.
5. A first exposure may progress the same day if the rule is already met.

Log probe sets as `calibration`, and record the baseline with
`programme_change` (`load_change`, reason "first baseline").

## Equipment taken, out of service or missing

- **Occupied, not broken:** do the rest of the session and come back to
  it. Position, not load, changes the result: an exercise run last gets
  done at a lower RIR than when it runs first, so say so.
- **Out of service:** call `substitute`. Prefer a fallback that counts as
  coverage (stimulus tags match: a compound does not replace an
  isolation, a shortened-position exercise does not replace a stretched
  one). Late in a session offer the **lowest-technique** option first;
  an unfamiliar setup when tired is how people back off for fear of
  injury.
- **Offer, then wait.** A suggested substitute is not a performed one.
  Ask for its numbers only after the member says they did it. Log it as
  `substitution` with `substituted_prescription_id`. Never change the
  prescription for a one-off outage. If no listed fallback fitted and
  the one the member used worked, record it with `amend` on the
  prescription's fallback note, so it is offered next time.
- Skipping one isolation slot is a legitimate answer; say so. No
  cross-session make-ups for an ordinary skip: one missed 3-set exercise
  is roughly 8% of that muscle's weekly volume, which is noise. An
  exercise that has **never been performed** is different: it is a gap,
  carried until done (`next_prescription` lists `gaps`).
- **The load doesn't exist** ("there's no 15 kg dumbbell"): call
  `inventory`, offer the nearest loads either side, and log what was
  actually used. If the prescription's own load can't be produced, move
  it with `programme_change` (it offers the producible loads). If the
  inventory lists a load the gym doesn't have, confirm it with the member,
  then `remove_implement_load` with the reason ("no 15 kg dumbbell at the
  gym"). It names the prescriptions whose current load was removed
  (`affected_prescriptions`); offer a `programme_change` for each. A load
  the gym has but the list lacks: `add_implement_load` once the member
  confirms it exists (a `log_set` with an off-list load offers this).

## Filling in the inventory

Nobody surveys a gym. The inventory fills up a chunk at a time:

- At most **one** inventory question per session, and only at a natural
  moment: while the member is at that kit ("while you're at the leg
  press, which plates are on that rack?"), never as a list at the start.
- `inventory_gaps` says what is unknown (plate sizes, a stack's top, a
  rack's end, a bar or sled weight), with the gaps for the next session
  first; its `ask` is the chunk to ask about.
- Record the answer straight away: `record_plates` for plates (what is
  there, what isn't, and whether that's all of them), `add_implement_load`
  / `remove_implement_load` for a stack or a rack, `amend` on the
  implement for a bar or sled weight (`bar_value`, `bar_unit`).
- An unverified step from `check_progression` is the same kind of
  question, and counts as that session's one.

## Failing for the wrong reason

If grip caps a back exercise, the back is not being trained; if balance
caps a split squat, the legs are not. Substitute or change the setup so
the target muscle is the limiter, and record the fix (see SKILL.md).

## Reading e1RM

e1RM is the **whole lift** on a barbell or a plate-loaded machine, and
**one hand, one side or one leg** on dumbbells and cables; volume always
counts both. Compare like with like: a dumbbell press e1RM is one
dumbbell's.

A bodyweight-dominant exercise (a goblet squat with a 10 kg dumbbell)
has no e1RM: the tools return none once the exercise is flagged. If one
isn't flagged yet, flag it with `amend` on the exercise
(`bodyweight_dominant`), with the reason. Plates-only machines with an
unmarked sled are comparable only with themselves (`lift_history`
already leaves them out of the best e1RM).

## Units

A gym can mix kg and lb, and the unit belongs to the item picked up; one
load list can hold both, and one bar can carry both. When only lb exists,
say "lb" explicitly. A load reported in the wrong unit is read back in
the unit that makes it a whole or half number (`log_set` says so in
`read_from`); one that is clean in both units or in neither comes back as
`unit_unclear`: ask the member, never pick. When a reported load is surprising,
question the **unit** before the effort; `log_set`'s `implausible`
warning usually means a unit slip. Plate-loaded loads are always "per
side".

## Gaps to raise

Raise at most **two** gaps per session, once each, then stay quiet.
`staleness` gives the member's overdue measurements and check-ins, most
pressing first (`raise` already holds at most two), and
`next_prescription` lists exercises never performed (`gaps`). Pick the
two that matter most today. When a member changes how often something
should happen, `set_measurement_cadence`.

## Pain and health

- **Sharp, joint or new pain: stop and say so.** A member's known,
  benign pain is in their notes.
- For a pain event, ask once, without diagnosing: where, which side,
  sharp or ache, did it spread into a limb, did it persist. Record it
  with `raise_flag` (subtype `event`) on that member. For a `record_only`
  member, the pattern goes to their trainer, not into a prescription.
- Before blaming food (or its absence) for anything, check `day_items`:
  nothing logged is not nothing eaten. A high heart rate was once blamed
  on an empty day, and two bananas turned up an hour later.
- A heart rate high for the effort, or a member who feels unwell, is a
  doctor's question: say what the numbers show, point to open `flags`,
  don't diagnose.
- Unaccustomed or heavy training raises AST/ALT for days; a blood draw
  right after it is confounded. Hypothyroidism lowers heart rate rather
  than raising it. Poor sleep undermines recovery and fat loss alike.
- Connective tissue adapts at roughly a seventh of the rate of muscle.
  Add new impact (running) slowly even when the engine feels ready.
