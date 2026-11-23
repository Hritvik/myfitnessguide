# Hand checks after cutover

This checklist exercises the privileged Claude Code adapter. It is not a
member onboarding guide; normal members connect to the hosted OAuth MCP.

Run each in a fresh Claude Code session with the `myfitnessguide` MCP server
connected and the new skills installed. These write real records: run
them on cutover day as the smoke test, against real meals and sets, or
`reject` what they wrote afterwards (as the member it concerns). Tick a
box only when every "expect" line holds.

## Coach mode (gym-training)

- [ ] **"starting Upper A"** (Hritvik).
  Expect: `member_notes`, then `next_prescription` or `programme`;
  `start_session` with `origin: coach` and the template; one table with a
  Unit / kit column, the warm-up ramp written out for the first compound;
  reply ends "Next: <exercise> <load>".
- [ ] **"LPD SET 1 AT 30 kg 12 reps, 3-4 rir"**.
  Expect: one `log_set` with `exercise` "LPD" (an alias; if
  `needs_clarification` comes back, the exact question is asked and the
  retry reuses the same `idempotency_key`), `set_number: 1`, `reps: 12`,
  `load: {value: 30, unit: kg, basis: total}`, `rir: {low: 3, high: 4}`,
  `origin: coach`, `speaker: Hritvik`. The reply is one or two lines,
  quotes only what the tool returned, and ends "Next: LPD set 2 <load>".
  No read-back call. Reply in under a minute.
- [ ] **"What's next"** mid-session.
  Expect: no new reads if the prescriptions were read at the start; the
  reply is "Next: <exercise> <load>" in the template's order, nothing
  else. Before any session: `next_prescription`.
- [ ] **"There's no 15kg dumbell"**.
  Expect: `inventory` (and/or `substitute`); the nearest loads either
  side are offered from the tool, not invented; the set is logged at what
  was actually used; if the prescription's load can't be produced, a
  `programme_change` load change is offered (not applied silently); if the
  inventory wrongly lists 15 kg, the member confirms it, then
  `remove_implement_load` with the reason, and a `programme_change` is
  offered for each of its `affected_prescriptions`. No arithmetic in the
  reply.
- [ ] **"machine is taken"** late in the session.
  Expect: "come back to it" first; then `substitute`, lowest-technique
  option first; no numbers asked until the member says they did it.
- [ ] **A set reported with no RIR, then "done"**.
  Expect: the missing RIR goes on the open-items list, asked at most once
  mid-session; at close `end_session`; its `rir_needed` question is asked
  exactly once; the retry reuses the key.
- [ ] **Session end**.
  Expect: open items asked once, together; `end_session`; volume and
  each progression result reported in a few lines; a `fired` result
  applied with `programme_change`. Sets reported in bulk ("as
  prescribed") were logged with `reps_inferred: true`, so the check says
  `needs_confirmation`: one question, then `amend` of the sets in
  `confirm_set_ids` and `check_progression` again before any
  `programme_change`.
- [ ] **A timeout on `log_set`**.
  Expect: the retry sends the same arguments and the same
  `idempotency_key`; the reply says it was recorded once.

- [ ] **"what should I measure"**, or the start of a session (Hritvik).
  Expect: `staleness`; at most two gaps raised, from its `raise` and
  `next_prescription`'s `gaps`, once each.
- [ ] **A goblet squat at RIR 0 with a light dumbbell.**
  Expect: no e1RM quoted; if the exercise isn't flagged, `amend` of the
  exercise with `bodyweight_dominant` and a reason is offered.

## Asha is record-only

- [ ] **"Asha did leg press 3 × 12 at 40 kg today, what should she do
  next time?"** (Hritvik speaking).
  Expect: `start_session` for Asha with `origin: live`,
  `speaker: Hritvik`; `log_set` without RIR is fine; the reply says the
  session is a draft for Asha (48 h auto-confirm unless she rejects or
  edits it); **no** load suggestion, progression or substitute for her:
  "her trainer decides".
- [ ] Hritvik asks about Asha's back pain or readings.
  Expect: not discussed with Hritvik (owner-only health data).

## Nutrition (gym-nutrition)

- [ ] **"1/3 of fried rice (carrot 130g, broccoli 106g, rice 130g, alepa
  200g, oil 5tsp)"** (Hritvik).
  Expect: one `household_meal` with a cook "fried rice" whose lines are
  carrot 130 g, broccoli 106 g, rice 130 g, alepa 200 g and oil 5 tsp
  (`measure: tsp`), each with `provenance`; Hritvik's portion
  `fraction: 0.333…`. Rice without a state brings back
  `needs_clarification` (dry or cooked), which is asked, not guessed;
  "alepa", if not in the catalogue, brings back the closest names and the
  member picks or a food source is created. Who ate the other 2/3 is
  asked; absent members get no portion; the rest stays unaccounted until
  `mark_remainder`. The reply quotes the returned nutrients and day so far.
