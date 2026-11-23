# Thin skills decisions

Choices made for ticket *Thin skills on the MCP server* where the spec
was silent or ambiguous. Hritvik can veto any line.

## Shape

1. **Same names, same two skills.** `gym-training` and `gym-nutrition`
   keep their names and frontmatter `name`, so cutover replaces them in
   place and the plugin, marketplace and hook need no new entries.
2. **SKILL.md holds voice, routing and the write rules; doctrine goes in
   `references/`.** The SKILL.md body is what loads on every trigger, so
   it carries what every turn needs (who is talking, the intent → tool
   table, `idempotency_key` / `speaker` / `origin`, clarification,
   drafts, the Coach reply shape). Generic doctrine that only some turns
   need is in references the SKILL.md names: `coaching.md`, `cardio.md`,
   `body.md` for training; `catalogue.md`, `doctrine.md` for nutrition.
3. **The write rules are duplicated in both skills,** not shared. A
   `shared/` folder or symlink is what made the old plugin fragile
   (lexical `..`, cache dereferencing), and the block is short. A test
   holds both to the same required words.
4. **Body readings live in gym-training.** The decomposition sends body
   doctrine to `gym-training`; readings, trends and the goal verdict are
   progress judgment, which that skill already owns.
5. **No `scripts/`.** The API computes everything, so the skills ship no
   code.

## Behaviour

6. **Reads from this conversation count; memory doesn't.** "Never from
   memory" is read as: every number comes from a tool result in the
   current conversation. In Coach mode the prescriptions read at session
   start are reused for each "Next:" so replies stay under a minute.
7. **"Next: <exercise> <load>" uses the prescription's load, never an
   in-session bump.** A load change is a `programme_change`, decided at
   `check_progression` or `end_session`, never mid-set arithmetic.
8. **Ask before moving a load when the reps were bulk-reported.** The old
   `needs_confirmation` state has no counterpart in `check_progression`,
   so the skill keeps it as a conversational rule (one question per
   session). *Superseded by 23.*
9. **Health data is discussed only with its owner.** The agent's token
   reads everyone's notes, readings, bloods and flags (Worker decision 40),
   but the app hides them from other members, so the agent mustn't leak
   them in conversation either (decomposition: the OSA note must not reach
   Asha).
10. **Confirm and reject only for the speaker's own drafts,** and only
    when they've said so, matching Worker decision 48. Others' drafts are
    left to the 48 h auto-confirm.
11. **Asha: record, never prescribe, even when Hritvik asks for her.**
    The skill says "her trainer decides" and still logs her sessions
    (as drafts for her).
12. **"There's no 15 kg dumbbell"**: the API can add loads
    (`add_implement_load`) but not remove one, and `amend` can't touch an
    implement. So an inventory that lists a missing load is reported to
    Hritvik and recorded as a member note on the gym, never worked around
    silently. *Superseded by 26.*
13. **Household meals: the skill puts the API's suggested split to the
    speaker** rather than accepting it, since there is no automatic split.
14. **New refs come from a `query`.** `upsert_food_source` and
    `upsert_recipe` are keyed by a ref the agent supplies and replace an
    existing ref whole, so the skill warns about that and tells the model
    to look up the latest ref. A server-allocated ref would remove the
    risk; logged as a gap for the API. *Superseded by 27.*

## What left the skills (and what has no home yet)

15. **Nothing mechanical stays.** No formula, unit table, rounding or
    progression arithmetic; no Sheets range, column or row. A test fails
    on `gymcalc`, `sheet`, `config.yml`, `mirror`, "read it back" or
    `<base>` in any skill file.
16. **Person-specific numbers moved to member notes,** to be written by
    the importer (list in the migration record): Hritvik's cardio speeds and
    recovery target, the old `gap_registry` cadences, and his gym's quirks.
    (Ticket 27: the cadences are now data the importer seeds, not a
    member note; see 24.)
17. **Six mechanical rules have no backend home.** Each is held as a
    member note or skill prose until it gets one, per *Triage the rules
    the model doesn't cover yet* (ticket 27 gave the last four one, and
    the unsure `needs_confirmation` of 8; see 23-28. Carry/hold and
    interval progression remain, held as before):
    - carry and hold progression (rules are `rep_top` only);
    - interval progression (rounds first, then speed);
    - measurement staleness (`stalenessTop` is in the domain, but no tool
      exposes it);
    - e1RM blank for a small external load on a bodyweight-dominant
      exercise (the domain computes it at RIR 0);
    - the label energy-balance check in `upsert_food_source`;
    - server-allocated refs (decision 14).
18. **Meal Prep cooking techniques aren't in the skill.** The decomposition
    sends them to `gym-nutrition` (probably a reference), but the passages
    were summarised there, not quoted, and the Sheets weren't re-read for
    this ticket. Ticket 14 makes Meal Prep a household document, so the
    skill points at it (`member_notes` with `member: null`) and carries
    only the doctrine summaries and the food-safety rules.

## Test

19. **The tool list is built, not fetched.** The test imports the
    Worker's tool registry, lists it with `describeTools()` (what
    `GET /tools` serves), and passes it through the MCP server's
    `toMcpTool()`, the same path the server takes at startup. This needs
    no network and no cache file (there was none on this Mac). The live
    list from one `npm run smoke -w @myfitnessguide/mcp` (41 tools, 6 Oct) is
    pinned in `test/live-tools.txt`, and the test fails if the registry
    and the deployed list drift apart.
