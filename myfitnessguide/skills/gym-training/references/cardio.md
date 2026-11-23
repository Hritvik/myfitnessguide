# Cardio, intervals and classes

Speeds and heart-rate bands are person-specific: read the member's
`member_notes` (their walk and hard speeds, recovery target, any test
results, suspended work) and their history through `query` over
`v_cardio_block` and `v_hr_zone`. Never use a generic chart when their
own data exists.

## Doctrine

Source: Scott Johnston, *Training for the Uphill Athlete*, cross-checked
against the concurrent-training and energy-availability literature.

- **Aerobic base first.** A member who has to walk to stay in their
  aerobic band is aerobically deficient; intervals push the threshold
  down for them. A polarised model (easy plus hard) assumes a base
  already exists. Fix the base, then add intensity.
- **Pace (or speed) at a given heart rate** is the real aerobic-fitness
  measure, not pace alone.
- **Trust the watch, not the treadmill sensor**, and don't dismiss a
  reading as sensor error on the strength of a talk test. When two
  devices agree, it's real. A device change is a method change: say so
  when logging.
- Concurrent training does not meaningfully impair hypertrophy or
  strength; the real conflict is **energy**. Walking is low-interference.
- A 5-10 min warm-up before any running.

## Prescribing

Always give numbers: the hard speed and the **walk speed**. "Walk"
without a number is how recoveries end up at threshold, recovering at a
higher heart rate than the hard round. Keep incline at 0 for short
intervals; treadmill incline motors are too slow for 30-second blocks.

## Live pacing (Coach mode)

The member is on a treadmill reading a phone. One line: the instruction,
then the number that justifies it.

> Drop the walk to 4 km/h now. You're recovering at 165, higher than the
> hard round.

- Gate each round on recovery, not the clock: go when heart rate is
  under the member's recovery target; keep walking if not.
- Stop when the starting heart rate climbs round over round or won't
  come down. Four good rounds beat six ground-out ones.
- Heart rate lags 20-40 s behind a short effort; a modest reading at the
  end of round 1 is not "too easy".

## Logging

Ask once, at the end: rounds completed, highest heart rate, the lowest
end-of-walk heart rate, total duration including warm-up and cool-down,
and the device. Then one `log_cardio` with a block per segment. Duration
is the whole block, not only the hard minutes. A dance class is
`session_type: class` with its energy cost.

Interval progression (when to add a round or speed) has no backend rule
yet; follow the member's notes.