- [ ] **"had rice for lunch, about 150 g"** (no state).
  Expect: `log_intake` returns `needs_clarification` for the state; the
  agent asks "dry or cooked?" exactly as returned, then re-sends with the
  same key and `state` filled in. Never a guessed state.
- [ ] **"Asha had half the dal"** or a household meal with Asha's
  portion.
  Expect: `household_meal` with a portion for `member: Asha`; the reply
  says her portion is a draft until she confirms, or auto-confirms in
  48 h; the agent does not `confirm` it on her behalf.
- [ ] **A household meal where Kabir was out.**
  Expect: no portion for Kabir at all, not a portion of 0.
- [ ] **"what macros do I have left"**.
  Expect: `day_totals`; numbers quoted from it; nothing worked out by
  hand.
- [ ] **"what if I have 2 eggs and a roti for dinner"**.
  Expect: `what_if`, nothing written.
- [ ] **Asked about a day with nothing logged.**
  Expect: "nothing logged yet", never "you haven't eaten".
- [ ] **A product link or label photo for a new food.**
  Expect: `catalogue_search` first; at most two fetches before asking for
  a label photo; `upsert_food_source` without a `ref` (the API allocates
  it) with sodium (and fibre if printed), unknown micros left out, a
  protein band, `assumptions` filled. An `energy_mismatch` is put to the
  member, not overridden by the agent.
- [ ] **"the atta protein is wrong, the label says 12 g"**.
  Expect: `catalogue_dependents` first and the reach told; then an
  `amend` of the food source with a reason (never `upsert_food_source`,
  which would refuse the existing ref); no logged item edited by hand.
- [ ] **Asha, talking herself, says "yes that dal was right"**.
  Expect: `confirm` on her draft, with `speaker: Asha`.

## Scheduled Inbox run (gym-inbox, unattended)

Against a local Worker only (`npm run dev -w @myfitnessguide/worker` as the
agent's service identity, worker decision 156, with `MYFITNESSGUIDE_API_URL`
pointing at it): this one is about what a run writes with nobody
watching, so never against the live API. Synthetic texts only. From an
interactive session on that Worker, send four entries for Hritvik with
`submit_to_inbox`, then start a fresh `claude -p "/myfitnessguide:gym-inbox"`
whose myfitnessguide server has `MYFITNESSGUIDE_UNATTENDED=1`.
**A** "100 g <a food the local catalogue knows> and 50 g <another>" (clear,
two items); **B** "some of the zzq thing" (an unknown word, no amount);
**C** "Asha and I split the <known dish>" (another member named, no
share); **D** "leg press 3 × 12 at 40 kg" (training: hand run only).

- [ ] **The probe.** Expect `whoami` first, its reply carrying
  `unattended: true`, and no `confirm` in the tool list.
- [ ] **The run.**
  Expect: `inbox_entries`; `catalogue_search` and a preview for A; one
  `log_intake` with both items, no `speaker` or `origin`, and the key
  `inbox-<A's id>-write`; then `resolve_inbox_entry` `resolved` with the
  key `inbox-<A's id>-close`, a note beginning "drafted by the scheduled
  run" and both items in `records`. B, C and D stay pending with no write
  at all. No `confirm`, `learn_alias`, `upsert_food_source`, `log_set` or
  rejection attempted (none is offered). The reply gives counts and entry
  ids, with no member names and no entry text.
- [ ] **Afterwards, in the app.** A's items are Hritvik's drafts (Waiting on
  you), with origin `inbox` and no speaker in their `history`; they
  confirm by themselves after 48 h unless he acts.
- [ ] **A rerun after a crash.** Send A again as a new entry, stop the run
  after its `log_intake`, then run again. Expect: the same key, the API's
  replay, still one draft per item, and the entry then closed.
- [ ] **A rerun after A was closed.** Run again. Expect: A is not listed;
  if the run tries `inbox-<A's id>-write` anyway, the server refuses it
  as not a pending entry and nothing is written.
- [ ] **The fail-safe.** Run the same prompt with the server started
  without `MYFITNESSGUIDE_UNATTENDED`. Expect: the run sees `confirm`, stops
  and writes nothing.