20. **What counts as "mentioning a tool".** Every identifier the skills
    put in backticks must be a tool, a schema field or enum value, a
    `v_*` view, or one of a short list of result words (`fired`, `snap`,
    `record_only`, …). A misspelt or invented tool fails, and so does an
    old endpoint name such as `append_meal_items`; `name(` call forms are
    checked too. Example keys and search patterns are written in quotes,
    not backticks.
21. **Its own workspace.** `app/skills` is an npm workspace with only
    vitest, importing the worker and MCP sources by relative path; it
    adds no runtime dependency to either package.
22. **No model-in-the-loop evals.** Running the skills against the live
    API would write to it, which this ticket forbids. Conversational
    behaviour is checked by hand after cutover with `test/checklist.md`.

## Ticket 27: the backend gaps closed

Built on `build/backend-gaps`. The skills now use the backend for what
they held as prose or notes.

23. **Inferred reps are a backend state.** A set reported in bulk is
    logged with the prescription's reps and `reps_inferred: true`, and
    `check_progression` returns `needs_confirmation` (with
    `confirm_set_ids`) instead of `fired`. The skill asks once, amends
    those sets, and checks again. The rule no longer depends on the model
    noticing a bulk report later.
24. **Gaps come from `staleness`.** coaching.md's "Gaps to raise" reads
    `staleness` (its `raise` holds at most two) alongside
    `next_prescription`'s `gaps`, and still raises at most two in total.
    A member changing a cadence is `set_measurement_cadence`. The
    cadences left the member-note list in the migration record; the importer
    seeds them from the old registry.
25. **e1RM on a bodyweight-dominant exercise is the backend's.** The
    "don't quote it" prose is gone: the tools return no e1RM for a flagged
    exercise, and the skill flags an unflagged one with `amend` and a
    reason. `bodyweight_dominant` is added to the test's result vocabulary,
    since it is an `amend` field (returned in `after`), not a tool input.
26. **A missing load is removed, with the member's confirmation.** The
    member note on the gym is replaced by `remove_implement_load` with
    the reason, and a `programme_change` is offered for each of its
    `affected_prescriptions`, never applied silently.
27. **Refs are the API's.** The catalogue reference says to leave `ref`
    out and quote the one returned; an existing ref is refused
    (`ref_exists`) and points at `amend`, which is how a food or recipe
    changes. A measure an existing source lacks is `add_measure`. Since
    ticket 25, an ingredient a recipe gains or loses is `add_recipe_line`
    / `remove_recipe_line`, and a yield added to an existing source is
    `add_yield`, each with the reason (a line's amount and a yield's
    factor change with `amend`).
28. **An energy mismatch is put to the member.** `energy_mismatch` from
    `upsert_food_source` or `amend` is a question about the label
    (missing macro, wrong reference amount); `energy_override_reason` is
    sent only when the label really prints those numbers.
29. **The pinned tool list is ahead of the deployed API.** The four new
    tools (`staleness`, `set_measurement_cadence`, `add_measure`,
    `remove_implement_load`) are listed in `test/live-tools.txt` under a
    "not yet deployed" block, so the tool-name test passes against the
    registry. Until the next deploy the file is not what `GET /tools`
    serves; the cutover record now requires that deploy before the swap. The
    test's routing lists include the new tools, and new tests fail if a
    closed gap's workaround (the gym note, "don't quote it", the ref
    warning, the bulk-report rule) comes back.
30. **An unverified step is one question at the gym.** When
    `check_progression` (or a `next_prescription` load) says
    `unverified`, the coach asks once, when the member is at that kit,
    whether the load exists, then records the answer with the calls in the
    check's `offer` (add it, or remove it with the reason, which records it
    absent) and checks again. An unverified load is never presented as
    settled.
31. **The inventory fills one chunk a session.** `inventory_gaps` gives
    what is unknown, next session first, and its `ask`; the coach asks at
    most one inventory question a session, at a natural moment, records it
    straight away (`record_plates`, the load-list tools, `amend` on the
    implement for a bar or sled weight), and never turns a session into a
    survey. An unverified step counts as that session's question. Mixed
    plates go into `log_set` as `plates`, never summed by the coach, and
    `unit_unclear` is put to the member. `ask`, `read_from`,
    `unit_unclear`, `bar_value` and `bar_unit` join the test's result
    vocabulary, and `record_plates` / `inventory_gaps` the pinned tool list
    (not deployed yet).

32. **Notes, cues, reasons and flags in sentence case** (click test P2-19,
    Hritvik, 8 Oct 2026). gym-training and gym-nutrition say to write them
    as to a person: a capital to start each sentence and for names, never
    in capitals for emphasis, short, with acronyms and units as written
    (RIR, BMR, BIA, TSH, e1RM, BP, HR, kg…). The app shows them as stored.
    The test pins the rule in both skills. Stored text is rewritten only
    after a preview (Worker decision 149).
33. **Two sessions on a day take `session_id`** (review of ticket 68). A
    set's template can start a later programme session early beside
    today's (Worker decision 148); gym-training then passes each set's
    `session_id`, from `start_session` or `sessions`, rather than member
    and date, which would ask which session.
