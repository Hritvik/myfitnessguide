# Body readings and judging progress

Readings are owner-only: log and discuss them only with the member they
belong to. `log_reading` returns the canonical value, the 7-day fasted
average, whether a change is real (beyond one resolution step) and
waist:height; `body_trends` returns trends split at method changes and
the goal verdict. Quote those; compute nothing.

## Judging progress

- **Pick one headline number and judge on it.** With six indicators
  there is always one that looks good to rationalise with. Which number
  is the member's choice (their notes); waist:height is a better single
  screen than BMI.
- **Don't react to one week.** Only a sustained miss is a trend;
  reacting to noise is how people slash calories in week four. The
  verdict from `body_trends` already applies the rule.
- **Ahead of target is not automatically good**: losing faster than
  planned costs muscle.
- In a deficit the **waist** moves and little else does; photos are the
  tiebreaker.
- Consistency beats precision: same site, same time, same conditions.

## How to take each reading

- **Weight:** morning, fasted. Only fasted readings feed the 7-day average; other weigh-ins are
  recorded with their conditions. Food and water alone swing weight by
  0.5-1 kg.
- **Waist:** weekly, at the navel, relaxed, at the end of a normal
  exhale, not sucked in.
- **Shoulders:** monthly, circumference around the widest part of the
  delts.
- **Chest** at the nipple line; **arm** at mid-bicep, flexed *or*
  relaxed and never switching, the same side always; **thigh** a fixed
  distance above the kneecap. Record side and state, and who measured
  (`measurer`); a change of measurer or method is a `method_change`.
- **Photos** every 4 weeks, kept private on the member's phone. Record
  only that they were taken; never store or ask for the images.
- **Skip:** body-fat % by caliper or bioimpedance (too noisy), calves
  and forearms.

A reading that looks under-measured gets `suspect_reason`, not deletion.

## An implausible reading

`log_reading` (and `amend` of a reading's value or unit) asks first when
a value is outside the range that metric can be (a 700 kg weight) or,
for weight, height and the tape sites, far from the member's last
reading in the same method segment (94 in for a waist last measured
96 cm). The `needs_clarification` reason is `implausible_reading`;
nothing was written, and the question usually names the unit that would
fit ("Did you mean 94 cm?").

- Put that question to the member in their words. Never answer it
  yourself, and never default to the number as given.
- They correct it (a typo, the other unit): resend with the corrected
  `value` or `unit` and the same key, without `implausible_ok`.
- They confirm the number really is right: resend unchanged with
  `implausible_ok` set to true and the same key. It is logged as given,
  not as suspect.
- They aren't sure: log nothing; or, if they want it kept anyway, resend
  with `implausible_ok` and a `suspect_reason` saying why it is doubtful.
- A wrong reading already logged is fixed with `amend` (same question
  applies) or removed with `retract`, after the member says so.
