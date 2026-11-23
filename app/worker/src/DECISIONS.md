# Worker API decisions

Choices made while building the Worker API (ticket *Worker API*) where the
spec was silent or ambiguous. Each follows `CONTEXT.md` and *Agent API
surface* as closely as possible. Hritvik can veto any line.

## HTTP and transport

1. **One POST per tool, JSON both ways.** `POST /tools/<name>` takes the
   input object and answers `{ status: "ok", ... }`. `GET /tools` lists every
   tool with `name`, `group`, `description`, `write`, `endpoint` and
   `input_schema` (JSON Schema from the same zod schema that validates).
   Input that fails the schema is HTTP 400 `{ status: "invalid", issues }`.
   Unknown keys are rejected (`strict`), so a misspelt field never silently
   drops a value.
2. **`needs_clarification` is HTTP 200**, never an error: `{ status:
   "needs_clarification", reason, question, options, path }`. `path` points
   at the input field that needs the answer (`["lines", 0]`). Nothing is
   written, and the idempotency key is not used up, so the agent re-sends
   the same key with the answer.
3. **Refusals are errors** with a code: 401 no identity, 403 not a member or
   known service token, or not visible, 404 unknown record, 409 an
   idempotency key reused for a different request, 422 a database constraint.
4. **Validation library: zod 4.6.5**, pinned. It is the only runtime
   dependency besides the domain package, and its `toJSONSchema` gives the
   MCP server its schemas without a second source of truth.

## Writes

5. **One batch per write.** A write tool collects its statements and runs
   them as one D1 `batch` (a single transaction) with its `write_log` row and
   its `idempotency_key` row. Ids are allocated up front (max + 1), because
   D1 has no interactive transactions and the response must carry ids
   without a read-back. Two concurrent writes colliding on an id fail the
   batch and the call is retried (up to 3 times).
6. **Idempotency.** The request hash is SHA-256 over the tool name and the
   canonical JSON input without the key. A retry with the same key and hash
   returns the stored response with header `idempotent-replay: true`; the
   same key with a different request is 409. A concurrent duplicate that
   loses the race on the key's primary key also gets the stored response.
7. **Every touched record gets a `record_version`.** Rows without an integer
   id (join tables, `target_value`, `day_status`, `skipped_meal`,
   `exercise_tag`) aren't versioned on their own; their write is still in
   the write log.
8. **Upserts replace.** `upsert_food_source` and `upsert_recipe` take the
   whole definition: a micronutrient left out becomes unknown (NULL), and a
   recipe's lines are replaced (old lines kept as `delete` versions).
   Partial changes go through `amend`. Measures and yields given are added or
   updated; ones not mentioned are kept.

## Catalogue

9. **Amounts are stored in the source's reference unit.** The agent may say
   kg, mg or l (and `piece` for counted foods); the domain converts it, and
   the API stores the converted amount in the reference unit, which keeps
   the schema's rule (an amount unit matches the reference unit) true by
   construction. A named measure is stored as the measure. An amount in a
   state with no source of its own is stored on the source the yield leads
   to, converted.
10. **Ref or name.** `food` accepts a ref (`FS001`), which pins the state, or
    a name, which the domain resolves and asks about when the state is
    ambiguous. An unknown food's clarification offers the five closest
    names.
11. **Nutrient keys.** Totals use the domain's keys: `kcal`, `protein`,
    `carbs`, `fat`, then the micronutrients by column name (`iron_mg`).
    Price (`cost_min_inr`, `cost_max_inr`) and protein bands
    (`protein_complete` and so on) ride along as nutrients, so the domain's
    coverage counting applies to cost and bands too. A source with no band
    is unknown for every band, not 0.
12. **Cost per 25 g protein** is price ÷ protein × 25, per reference amount,
    as a min–max pair; null without a price or with no protein.
13. **Fuzzy search** scores exact name, prefix, substring, all words
    present, then all words within edit distance 1 (words of 4 letters or
    fewer) or 2. Exercise aliases count as names.
14. **Recipe dedupe** asks (`duplicate_recipe`) instead of failing on the
    unique name. A derived dish with no lines and no manual macros asks
    (`no_lines`), since it would otherwise read 0 kcal.

## Nutrition

15. **Intake items are typed by `source`:** `food` (an amount), `recipe`
    (servings) or `manual` (macros with a reason). Portions come only from
    `household_meal` and `mark_remainder`, since a portion belongs to a cook.
    A recipe of kind `idea` can't be eaten (`recipe_is_idea`).
16. **Who a household meal is about.** The meal and its cooks are
    household-level, so they follow the origin alone (confirmed in live
    chat). Each portion and its intake item follow the member it belongs
    to: the speaker's own portion is confirmed, everyone else's is a draft.
    The write log's `on_behalf_of_member_id` is NULL for the call.
17. **Every cook has at least one component.** Without `components`, the
    API creates one called `whole`. A portion names its component only when
    the cook has more than one.
18. **No automatic split.** A cook without `portions` asks (`split_needed`)
    and offers the last split used for the same recipe as `suggestion`.
    `portions: []` is an explicit "nobody ate it yet", leaving it all
    unaccounted.
19. **A cook started from a recipe** copies the recipe's lines as its
    actual quantities with provenance `inferred`, since nobody measured
    them.
20. **The domain judges a cook.** Shares over the whole, a weighed portion
    with no cooked weight, and an unknown component come from
    `recomputeCook`'s problems and are turned into questions
    (`portions_exceed_whole`, `cooked_weight_needed`, `unknown_component`).
    One portion per member per component is checked by the API
    (`duplicate_portion`) before the database's unique key would fail.
21. **`mark_remainder`** records `leftover` or `discarded` as a remainder
    disposition (`rest` unless a fraction or weight is given), and `eaten`
    as a new portion of whatever is unaccounted, with its intake item on
    the meal's date and slot.
22. **Portion intake items** default to confidence `medium`, since the
    schema requires one and a portion's provenance already says how its
    share was obtained.
23. **`day_totals`** puts the stored day status in `day_status` (the
    response's own `status` is always `ok`). Drafts count in the totals and
    `draft_items` says how many. `target` and `left` are null when no target
    is in force or when kcal or a macro has neither a goal nor a remainder.
24. **Day status writes** replace the skipped-meal list when one is given,
    and keep an earlier manual day total unless a new one is given.
25. **`targets` and `set_target` are two tools,** because reads take no
    idempotency key and writes must. The same split applies to flags, member
    notes and the programme. A second target on the same date asks
    (`target_exists`); changing one is an amend.

## Training

26. **Unilateral is per set** (migration 0012). `session_set.unilateral`
    is allowed only on `per_hand` / `per_leg`, and `v_set` now doubles a
    per-hand or per-leg value unless the set is unilateral, which is the
    domain's `totalLoad` rule. The flag is on the set, not the exercise,
    because the same exercise (a dumbbell row) is done both ways.
27. **Mapping a stored set to the domain.** A negative stored load (schema
    decision 16) becomes the domain's assisted implement with the load's
    size, so assisted sets get no volume or e1RM in both places. The set's
    bar becomes the domain implement's `barKg`. Plates per side on a
    `plates_only` implement become the domain's `plates_only` basis.
28. **Coach mode covers training records.** With origin `coach`,
    `start_session`, `log_set` and `log_cardio` write drafts whatever the
    member; `end_session` confirms them when the session is about the
    speaker's own member. Other writes in a Coach conversation follow the
    live rule.
29. **RIR.** A set that would be confirmed for a `prescribed` member needs
    a recorded RIR (`rir_needed`); `not_recorded` is refused live, since
    only imports may confirm it. A `record_only` member's missing RIR is
    stored as not recorded. A draft may leave it blank, and `end_session`
    asks for every blank one before confirming (listing the set ids).
30. **Off-list loads.** A load not on the implement's list never changes;
    the set is forced to a draft and the response carries `snap` and an
    `offer` of `add_implement_load`. `end_session` leaves such sets as
    drafts (`still_draft` with reason `off_list`).
31. **Choosing the implement.** A named or numbered implement wins. Without
    one, the only implement at the session's gym whose kind matches the
    exercise is used; several ask (`implement_needed`); none means no
    inventory and no snapping. Plates per side without a bar ask
    (`bar_needed`), unless the implement is plates-only.
32. **A load must be stated.** A set without `load` asks (`load_needed`);
    bodyweight is `"none"`, never assumed.
33. **Prescription links.** A set in a session that follows a template is
    linked to that template's prescription for the exercise. The
    progression check reads the working sets linked to the prescription in
    the given session, or in the latest session that has any.
34. **Progression rule JSON** is snake_case: `{ kind: "rep_top",
    target_sets, rep_top, rir_floor, increment?: { min, max? },
    autoregulation?: { reps_under } }`, mapped to the domain's
    `ProgressionRule`. The increment is in the implement's unit. A
    prescription without a rule, or with `kind: "manual"`, answers `never`
    with reason `no_rule` or `manual_rule`, which are API reasons beside the
    domain's.
35. **Next session.** The schedule comes from `schedule_slot` (ISO weekday
    or rotation position) and `schedule_swap`; the last session is the
    latest one following a template of the active programme. The layoff
    policy is null when the member has never trained. Gaps are
    prescriptions of the active programme never performed (a working set
    of the exercise) since the programme started, because a prescription
    has no date of its own.
36. **Substitutes** are the ranked fallbacks, then other exercises sharing
    a movement-pattern tag (covered ones first). Stimulus tags `compound` /
    `isolation` are the domain's `mechanics`, and `lengthened` /
    `shortened` / `mid` its `position`. `available` means the gym has an
    implement of the exercise's kind (bodyweight always is).
37. **`lift_history` patterns** use `*` and `?` as wildcards over the whole
    name or alias; without a wildcard the pattern is a substring. The best
    e1RM leaves out plates-only sets, which are not comparable.
38. **Pace** is minutes per km from a block's duration and distance,
    computed in the response and never stored, the same arithmetic as
    `v_cardio_block`. Neither the domain nor the schema has a rule beyond
    that.
39. **A stated weekday** (`weekday` on `start_session` and `log_cardio`) is
    checked with the domain's `checkWeekday`; a mismatch asks which is
    right (`weekday_mismatch`).

## Body and health

40. **Owner-only means read and write.** A member calling through the app
    may read and write only their own readings, blood draws, flags and
    member notes (403 `not_visible` otherwise), because every write returns
    what it computed (a 7-day average, a lab status), which would leak the
    data. The agent's service token reads and writes everyone's; its writes
    about a member other than the speaker are drafts as usual. `flags`
    without a member lists only what the caller may see. `history` of an
    owner-only record follows the same rule.
41. **Canonical units** for computed values are the same as `v_reading`'s
    (kg, cm, mmHg, bpm, h, pct, score). A reading's change is measured
    against the previous reading of the same metric and side within its
    method segment, and is a real change only beyond one resolution step
    (`isRealChange`); without a resolution it says `real_change: null`.
42. **Method changes** are recorded with `log_reading`'s `method_change`
    note (a change on the reading's date). Exercise method changes have no
    tool yet; they arrive with the import.
43. **The goal verdict** in `body_trends` uses `planned`, `absolute` goal
    points of the metric (the midpoint of a ranged goal) and the domain's
    `goalVerdict`; it runs only when the caller says which direction is
    good, since a metric alone doesn't say.
44. **Lab status** is computed as `v_lab_result` does (below, above,
    within, or null for qualitative and comparator values); the change is
    against the latest earlier plain numeric value of the same marker.
    The domain has no rule for either, so the API holds the one copy
    outside SQL.
45. **Flags are confirmed on write** (schema decision 41) and have no
    draft state, so a flag the agent raises about another member is
    written as is; the write log records on whose behalf.

## Amend, drafts and auto-confirm

46. **`amend(record, changes, reason)`** takes `{ table, id }` and a flat
    map of column changes, limited per table to the fields that are the
    record's own content. Keys, owners, links and state are never
    amendable (`not_amendable`): moving a record to another member is a
    different record, and state changes go through confirm and reject.
    Database constraints still apply (422). The response carries `before`,
    `after`, the new `version` and what was recomputed (intake nutrients,
    a cook's portions and remainder, a set's total, volume and e1RM).
    Cross-row rules are re-checked: portion shares (`portions_exceed_whole`)
    and phase overlap.
47. **An edit is acceptance.** When the member a draft is about edits it
    (or the agent talking with them does, outside Coach mode), the draft
    is confirmed in the same write. An edit by anyone else keeps it a
    draft and restarts its 48 h. An amend never turns a confirmed record
    back into a draft; its history shows who changed it and for whom.
48. **Confirm and reject** are tools taking a list of `{ table, id }`. Only
    the member a draft is about may decide it: through the app, or the
    agent while talking with that member (403 `not_yours_to_decide`
    otherwise). Only drafts can be rejected (409 for a confirmed record).
    Rejecting a portion also removes its intake item; rejecting a session
    removes its sets and blocks; a blood draw its results. A cook or a
    household meal isn't rejected whole: its portions and items are.
49. **Auto-confirm** is `autoConfirm(db, now)`, called by the Worker's
    `scheduled` handler (a Cron Trigger) with the scheduled time. A draft
    confirms once its latest version is 48 h old, so any edit restarts the
    clock. It is one write by resolver `system`, origin `auto_confirm`,
    with `resolver_detail` `provenance: inferred` and a `confirm` version
    per record: the schema has no confirmation-provenance column, and the
    quantity provenance (`weighed`, `estimated`) of the record itself must
    not be overwritten, so "recorded as provenance inferred" lives in the
    write log. Drafts created in Coach mode are skipped (they wait for
    `end_session`), and so are sets with blank RIR, which can't be
    confirmed blank; both are reported in `skipped`.

## Member notes and programme

50. **Member notes** are read with `member_notes` (latest version, or every
    version) and written with `write_member_note`. Writing the same
    member, topic and subject again adds a version rather than a second
    note. `member: null` is a household document (Meal Prep), visible to
    every member. A note's subject must be the member's own record (or a
    household one, such as a gym).
51. **`programme`, `programme_change`, and phases.** The read returns the active
    programme with templates, slots, swaps, prescriptions (current load,
    parsed rule, fallbacks) and live phases. `programme_change` takes one
    `load_change` (a load the implement can't produce asks,
    `load_not_producible`, offering the loads either side), or `swap`
    (weekday plans only). Cross-domain strategy phases are created and fully
    updated through `upsert_phase`, and reversibly retired through
    `set_phase_archived`; this keeps their validation, reason and bounds on
    one path. Live phases never overlap (`phase_overlap`).

## query

52. **How `query` is guarded.** D1 has no authorizer hook, so the SQL is
    tokenized (strings, quoted identifiers and comments handled) and
    checked: one statement (a trailing `;` is fine), starting with SELECT
    or WITH; no write, schema or transaction keyword; no `RECURSIVE`
    (unbounded work); every name after FROM, JOIN or a FROM-list comma, at
    any depth, is a `v_*` view or a CTE of the query. Schema-qualified
    names and table-valued functions (`pragma_table_info`, `json_each`) are
    refused, and a CTE may not be named like a table or view, so it can't
    shadow one. Column names that match table names (`unit`, `metric`) are
    fine, because only sources are checked.
53. **Row limit.** The query runs as `SELECT * FROM (<query>) LIMIT n+1`,
    with n defaulting to 200 and at most 1000, and the response says
    `truncated`. Parameters bind positionally.
54. **Owner-only views** (`v_reading`, `v_weight_7d`, `v_lab_result`,
    `v_flag`, `v_member_note`, `v_method_change`) are for the agent. SQL
    can't be filtered per member reliably once written, so a member's query
    that reads one is refused (403) and pointed at the typed tools.
55. **Two sources of truth.** The views compute macros only; micros,
    coverage, bands, cost and "left" come only from `day_totals` (the
    domain). A test holds the view's day kcal and protein equal to
    `day_totals`'.

## Auth and the Worker

56. **Identities.** A member is matched by the Access JWT's `email`
    (ignoring case, active members only). A service token is matched by
    its `common_name` (client id) through the `SERVICE_TOKENS` map to a
    resolver (`claude_code` or `hosted_model`); an unknown one is 403. The
    agent acts in the deployment's one household.
57. **Speaker and origin.** Agent writes say `origin` (`live` default,
    `coach`, `inbox`) and `speaker`, the member the agent is talking with;
    a live or coach write without a speaker asks (`speaker_required`). A
    member's own app write is origin `app` with the member as speaker and
    actor, so a member's write about themselves is confirmed and about
    anyone else is a draft.
58. **Fail closed.** With `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` unset, every
    request is 401. `LOCAL_DEV_IDENTITY` (for `wrangler dev --local`) is
    honoured only for requests to localhost, and belongs in `.dev.vars`,
    which is git-ignored. `GET /tools` needs an identity too.
59. **Today** is the household's date in `TIMEZONE` (default
    Asia/Kolkata), not UTC, wherever a tool defaults a date.
60. **The Cron Trigger** runs hourly (`0 * * * *`), so a draft confirms
    within an hour of reaching 48 h.

## Import (ticket *Snapshot and importer*)

61. **The importer runs the tools in process.** `src/importing.ts`
    (`importWrite`, `importRead`) validates with each tool's own zod schema
    and runs its handler, as resolver `importer` with origin `import`; the
    write log's `resolver_detail` holds the Sheets origin (file, tab, row).
    It is Node-only and never imported by the Worker entry point.
62. **Origin `import` confirms.** Imported records are the accepted Sheets
    history, so `stateFor` returns confirmed, and only the importer may
    confirm a prescribed member's set with RIR not recorded.
63. **Import-only tools** (`src/tools/import.ts`: household, member, gym,
    exercise, programme, goal point, legacy audit entry, and since ticket
    25 implement) validate and
    write-log like any tool but are not in `TOOLS`, so they are never HTTP
    routes. See `app/importer/DECISIONS.md`.

## Backend gaps the thin skills exposed (ticket 27)

64. **Inferred reps are a stored flag on the set.** `log_set` takes
    `reps_inferred` (default false) for a set reported in bulk ("done",
    "as prescribed"); the reps must still be given (the prescription's).
    `check_progression` and `end_session` pass the flag to the domain, and
    a `needs_confirmation` result adds `confirm_set_ids`, the stored sets to
    confirm. Confirming is an `amend` of each set: changing `reps` clears
    the flag (the member stated them) unless the same change sets it, and
    `reps_inferred: false` confirms them unchanged. There is no
    batch-confirm tool: a confirmation is one question and at most a
    session's worth of amends, each with its reason in the write log.
65. **Staleness is a read tool over cadences stored as data.**
    `staleness` returns `raise` (the domain's `stalenessTop`, at most
    `limit`, default 2, never-done first, ties in cadence order) and every
    active cadence with its last date, days since and days overdue. A
    cadence's last date comes from its source: the member's latest reading
    of a metric (optionally in one body state, so a fed weight is no fasted
    weight), the latest cardio block with a heart rate, the latest
    non-warm-up set of an exercise, or a `manual` date for what the app
    doesn't record (progress photos). Drafts count: a measurement taken is
    taken, whoever has yet to confirm it.
66. **`set_measurement_cadence` creates or replaces a cadence by
    (member, name).** A cadence is configuration, not history, so setting
    it again updates it in place (versioned like any record); `active:
    false` stops raising it without losing it. Cadences say when readings
    were taken, so they are owner-only like readings, for both tools.
67. **Bodyweight-dominant is a flag on the exercise, set with `amend`.**
    `exercise` is now amendable (`bodyweight_dominant`, `note`), so
    Hritvik flags an exercise once, with a reason in the write log, and
    every set of it (past and future) loses its e1RM in `log_set`,
    `lift_history` (and so its best e1RM), `amend`'s recompute and
    `v_set`. A test logs flagged and unflagged sets through `log_set` and
    holds `v_set` equal to the domain's volume and e1RM for each. The
    import-only `create_exercise` takes the flag too, but the importer has
    no source for it (the old rule was prose), so no exercise is flagged
    at import.
68. **The label energy check asks, and an override is kept on the
    record.** `upsert_food_source` runs the domain's `labelEnergyCheck`
    before writing and returns `needs_clarification` (`energy_mismatch`,
    path `kcal`, with the numbers in `energy_check`) unless
    `energy_override_reason` is given; the reason is stored on the food
    source (not only in the write log), so a later reader sees why a
    mismatching label was accepted. Every write returns `energy_check`.
    `amend` runs the same check when it changes kcal, a macro or the
    override reason, so a correction can't bypass it; a source whose
    stored values predate the check is only checked when those change.
69. **The API allocates refs; `upsert_*` only creates.** Without `ref`,
    `upsert_food_source` and `upsert_recipe` create a record under the
    next free ref: the prefix (`FS`, `R`) and one more than the highest
    number in use, zero-padded to three digits (a gap left by a deleted
    record is never reused, so an old ref in a note can't come to mean
    another food). An existing ref is refused with 409 `ref_exists`,
    naming the record and `use: "amend"`, so nothing is ever replaced
    whole. A ref the API didn't allocate is refused (`ref_not_allocated`)
    except from the importer (origin `import`), which carries the Sheets
    refs over through `importWrite`. The ref is checked before the
    duplicate-name question, so an existing ref always points at amend.
    Two concurrent creates that pick the same ref collide on the UNIQUE
    ref and are retried, like a colliding id. The tool names stay
    `upsert_*` so the MCP surface and the skills keep their words.
70. **What a whole replacement used to do now has a smaller path.**
    Changing a source's or recipe's fields is `amend` (food source,
    recipe, measure amount, and now a recipe line's `amount_value`,
    `link_status` and `note`; recipe lines carry their `id` in every
    result). Adding a measure to an existing source is the new
    `add_measure` (an existing name is refused, pointing at amend), since
    "1 katori of curd" must keep working. Still without a path, and
    deliberately: adding or removing a recipe's ingredient lines, and
    adding a yield to a source that already exists. Both are rare; a
    changed recipe can be created as a new one. Logged as follow-ups.
    **Superseded by 80.**
71. **Removing an implement load is a small tool, not `amend`.** A load
    list is rows (`implement_load`), not a field, and `amend` changes
    fields of one record. `remove_implement_load` takes the implement and
    the loads in its own unit, and requires the write's `reason` (it asks,
    `reason_needed`, without one). Each removed row keeps its last content
    as a `delete` version pointing at that write, so `history` shows when
    and why. A load that wasn't listed is reported in `not_listed`, not an
    error. Prescriptions whose current load on that implement was removed
    are returned (`affected_prescriptions`), not moved: moving a load is a
    `programme_change` with its own reason.

## Rehearsing the import (ticket 25)

72. **Superseded by 81.** **e1RM is per implement, volume counts every limb.** Hritvik's ruling
    on four typed-error rows (Log 30, 48, 88, 329) is that the Sheets
    convention is right: e1RM on one dumbbell, one leg, one side's stack or
    plates; volume on both. `log_set`, `amend`'s recompute, `lift_history`
    (and its best e1RM) and `end_session` take it from the domain's
    `setDerived`, and `v_set` from migration 0017; tests hold the two equal
    for every basis. A per_leg set covers both legs unless it is marked
    `unilateral`. The brief names per_side "cable or plate per side", so a
    plate-loaded sled (hack squat, leg press) and a barbell loaded per side
    get a per-side e1RM too; on a bar, half the bar counts to each side.
73. **Prescriptions with a duration, distance or RIR-less target.** A
    prescription's `target` is reps (default), a duration (low/high
    seconds, or none for "max time") or a distance; `sets` and the RIR
    target are optional. `next_prescription` and `programme` return
    `target` and `rir_target` (null when there is none) for every
    prescription, plus the parsed `progression_rule`, so Coach still lists
    a dead hang or a zone 2 walk as "Next". Such a prescription's rule is
    `manual` (a `rep_top` rule needs a rep target: `rule_needs_reps`), so
    `check_progression` answers `never` / `manual_rule`. A prescription on
    a cardio-machine exercise is performed by any cardio session (its work
    is cardio blocks, not sets), so it isn't a never-performed gap after
    one.
74. **Progression rule fields.** `increment` may carry its own `unit` and
    `basis` (Hritvik's overrides say "2.268 kg per hand" or "2.5 kg per
    side"); the check converts it into the load's terms: a total step is
    halved for a per-hand / per-side / per-leg load, a per-limb step
    doubled for a total load, then converted to the implement's unit and
    rounded to 0.01 (so 2.268 kg is 5 lb and 1.134 kg is 2.5 lb, exactly
    the step the rule meant). `increment: "smallest_step"` is the next
    producible load (domain 39). `rir_floor: "from_prescription"` reads
    the prescription's RIR target low end when the check runs, so amending
    the target moves the floor; a rule that defers to a missing target is
    refused at creation and answers `never` if it ever arises. `cue`
    (prose the member acts on) and `per_leg` (reps counted per leg, which
    is how sets are already logged, so the check is unchanged) are stored
    and returned. `amend` validates a changed rule with the same schema.
75. **A prescription's implement at import.** `create_programme` links a
    prescription's load to the implement named, or else to the only
    implement of the exercise's kind at the member's home gym (none or
    several leaves it unset), as `log_set` does, so "next producible
    load" has an inventory to read.
76. **Running order is explicit.** `log_set` appends a set at the end of
    its session (`position` = last + 1) or, given `position`, inserts it
    there and moves every later set down one (each move is an amend
    version in the same write, highest first so positions stay unique). A
    position past the end asks (`position_past_end`). Sets carry
    `position` in every result.
77. **The below-BMR warning reads the measured BMR.** `set_target` warns
    against `bmr_kcal` when given, else against the member's latest
    `bia_bmr_kcal` reading on or before the target's date (only when the
    caller may see that member's readings, which are owner-only), and says
    which it used (`bmr_kcal`, `bmr_source: given | reading`).
78. **`create_implement` is import-only.** It adds one implement to a
    gym with its explicit loads (deduplicated, ascending), its
    `load_list_complete` flag (false = the maximum is unknown) and a note,
    and links the prescriptions it is given: each must belong to a member
    whose home gym it is, be an exercise of the implement's kind, and have
    a load (`link_other_gym`, `link_kind_mismatch`, `link_without_load`).
    Linking is an amend version of the prescription in the same write. Live
    inventory changes stay `add_implement_load` / `remove_implement_load`.
79. **A set uses its prescription's implement.** When the gym has several
    implements of the exercise's kind (kg and lb dumbbell racks) and none
    is named, `log_set` uses the one the session template's prescription
    for that exercise is linked to before asking `implement_needed`.
80. **Recipe lines and yields have small tools, each with a reason.**
    `add_recipe_line` resolves the line like any amount and appends it
    (or inserts it at `position`, moving later lines down as amend
    versions); `remove_recipe_line` deletes one line, keeping its last
    content as a `delete` version, and refuses to empty a dish that has
    no manual macros (`no_lines`); `add_yield` links an existing source to
    another state of the same food (`yield_across_foods` otherwise) and
    refuses a second yield for the same pair (409 `yield_exists`, pointing
    at `amend`, which now covers a yield's factor, discarded fraction and
    note). All three require the write's `reason` (`reason_needed`), so the
    write log says why the recipe or the yield changed. They are small
    tools rather than `amend`, because a line or a yield is a row, not a
    field, as with `remove_implement_load` (71).

## Rehearsing the import, second build (ticket 25, batch 4)

81. **The split e1RM convention.** `derive` takes the exercise, so the
    domain's implement carries a kind: the set's implement's, else the
    exercise's kind of implement (every imported set has no implement).
    `log_set`, `amend`'s recompute, `lift_history` and `end_session` agree
    with `v_set` (0021); a test logs every basis on every kind that
    matters and holds the two equal.
82. **A reported load is read in its native unit.** `log_set`,
    `add_implement_load` and `remove_implement_load` read each value in the
    unit that makes it a whole or half number (the domain's
    `readNativeLoad`). A converted reading is stored natively (a set
    reported as 18.14 kg on a pound stack is stored as 40 lb; `log_set`
    returns `read_from` with what was said), because storing a rounded
    conversion is what the Training schema forbids. Clean in both units
    or in neither asks `unit_unclear` (path at the value; the options, and
    `candidates` as amounts, for clean in both). Two ways past the
    question: `as_stated: true` (the member confirms the unit), or a value
    that is on the implement's list exactly as stated, which is that load
    whatever its conversion. This applies at every gym, inventory or not:
    the rule is about the number, not the list.
83. **Compositions.** A load may give `plates` (per side, units mixed, each
    with a count) instead of `value`/`unit`, on a `per_side` load only
    (`bar_only_per_side` otherwise). The plates are stored as JSON with the
    sum beside them (migration 0023); `amend` accepts `plates` as a JSON
    string, validates it (`invalid_plates`) and rewrites the sum. Every
    set result carries `plates`. A per-side load with no bar given takes
    the implement's own bar weight before asking `bar_needed`.
84. **Snapping answers in units.** `snap` is the domain's new shape
    (domain 43): `value`/`unit`, neighbours as amounts, `mayExist`. An
    off-list set's `offer` is `add_implement_load` with the load as an
    amount, or `record_plates` for plate-loaded kit, and says `may_exist`.
85. **Load lists in their own units.** `add_implement_load` and
    `remove_implement_load` take numbers (the implement's unit) or
    amounts, and `as_stated`. A load equal in kg to one listed is skipped.
    Removing records the load as `absent` as well as deleting the listed
    row (its `delete` version keeps the history), and a load that wasn't
    listed is still recorded absent: that is how "there's no 45 kg pin"
    settles an unverified step, which was never on the list. Adding a load
    recorded absent makes it available again. `inventory` lists loads as
    amounts, absent loads, the bar, and the gym's plates per unit. For
    barbells and plate-loaded machines a load list is refused
    (`plates_loaded`, pointing at `record_plates`): their loads are
    combinations of the gym's plates (the domain derives them), not a list.
86. **`record_plates`** records one unit's plates at a gym: denominations
    seen (`confirmed`), not there (`absent`), and `complete` when that is
    all of them. It creates the plate set when there is none, updates a
    denomination's status in place (a version per change), and refuses a
    value given both ways. Confirmed on write (an inventory, not a member's
    record). The gym defaults to the member's or the speaker's home gym.
    A bar or sled weight is an `amend` of the implement (`bar_value`,
    `bar_unit`; `load_list_complete` and `note` too), now amendable.
87. **An unverified step.** `check_progression` (and `end_session`) pass
    the domain's `unverified` through and add `offer`: `if_exists` and
    `if_not`, the `add_implement_load` / `remove_implement_load` calls (or
    `record_plates`) that settle it. The prescribed load is read natively
    before the check. `programme_change` accepts a load above an unknown
    top (or not made by known plates) and says `unverified: true`, instead
    of `load_not_producible`, which now offers its loads as "value unit"
    strings. `next_prescription` marks such a load `unverified`.
88. **`inventory_gaps`** lists what isn't known at the member's home gym:
    a stack's or rack's unknown top (`stack_top`, `rack_end`), an unknown
    bar or sled weight (`bar_weight`, `sled_weight`), a gym with
    plate-loaded kit and no plates recorded (`plates`), and each plate set
    not complete (`plate_denominations`, naming the common denominations
    not yet confirmed or ruled out: kg 1.25 to 25, lb 2.5 to 45, plus any
    inferred). Each gap names the prescriptions it serves; gaps are ordered
    by the first upcoming prescription they serve, the next session's
    first (its prescriptions in order), then the rest of the programme, then
    gaps nothing upcoming uses. `ask` is the first: one chunk per session.
    A record-only member has no programme, so nothing ranks.
89. **Import-only inventory.** `create_implement` takes loads as numbers or
    amounts, `absent`, a `bar`, and no loads at all for plate-loaded kit;
    `create_plate_set` (import only) writes a gym's plates of one unit with
    each denomination's status, including `inferred`, which no live tool
    writes.
90. **`retract`** removes a confirmed (or draft) entry that should not
    exist: a duplicate, or one logged on the wrong day. `reject` only takes
    drafts and `amend` never turns a confirmed record back into a draft,
    so without it a confirmed duplicate could not be removed. It takes
    `records: [{ table, id }]` and a required `reason`, and works like
    `reject`: each record is deleted and its last content kept as a
    `record_version` with action `retract` (migration 0024), all in the
    call's one batch with its write log row. Only the member the entry is
    about may retract it, as the speaker: in the app, or the agent with
    `speaker` set to that member (never the Inbox); owner-only records stay
    `not_visible` to anyone else. Tables: `intake_item`, `portion`,
    `session_set`, `cardio_block`, `reading`; others are `not_retractable`.
    A portion takes its intake item with it; an intake item that is a
    portion's share is refused (`retract_the_portion`), so the cook's
    split and the day never disagree. A session is never removed, even
    with its last set gone. The result lists every record removed
    (dependents first) and `computed`: `day_totals` (the `day_totals` view
    for each date an intake item left, as if the batch had run) and
    `sessions` (`{ session_id, sets, cardio_blocks, volume_kg }` of what
    remains, working sets only for volume).

## Web follow-ups (ticket 32)

91. **One origin for the app and the API.** The Worker serves the built
    PWA (`app/web/dist`) with Workers Static Assets (`assets` in
    `wrangler.jsonc`, binding `ASSETS`). `run_worker_first` is
    `["/tools", "/tools/*"]`, so only the API's paths run the Worker code,
    which checks the Access identity as before; everything else is an
    asset, and an unknown app route falls back to `index.html`
    (`single-page-application`). The Access application already covers
    the whole hostname, so the app and the API share one sign-in. If any
    other path reaches the Worker it is handed to `ASSETS`, and `/tools`
    never is. `npm run deploy` (repo root) builds the app first.
92. **The speaker is on the write log** (`write_log.speaker_member_id`,
    migration 0025, a nullable column added in place). An agent write
    stores the member it was talking with; it is NULL for an Inbox write
    without a speaker, a member's own app write (the actor already names
    them), the importer, the system, and every write before 0025. `loggedBy`
    (used by `day_meals`, `day_cooks` and a draft's "logged by") returns
    `{ kind: "agent", origin, speaker }`, and the app names the speaker,
    saying "the agent" (or "the Inbox") only when it is NULL.
93. **A portion and its intake item move together.** They keep separate
    `state` columns, but every state change now moves both in the call's
    one batch: `confirm` of either confirms the other (each once, so a
    client naming both still works); an `amend` that confirms one (an edit
    is acceptance) confirms the other and says so in `computed.linked`;
    `reject` and `retract` of a portion already take its item, and
    rejecting a portion's item alone is refused (`reject_the_portion`), as
    retract already was. Auto-confirm confirms a portion's item with its
    portion and never ahead of it, so an edit that restarted the
    portion's 48 h holds the item too. `day_cooks`' `ask.records` is just
    the portion.
94. **A portion carries its own ±** (`portion.dominant_uncertainty`,
    `dominant_uncertainty_kcal`, migration 0026: two nullable columns
    added in place, set together, kcal never negative). `household_meal`'s
    portions take `dominant_uncertainty: { description, kcal }` like an
    item, and return it; `amend` may change both. Like provenance (schema
    decision 31) it lives on the portion, so the portion's intake item
    keeps NULL; `day_meals` (and so the day's estimate), `day_cooks`' ask
    (`plus_minus_kcal`, `uncertainty`) and `v_intake_item` read it from
    the portion. 0026 recreates `v_intake_item` and `v_day_intake` (views
    only, no data moved).
95. **Programme loads as compositions** (migration 0027: nullable
    `bar_value`, `bar_unit`, `plates` on `prescription` and
    `load_change`, added in place; `v_prescription` recreated with
    `current_bar_value`, `current_bar_unit`, `current_plates`).
    `programme_change`'s `load_change` and `create_programme`'s
    prescription load take `plates` (per side, units mixed, each with a
    count) and an optional `bar` instead of `value`/`unit`, on a
    `per_side` load only (`bar_only_per_side`), as `log_set` does (83).
    The bar defaults to the implement's own (`bar_needed` without one,
    unless plates-only); `load_value`/`load_unit` hold the per-side sum,
    as on a set. The composition is checked against the gym's plates
    (`load_not_producible` now offers `record_plates` for plate-loaded
    kit). `programme`, `next_prescription` and `programme_change` return
    the load with `bar` and `plates` (null for a plain value). The
    progression check still steps the per-side sum; stepping a mixed
    composition plate by plate is not attempted.

## D1 query budget (hotfix)

96. **Every tool call stays well inside D1's 50-query limit.** D1 on the
    Workers Free plan runs at most 50 queries per Worker invocation, and
    each statement in a batch counts on its own
    (developers.cloudflare.com/d1/platform/limits); D1 also binds at most
    100 parameters to one statement. A tool call is one invocation, so its
    caller lookup, reads, idempotency check and write batch all count. The
    rules:
    - **No query per row.** A call never runs a statement per implement,
      load, prescription, intake item, recipe, portion, cook or moved set.
      It reads a set of rows with one `IN (...)` statement through
      `allIn` (`db.ts`), which deduplicates the keys and splits them into
      chunks under the 100-parameter limit. `loadImplements` reads every
      implement's loads in one statement and the plates once per gym
      (`plate_set` joined to `plate`); `NutritionReader.items` reads the
      day's recipes, portions' cooks and cooks up front (`loadCooks`: five
      statements for any number of cooks); `day_meals` and `day_cooks`
      read portions and "logged by" for all their records at once
      (`loggedByMany`); `next_prescription` reads all fallbacks in one
      statement; `log_set` reuses the gym's implements for the
      implausible-load history and takes the next set number from the
      session's sets it already reads.
    - **Writes too.** Moving later sets down when `log_set` is given a
      `position` is two `UPDATE`s (out of the way by 1,000,000, then back
      one place further on, so positions stay unique) and multi-row
      version inserts (`WriteTx.versions`, 16 records a statement), not an
      `UPDATE` and a version per set. Same rows, same versions as before.
    - **Budgets, tested.** `test/query-budget.test.ts` counts every
      statement a call runs (`test/counting.ts`, a `Db` wrapper the
      harness puts under every test; like D1 it also refuses a statement
      binding over 100 parameters) against an invented busy household at
      a gym with 23 and with 40 implements: `log_set` at most 25 (a fresh
      Coach session, a session holding fifteen sets, and a set placed
      first ahead of twenty), and `next_prescription`,
      `check_progression`, `day_totals`, `day_meals`, `day_cooks`,
      `inventory` and `body_trends` at most 30 each. A second group
      doubles the inventory, programme and day and requires the same
      count, so a per-row query fails a test before it fails at the gym.
      At the hotfix: `log_set` 17 to 22, the reads 5 to 19, at both gym
      sizes. A new tool or path that reads per row needs the same
      treatment; raising a budget needs a reason recorded here.

## App display (spec 2026-10-06)

1. **Shared helpers in `training.ts`.** `nextSessionPlan` decides which session is next for `next_prescription`, `inventory_gaps` and `needs_you`; `cadenceStatus` gives each cadence's last date for `staleness` and `needs_you`; `prescriptionState` / `progressionOf` map `checkPrescription` to the app's chip (ready, needs confirmation, check at the gym, holding, can't move) once, for `next_prescription` and `needs_you`.
2. **`needs_you`** ranks six rules server-side (drafts about the member; today's unaccounted remainder in a pot they ate from; yesterday open with something logged; loads to act on in the next session; a flag due within 7 days; the most overdue measurement by `stalenessTop`). Rules 5 and 6 only for the member and the agent. At most 3 `cards`, the rest in `more`.
3. **Draft deadlines (`drafts.ts`)** follow `autoconfirm.ts`: 48 h after the latest version, except Coach-mode drafts ("end of session") and sets with blank RIR ("needs RIR"), which have no deadline. A portion's intake item is counted with its portion, and a leftover serving's item with its serving.
4. **0028 is additive.** The `metric`/`unit` dimension CHECK has no ratio, and rebuilding both tables now that they hold readings was not worth it: `waist_to_height` and the `ratio` unit sit under the dimensionless `score` dimension. `log_reading` refuses `waist_to_height` (computed, never measured).
5. **`set_goal_point`** is owner-only (reading visibility), requires a reason (the write log), stores the week as its Sunday, and upserts on member, metric, week and tier. A revision that omits `headline` or `note` keeps the stored ones.
6. **`body_trends` is extended additively:** `goal_points`, `current_week` (independent of the range: no goal point, no reading, or the domain verdict), `current_phase`, `headline` (waist:height when a height and a waist:height goal exist, else the first planned goal metric, headline-flagged first, with its direction), `canonical_unit`, `end_target` (never clipped by the range), and for `waist_navel` the `waist_to_height` block (band ±1.0 cm ÷ height, with its own `end_target`). The old `goal` field is unchanged.
7. **`week_summary`** is owner-only (fat-free mass). Energy availability is mean daily intake minus mean daily exercise energy over the days with something logged, over the latest BIA fat-free mass on or before the week's end; missing session energy counts 0 and is reported. Nothing logged: share and energy availability are null, with the reason.
8. **`blood_draws` results carry `change`**, so the app never subtracts lab values.
9. **`mark_remainder` on a leftover:** eating it records a leftover serving (decision 17) dated today (or the given date), outside the cook's meal, and needs the meal slot; discarded turns the whole leftover's dispositions to discarded. A leftover already gone asks `nothing_unaccounted`, so a second tap never writes a second serving.
10. **`household_overview`** returns no health fields; owner-only drafts (`reading`, `blood_draw`) are counted and listed only for someone who may see them; asks are never given (they live on Today).
11. **`sessions`** is household data; a record is a best valid e1RM above every earlier session's on the same exercise and implement (a first performance is not a record), with the same set-state filter as `lift_history` and progression.
12. **`history` names** the actor, the speaker and whose record it is. Import reasons: every import write names its row (`import <file> <tab> row <n>`), and a ruled row adds `, as ruled: <ruling>`, which the app shows as "corrected at import". Local rehearsal check (Task 18): not run: no local rehearsal data (the local D1 holds no import rows), so the row-naming counts on real imports are unchecked until the deploy.
13. **Honesty from the records:** `day_meals.honesty` (imported when the import wrote the day's items; typed-macro share, high from 0.5) and `sessions[].imported`.
14. **`whoami` returns `time_zone`**, so clock times (a draft's deadline) are shown in the household's zone.
15. **Query budgets (decision 96; D1 Free: 50 statements per invocation, batch statements counted).** Every new or changed tool here has a case in `query-budget.test.ts` over the busy household (`busyHousehold(40)`), at ≤ 30 statements, and the read-heavy ones a growth case (`twice`). Nothing queries per row, and every multi-key read goes through `allIn` (100 bound parameters): `householdDrafts` is one statement generated from `STATE_TABLES`; `checkPrescriptions`/`progressionsOf`, `cadenceStatus`, `dayViews` and `sessions` load many records at once on HEAD's `loadCooks`, `NutritionReader.prefetch`/`prefetchCooks`, `loggedByMany` and `portionInfos`; `dayView`, `loadCook`, `checkPrescription` and `loggedBy` keep their signatures over them. Counts measured with `BUDGET_REPORT=1`: needs_you 26, next_prescription 20, week_summary 20, household_overview 23 (101 open leftovers: 28), sessions 10 (120 sessions: 12, 5.0 ms wall clock in Node), body_trends 11-12, set_goal_point 12 created / 11 revised, log_reading 14, mark_remainder eating a leftover 24 / discarding 18, blood_draws 4. Retracting a leftover serving and retracting a plain portion are both at exactly 30: **no headroom**; any statement added to the retract path needs a trim first. A tool that can't fit goes to the Durable Object spike (an out-of-repo spike), never a raised budget.
16. **One auto-confirm rule.** `autoConfirmBlock` and `autoConfirmDeadline` (`autoconfirm.ts`) decide when a draft confirms by itself; the cron and `householdDrafts` both call them, so the strip's deadline is the cron's.
17. **Leftover servings (0029, Hritvik's option (a)).** A leftover eaten later is a `leftover_serving` (member, share, `eaten_on`, state) with an intake item dated that day, for any member, including one who had a portion (portion's one-per-member rule stays). The cook's remainder is portions + servings (`cookShares`; the domain already takes any shares). **The item is stored as `manual`** with the serving's macros at writing, because `intake_item.source_kind` can't gain a kind without a rebuild; readers compute it from the serving and its cook, so only `query`'s views show the stored numbers. **Pending Hritvik's confirmation:** if he prefers a fifth `source_kind`, that is a later table-rebuild migration. A leftover's dispositions get `settled_on` when it is eaten up or discarded; it bounds `household_overview`'s read (`settled_on IS NULL OR settled_on > date`) but the computed remainder is the truth, and reject, retract, a portion amended down, or an amend of a component's cooked weight or a cook line clears it in the same write. Discarding keeps `recorded_on`. A serving's item is amended, rejected and retracted only through its serving (`amend_the_serving` and the like). On a past date, Household shows that day's leftovers read-only. A serving and its item are confirmed, rejected and retracted together, like a portion and its item; only `provenance` is amendable on a serving in v1.
18. **Goal weeks are Sundays.** One builder (`goals.ts`) serves `set_goal_point` and `create_goal_point`; it stores `weekStart(week_of)`, and `set_goal_point` finds an existing goal anywhere in that week. **0028 rewrites stored data:** it moves stored goal points (the import's Mondays) to their Sundays, keeping their ids. Flagged for the deploy: the remote migration changes existing rows, and undoing it is a reverse `UPDATE`.
19. **`body_trends` resolves the headline** (`metric` omitted or `"headline"`) in one call; the current week's verdict is the domain's `goalVerdict` with `asOf`.
20. **D1 allows at most 5 terms in one compound SELECT** (measured on `wrangler d1 execute --local`: 5 runs, 6 fails with "too many terms in compound SELECT"). `householdDrafts`' `UNION ALL` over the nine state tables broke `needs_you` and `household_overview` on D1 while node:sqlite (limit 500) passed every test; the visual pass found it. The branches now nest in groups of at most 5 (still one statement), and the test database sets `limits.compoundSelect` to 5 (`test/db.ts`, pinned in `bound-params.test.ts`), so the suite refuses what D1 refuses.

## App input (spec 2026-10-06)

97. **Fixed costs in one statement each, and many rows in one statement.**
    The caller lookup reads the household's members with the caller (the
    agent's with its household), so `ctx.members()` costs nothing; a
    write's idempotency check and its write id are one statement.
    `WriteTx.reserve` takes several tables' next ids in one statement;
    `WriteTx.createMany` inserts a table's rows with `INSERT ... SELECT
    ... FROM json_each(?)` (one bound parameter, so D1's 100-parameter
    limit never applies; one statement per distinct key set, so a column
    a row omits gets its DEFAULT), and `finish()` writes the first
    version of every such row, across tables, in one more statement. `Catalogue.load` reads
    measures and yields as JSON columns of the food-source query. Same
    rows, same versions, fewer statements (decision 96).
98. **The app-input tools' budgets** (decision 96's rule: a budget
    needs its reason here). Every new or changed tool has a budget test
    at the 40-implement gym through `test/budget.ts` (the hotfix's
    helpers, moved there unchanged, and `toolWithinBudget`). `log_set`,
    by session or by member and date (finding or creating the session),
    and `preview_set` (the same planning without the write) stay at
    `LOG_SET_BUDGET`, 25. New reads (`preview_meal`, `route_text`,
    `recent_items`, `workouts`, `learned`, `inbox_entries`,
    `feedback_list`) are at `READ_BUDGET`, 30. The new writes
    (`log_workout`, `commit_route`, `create_workout` and the other
    workout writes, `learn_alias`, `forget_alias`, `submit_to_inbox`,
    `resolve_inbox_entry`, `submit_feedback`, `triage_feedback`) are at
    30 too, because each is one atomic Save of many rows (13 sets; food,
    a share of a pot and sets into a new session) and the fixed costs
    alone are 4; 30 still leaves 20 of D1's 50. A tool that can't meet
    its budget is escalated, never given a higher one.
99. **`set_day_status` is the member's own call, or the agent's**
   (Hritvik, 7 Oct 2026; a contract change he approved). Closing a day
   decides how its intake is read, so a member sets only their own day,
   as with readings (`canSee`); another member's is `not_visible` (403),
   with nothing written. The agent (the skills, the importer) still sets
   any member's, so no existing caller changes; the app offers it only on
   your own day (Today's "Close the day").
100. **`log_blood_draw` writes a draw in a constant number of statements**
   (Hritvik, 7 Oct 2026). Every result is checked before anything is
   staged; one statement reads every marker's previous result
   (`previousResults`, markers matched without case as before, ASCII
   folding like SQLite's); one `reserve` takes the draw's and the results'
   ids; the results go in one `createMany` and their first versions in
   `finish()`. About 10 statements whatever the panel (it was 3 a result,
   so a 15-result panel passed D1's 50). Same answer, same draft rule (the
   draw's state from `stateFor`). `amend` of a result stays at about 9;
   `retract` has no path over a draw (`not_retractable`); `reject` of a
   draft draw is one statement per dependent table.
101. **Recents and "my usual" read confirmed rows only** (Hritvik, 7 Oct
   2026). `recent_items` (and `route_text`'s "my usual", which shares it)
   counts intake items and sets with `state = 'confirmed'`. A draft about
   you is unconfirmed by definition (another member's entry, or Coach-mode
   sets until `end_session`), so it is never a usual; your own drafts
   count once they confirm. Portions (a share of a household cook) are
   left out of recents by design: they are a share of a pot, not an amount
   you choose. A food missing from the catalogue is skipped, and a set
   whose load is not entered never beats an entered load as the usual.
   The call groups in one pass, so its CPU does not grow with anything but
   the rows read.
102. **One meaning per word, both ways, read by every reader** (spec §6,
   7 Oct 2026). A learned word (`alias`) names one food source, recipe,
   exercise or workout. `learn_alias` refuses a word that is already a
   name (`alias_is_a_name`, or `alias_is_the_name` for its own target)
   and asks before retargeting a word (`alias_taken`; `replace: true` is a
   versioned delete and insert); every place a name is written (the create
   tools, `create_exercise`, and `amend` renaming a food source, recipe or
   workout, a change of case excepted) asks `name_is_an_alias`. A food
   alias pins its source's state like a ref. Recipes are read through
   `RecipeBook`: every recipe with its lines and aliases in one statement,
   once per call and only when an item names a recipe, so a call's recipe
   lookups cost one statement however many it names (they were two each).
103. **A preview and its write share one planner, and `household_meal`
   writes in statements constant per row shape** (spec §4, review #9; 7 Oct 2026).
   `household_meal`'s resolve-and-check step is `planMeal`, which
   `preview_meal` runs with `previewIds()` (negative ids, never stored)
   and the write runs with its `WriteTx`; both take ids through
   `IdSource`, so the remainder, portions and member totals a preview
   shows are what saving writes. `planEatenPortion` is the one rule for a
   member's later share of a pot (a second portion of the same component
   asks; shares past the whole, over portions and leftover servings,
   ask); `mark_remainder`'s unaccounted "eaten" went through it, and the
   router's preview and commit (Tasks 12 and 13) did too. Measured at
   the 40-implement gym, `household_meal` was 33 statements for one cook
   of two lines, two portions and one item, and grew by two statements
   per row (an insert and a version each), so a full family dinner
   passed D1's 50. It now reserves its six tables' ids in one statement
   and inserts each table's rows with `createMany` (decision 97): 16
   statements, the same for two cooks, five lines, six portions and two
   items (pinned in `preview-meal.tools.test.ts`). `createMany` writes one
   insert per distinct set of columns, so the count is constant per row
   shape, not absolutely: a direct item of another source kind (its own
   columns) adds one. Same rows, same first
   versions. `preview_meal` is 3 statements; `mark_remainder` eating an
   unaccounted remainder is 16.
104. **`route_text` loads once, guesses nothing, and never routes to the
   wrong member** (spec §7, §10, reviews #3, #11, #12; 7 Oct 2026). It
   writes nothing. It loads the catalogue, the recipe book, the exercises,
   the workouts and today's cooks once (five statements), the recents only
   for "my usual" or a food with no amount, the pots (`loadCooks`) only
   for "the X", and the set scope only for a set. Fuzzy suggestions stop
   at 3,000 name comparisons a call (`comparisons` in the answer). Measured
   on a 300-food catalogue at the 40-implement gym, a nine-piece line and
   a twenty-piece line each take 24 statements and reach the ceiling; the
   fuzzy part is about 3 ms of Node time, the whole call about 7 ms warm
   with its statements. A share of a pot is previewed by
   `planEatenPortion` with preview ids, which now also asks
   (`not_unaccounted`) when the component's rest is marked leftover,
   discarded or eaten: a leftover is a leftover serving (`mark_remainder`),
   never a new portion. A piece that names nothing, or reads two amounts
   ("2 eggs and 100 g curd"), is tried as its parts split on " and ".
   Every unresolved piece with words gives them as `words` (the bare words
   without amount or unit, first to last as typed, with offsets in the
   text like `span`'s), only when nothing but whitespace stands between
   the words (an amount, unit or filler between them gives none: that span
   could never be read back; `learn_alias` collapses inner whitespace to
   one space, as the router reads words): the app teaches `learn_alias` `words.text`
   and a mapping replaces only that span, so the amount stays. The work is
   bounded by the twenty pieces kept, not by the parts: past twenty, parts
   go unrouted into the too_long span; the session question (two sessions
   that day) is asked once and reused for every set; suggestions are
   searched last, only for kept pieces (never for a whole its parts
   replaced), not at all for a query over 40 characters or 4 words, with
   the query normalised once and the search stopped at the ceiling.
   "N and a half X" is one amount when N leads the piece, and " and " is
   not split only where the part before it is just that amount ("eggs 2
   and half the dal" is two pieces). Every piece is
   for the member asked about, so a text naming another member of the
   household as a whole word (any case, "Asha's" too) comes back with
   every piece unresolved (`other_member`), even the pieces that don't
   name them ("Asha, half the dal"): the "for" chip or Claude decides
   whose it is. The member's own name is no other member.
105. **`commit_route` saves a routed text in one write, every piece for
   the member given, and counts the router only for the app** (spec §7,
   §10, §11, review #3; 7 Oct 2026). Every piece is planned before
   anything is staged, and any question (it says which piece) writes
   nothing: food and recipes through `resolveItem`, a share of a pot
   through `planEatenPortion` with the write's `WriteTx` as its ids (the
   rule `route_text` previews and `mark_remainder` writes: a second
   portion of a component, a rest already marked, or shares past the
   whole ask), sets through `sessionFor` and `planSet` as `log_workout`
   does. Every piece is the given member's: another member's pieces are
   drafts (`stateFor`), and a `session_id` that is not the member's is
   refused (`not_this_member`). Each piece carries `edited` (false only
   when saved exactly as routed), so the stats are counted from the
   pieces and can't disagree with them; a member's call writes one
   `route_stat` row (`recorded_on` is the call's day, `inbox` 0), an
   agent's call writes none and returns `stats: null`. One `reserve`
   takes every table's ids; every intake item (direct and the portions')
   goes in one INSERT: the rows are given the same columns, the missing
   ones null (`intake_item`'s optional columns all default to NULL), so
   `createMany` does not split a food, recipe, manual and portion item
   into four statements. Measured at the 40-implement gym: food, a share
   and sets into a new programme session 29 statements; with a recipe and
   a manual item too, 30 (the worst case, at the budget); twenty mixed
   pieces (ten items, shares of three pots, eight sets) into one of two
   sessions that day by `session_id`, 25. About 3 ms of Node time for
   seventeen pieces.
   A routed share's item belongs to a household meal only when the pot
   has one on the piece's date and slot (the latest by id); a dinner
   share of lunch's pot has none (`household_meal_id` is nullable).
   `planEatenPortion` asks for a weighed share of a component with no
   cooked weight in the member's words, at `weighed_g` ("The Ghugni has
   no cooked weight yet, so 150 g of it can't be worked out…"; "The
   Dressing of Salad bowl" for a pot of several parts), and any other
   problem names the members whose shares raise it, never a share's key
   ("portion:3"), for `commit_route`, `route_text` and `mark_remainder`
   alike.

106. **The Inbox checks spans against the text, closes an entry once, and
   counts only the app's sends** (spec §7, §8, review #14). A span must
   equal `text.slice(start, end)` and end within the text (an end past
   it is refused even when the span's text is the tail); offsets are
   whole-text UTF-16 units, the coordinates `route_text` gives `words`
   and `span`, so Devanagari text round-trips. Blank text or note is
   refused (the table's CHECKs would otherwise fail as a 500). An entry
   is closed once, by the agent or the member it is about, with a note
   and a reason; a second close is `not_pending`. A member's app call
   to `submit_to_inbox` records its spans in `route_stat.inbox`; an
   agent's call records nothing. `inbox_entries` is one statement.
   Spans may not overlap or start or end inside a surrogate pair.
   Closing is atomic by schema: the trigger `inbox_entry_closes_once`
   (migration 0030) aborts any status change of a non-pending entry, so a
   concurrent loser's batch fails and it gets 409 `not_pending` and writes no version.
   `records` names only tables a resolution can write (a pot's line,
   `cook_line`, and a saved workout's line, `workout_line`, among them) and is refused on
   a rejection. The entry's `created_by` id stays in its versions.
   `inbox_entries` returns at most 100 (pending: the oldest; other
   statuses: the most recent, shown oldest-first) with `truncated`.
   Whoever submitted an entry about someone else cannot close it unless
   they are that member or the agent (`not_yours`, checked before the
   entry's status).

107. **One set's logic in one place** (`sets.ts`). `planSet` is log_set's
   per-set rules over a scope loaded once per call (`loadSetScope`:
   exercises with aliases, the gym's implements, the session's sets, the
   template's prescriptions, the history of every exercise named), with
   the running set number and position in memory. `log_set`,
   `preview_set`, `log_workout` and `commit_route` all plan through it;
   `stageSets` writes the planned sets in one `createMany`.
108. **Find or create the session** (`pickSession`, `sessionFor`): the
   member's strength sessions that day in one statement; several ask
   (`session_choice`, answered with `session_id`); none creates one at the
   home gym with the programme session that was next **on that date**
   (`nextSessionPlan(ctx, member, date)`), so a past day's sets take that
   day's session. A `log_workout` source that conflicts with the day's
   session asks; a plain session gets the source's link.
109. **`log_workout`** plans every set before staging any, so one question
   (it names the set) writes nothing; it returns each linked
   prescription's progression and chip state checked against the session's
   stored sets plus the staged ones (`progressionFrom`, `prescriptionState`).
110. **Previews are the writes' own code**: `preview_set` is `planSet`
   without staging; `preview_meal` is `household_meal`'s `planMeal` with
   preview ids (`IdSource`, `previewIds` in `nutrition.ts`); `route_text`'s
   share of a pot is `planEatenPortion` with preview ids. `Ctx.previewWrite()` decides draft or confirmed as the
   write would (a member's call as their own app write; the agent's as a
   live write with no speaker).
111. **The router's grammar** (`router.ts`), decided at build time:
   pieces split on , ; newline + & (and on " and " only when the whole
   names nothing); text past 1,000 characters or 20 pieces is one span for
   Claude; amounts, fractions, number words and "about"; a ceiling per unit
   (5,000 g or ml, 5 kg or l, 50 pieces or measures) past which a piece is
   unreadable; a set's load needs its unit (kg or lb), and `A x B` is A sets
   of B reps when A is a whole number up to 10 with no load given, else a
   load of A with no unit, which asks kg or lb. A bare count with no
   matching measure, or no amount, is always a choice.
112. **`route_text`** loads the catalogue, recipe book, exercises, workouts
   and today's cooks once (five statements), recents only for "my usual"
   and the pots only for "the X", and caps fuzzy suggestions at 3,000 name
   comparisons a call (`comparisons` in the answer); its budget test pins
   both (≤ 30 statements, ≤ 3,000 comparisons) on a 300-food catalogue.
113. **The router's measure travels with the pieces.** `commit_route`'s
   pieces each carry `edited`; the Worker counts them (the spec's `stats`).
   A `route_stat` row is written only for a member's app call;
   `submit_to_inbox` counts its spans as sent to the Inbox. `learned`
   gives the share saved unedited, per member per week: Sunday weeks, the
   domain's `weekStart` (as goal weeks, decision 18), over the last 26.
114. **A share of a pot is one rule** (`planEatenPortion`, taking an
   `IdSource` as `planMeal` does), for `mark_remainder`'s eaten, a routed
   "the X" previewed by `route_text` (preview ids) and written by
   `commit_route` (the write's ids): a second portion asks, and shares past
   the whole, counted over portions and leftover servings, ask.
115. **One alias store, one meaning.** Every reader reads it (exercises
   through `ExerciseIndex`, foods through `Catalogue`, where an alias pins
   the source like its ref, recipes through `RecipeBook`, which
   `findRecipe` delegates to as `findExercise` does to `ExerciseIndex`,
   workouts through `workoutByRef`, and `catalogue_search` over all four).
   `resolveItem` takes the book (required), so a call reads every recipe
   it names in one statement and none when it names none. A word that is
   a name can't be learned; a name that is a learned word can't be given
   to a food, recipe, workout or exercise, at creation or by an `amend`
   rename (`name_is_an_alias`).
116. **Feedback is owner-only**, "owner" read as everywhere in the API: the
   member it is about (its sender). A member sees and triages their own;
   the agent all. **Inbox entries** default to the caller's own for a
   member and everyone's for the agent; the agent or the entry's member
   closes one, once, with a note and a reason.
117. **Saved workouts that changed ask to keep, like recipes.** Spec §10
   names meal-then-recipe as the only multi-step plan, but §5 gives
   workouts the same prompt; the app runs it the same way (`log_workout`
   first, then the workout edits, each with its own key), so a failed edit
   leaves the session saved.
118. **Readings and their drafts in the app** (spec addendum 7 Oct 2026):
   `reading_metrics` and `health_drafts` are owner-only like readings;
   `reading_metrics` leaves out computed metrics (waist to height), and
   `health_drafts` takes who logged a draft and its deadline from
   `householdDrafts`, so the app and the strip agree. `needs_you`'s
   measurement card names a reading cadence's metric and body state.
119. **`reject` removes a draft's dependents in one statement per
   table** (a draw's results, a session's sets and blocks), their versions
   through `versions()`: a 40-result draw was about 87 statements, past
   D1's 50; now about 12. (`log_blood_draw`'s own per-result cost is
   Task 29's decision, recorded with it.)
120. **A cook's question names members, never share keys.** The domain
   names each share by its key (`portion:3`, `serving:-1`, a preview's
   negative id); every `cookProblemsToClarify` caller (`household_meal`
   and `preview_meal` through `planMeal`, `mark_remainder`, `amend`'s
   recompute, `planEatenPortion`) passes the keys' members
   (`shareNames`), and a key it doesn't know reads "someone". A weighed
   share of a component with no cooked weight asks `cooked_weight_needed`
   in one wording (`noCookedWeight`) at the share's `weighed_g`, from the
   meal, a later share and a leftover helping alike.
121. **Catalogue writes are a constant cost; `commit_route` sits one
   under the budget.** `upsert_recipe` reserves the recipe's and its
   lines' ids in one statement and inserts every line with `createMany`
   (decision 103), so 20 and 40 lines are the same 13 statements;
   `upsert_food_source` does the same for its measures (a yield is still
   one lookup and one insert each). `nextSessionPlan` reads a programme's
   slots and swaps in one statement, which takes `commit_route`'s worst
   case (food, a recipe, a manual item, a share, sets for a new programme
   session) from 30 to 29 and every other next-session reader down by one.
   What to watch: any new per-Save read in `commit_route` (another pot
   loader, a second session lookup) takes it back to the limit.
122. **Trends read confirmed readings only.** `body_trends` (its
   segments, averages, verdicts and the waist:height block, with the
   stored height it divides by) and `reading_metrics`' last reading leave
   drafts out, as recents and "my usual" do (decision 101): a reading
   someone else logged about you is unconfirmed until you confirm it, or
   the hourly auto-confirm does 48 h on, and until then it lives in
   Drafts to check (`health_drafts`). Cost: a draft's value reaches the
   Progress headline and chart up to 48 h late.
123. **A percent is a share.** The router reads "10% of the dal" and
   "10 % dal" as a fraction of 0.1, like "half the dal"; over 100%, or a
   percent with no number, is unreadable (never guessed), and a percent
   in a set line is an unreadable load.


## Desktop UI (spec 2026-10-07)

124. **"Waiting on you" is household_overview's own slice of its drafts.**
   `waiting_on_you` lists every draft about the signed-in member (owner-only
   kinds through `visibleDrafts`, so a health draft is only ever its
   member's), oldest first, at most 100 with `truncated`, each with who
   logged it, when, its deadline or why it waits. It is built from the
   one-statement draft list the call already loads, through `draftsAbout`,
   the owner filter `needs_you` and `health_drafts` share, so the member
   table's count and the list are one snapshot and no statement is added.
   No `my_drafts` tool (spec review #2). The agent has no member, so its
   list is empty.

125. **One way to a record.** `ownersOf` and `householdsOf` read the
   owners and households of many rows of one table in at most one
   statement each; `ownerOf` and `householdOf` are their one-row calls.
   How a state table finds its owner is `STATE_OWNER`, typed over
   `STATE_TABLES`, so a new state table fails the typecheck until it says.
   `loadRecords` loads records by table and id, one statement per table,
   through them; `checkRecord` refuses as `loadRecord` always did
   (not_found, then not_visible); `loadRecord` is its one-record call, so
   amend, retract, history, confirm and reject share one path, and
   `linkedPortionRecords` (with `linkedPortionRecord` its one-record call)
   reads every share's partner in at most three statements. A set's owner
   is read once per call (it was read again by each check). The drafts
   list's `DRAFT_SOURCES` still finds owners in SQL for its one statement;
   `record-access.tools.test.ts` checks it agrees with confirm and amend
   for every state table.

126. **`confirm` is set-based, and batched versions are one statement.**
   On decision 125's path, `confirm` reads every link in at most three
   statements, stages one UPDATE per table, and writes every version in
   one statement. That statement is `WriteTx.versionsAcross`, in
   `finish()`'s JSON form; `finish()` and `versions()` use it, so every
   batch of versions built in code has one SQL and no 16-a-statement
   chunks (a 40-result draw's reject versions its results in one
   statement, was three). Two INSERTs stay apart: `version()` for one
   row, and `reopenLeftovers`, which builds its marks' rows in SQL
   (json_object over remainder_disposition) with no read first; routing
   it through versionsAcross would add a read per call. D1 caps a bound
   value at 2,000,000 bytes, so a batch whose JSON passes 1.5 MB (long
   notes) splits into as many statements as it needs; below that it is
   one. A record named twice in one call is refused (one statement can't
   give it two versions), and `confirm` and `reject` take at most 200
   records, twice the app's 100-row "Waiting on you" list.
   Measured: 50 mixed records went from 223 statements (151 on decision
   125's loads) to 21, the same for 13 records naming the same tables;
   nine tables is at most 27. One record is 7. Same answer, rows and
   versions.

127. **A rename onto another record's name asks.** `amend` of a food
   source's or recipe's `name` asks `duplicate_food_source` (same name
   ignoring case, same state) or `duplicate_recipe` (same name), with the
   other record's ref, as the upserts do, instead of failing on the UNIQUE
   name with an error the app can only answer with "Refresh". One
   statement, only on a rename; a change of case of the record's own name
   is no rename.

128. **`catalogue_list` lists the catalogue; a recipe's lookup carries its
   own fields.** `catalogue_search` needs a query and stops at 50, so an
   empty search box had nothing to show (spec review #3). `catalogue_list`
   gives every food source, recipe, exercise or gym by name, 200 a page
   with `truncated` and `next_offset`, each with one hint in the same
   statement (a correlated subquery on an indexed column: measured at most
   2 ms at household scale; no GROUP BY needed). An exercise's "last done"
   is the signed-in member's, as `last_trained` is per member; the agent
   sees the household's. Workouts keep `workouts`. `describeRecipe` gains
   `meal_type`, `prep_type` and `method`, which the recipe record shows
   and `catalogue_lookup` did not return (found in planning: a field-level
   addition beside spec §8's four, from columns already loaded).

129. **"Used by" has dates.** `catalogue_dependents` gains
   `intake_dates` (the first and last `eaten_on` of the items that use the
   food or recipe, null when none), from the statement that counts them,
   so the count of statements is unchanged (6). Cooks already carried
   their dates. The intake scan has no index on `food_source_id` or
   `recipe_id`, as before; a later migration can add one if the
   catalogue's reach reads grow.

130. **`catalogue_list`'s `last_done` reads confirmed rows, up to today.**
   Same rule as decision 101: only a confirmed set in a confirmed session
   counts, and a session dated after today (a plan, or a typo) does not,
   so a draft or a future date never reads as "last done". Today is bound
   into the same statement (`ctx.today()`); no statement added.
   The rule needs both the set and its session confirmed. `last_trained`
   does not filter on state yet, so the two can disagree for a draft
   session: `last_trained` may show its day, `catalogue_list` will not.

131. **An id is never handed out twice.** `WriteTx.allocate` and
   `reserve` (which every per-table reservation goes through: the
   household meal's, `commit_route`'s, the upserts', a workout's) and
   `createMany`'s allocated ids start past the higher of the table's
   `max(id)` and the highest `record_id` `record_version` holds for that
   table, read in the same statement (`lastId`: two index seeks, no
   statement added). A rejected or retracted top record's id therefore
   stays its own, and a new record's history starts at its own `create`
   (ticket 54), instead of continuing the removed record's versions.
   An id the importer keeps (`createMany` with an `id`) is still the
   caller's to choose. No migration: record_version's UNIQUE
   (table_name, record_id, version) is the index the seek uses.
   The fix is forward-only: an id already reused in prod keeps its mixed
   history.

132. **A draft is decided once: decisions are serialized by the write-log
   id reservation, never by a read-check alone.** `confirm`, `reject`,
   `amend`'s acceptance, `end_session` and the hourly auto-confirm each
   read a record as a draft, then write in a later batch (ticket 55).
   - **What makes that safe.** Every write reserves its id,
     `max(write_log.id) + 1`, before it reads anything:
     - app.ts takes it in its first statement (the probe), and again at
       the top of each retry;
     - `autoConfirm` takes it at the top of its loop.

     Write ids are dense, so the first write that commits between a call's
     reads and its batch has taken that same id. The later batch fails on
     write_log's primary key, and the call runs again on fresh reads
     (decision 5).
   - **What the loser sees.** `confirm` and `reject` answer 409 `not_draft`
     with the record's `index`, from `decide`. A reject that loses to a
     confirm deletes nothing. The auto-confirm confirms only what is still
     a draft. An amend that loses lands as a plain amend, without accepting
     a second time. `end_session` skips the decided set.
   - **The tests that pin it.** `test/decided-once.tools.test.ts` covers
     the races (confirm against auto-confirm both ways, reject against a
     confirm and against the auto-confirm, two confirms, end_session, a
     losing amend) and the invariant itself:
     - a write about another record, landing in that window, still makes
       the call run again (and the auto-confirm);
     - the competitor's committed `write_log.id` equals the id the loser's
       first batch carried, reserved before its reads.
   - **The rule.** Every writer inserts its write_log row with an explicit
     id, reserved as `max(write_log.id) + 1` before it reads. Any change to
     write-id allocation must keep that property: an id reserved before the
     reads that collides with any write committed since. It must not become
     an id SQLite assigns (a NULL id) or one taken inside the batch (a
     `max + 1` subquery in the INSERT): either always lands, so a stale read
     would commit. Otherwise the change brings back the fallback below.
   - **When every attempt loses.** app.ts tries 3 times. Unrelated writes
     also force a re-run, so a busy moment (the agent logging sets while
     the member confirms) can use them all up. An exhausted `write_log.id`
     collision answers a retryable 503 `busy` ("The app is busy; try
     again."). Nothing landed, so the web holds it for "Try again" with the
     same key. Any other UNIQUE failure stays a 422 `constraint`. The
     auto-confirm also tries 3 times, then fails that run; the next hourly
     run picks the drafts up.
   - **The fallback (the 0031 design, not applied).** It is a migration
     adding one trigger per state table:

     ```sql
     CREATE TRIGGER <table>_decided_once BEFORE UPDATE OF state ON <table>
     WHEN OLD.state <> 'draft'
     BEGIN SELECT RAISE(ABORT, 'record_not_draft'); END;
     ```

     It needs three Worker changes:
     - `reject` first runs
       `UPDATE <table> SET state = state WHERE id IN (...)` on the records
       it names, not their dependents, so a record confirmed since it was
       read aborts the batch. The trigger is UPDATE-only, so `retract` and
       DELETEs are untouched.
     - app.ts maps `record_not_draft` to a re-run, then to 409
       `not_draft`.
     - `autoConfirm` retries on it.

     It is safe for any Worker that writes `state` only on rows it has
     just read as drafts. It was not applied because the reservation
     already serializes decisions. It would cost:
     - a migration;
     - one more reject statement;
     - a 422 window for the Worker deployed before it;
     - recreating the trigger whenever a state table is rebuilt.

## No home gym (ticket 63)

133. **A session with no gym asks the member which, with the household's
   gyms** (`gymNeeded`, reason `gym_needed`, path `["gym"]`): "Which gym
   are you at?", no tool names, the options the gyms' names in id order.
   `log_set`, `preview_set` and `log_workout` take the answer as `gym`
   (id or name, additive and optional) and create the session there;
   `start_session` asks the same question. A gym given overrides the home
   gym for a new session only: a session already there that day keeps its
   gym. An unknown name asks `unknown_gym`. The answer costs one statement
   (`gymByRef`), within `LOG_SET_BUDGET`. Setting a member's home gym
   stays out of scope.
134. **`day_meals` names a leftover helping's serving** (ticket 61):
   each item carries `leftover_serving_id` (null for anything else),
   additive beside `portion_id`, so the app removes a leftover helping as
   its serving and knows its item can't be amended (`amend_the_serving`).

## Health-derived text is owner-only (P0 privacy, 2026-10-08)

135. **Health data and every free text that can cite it are their member's
   alone, through every read path** (click-test P0-1..3). The rule is
   still "readings, bloods, flags and member notes are owner-only", but
   the coach writes their numbers into other fields, so those fields are
   owner-only too. `OwnerOnly` gains `target`, `goal_point`, `phase`,
   `prescription` and `legacy_audit`. `OWNER_ONLY` (records.ts) gains
   `target`, `goal_point`, `phase`, `prescription`, `hr_zone`,
   `member_note_version` (its owner is its note's member, through
   `OWNER_VIA`; its household through `HOUSEHOLD_VIA`) and
   `legacy_audit_entry`. `checkRecord` therefore refuses `history` and
   `amend` on them as `not_visible` to another member, which also stops
   another member amending someone's target, goal point, phase or
   prescription. `query` refuses `v_target`,
   `v_goal_point`, `v_phase`, `v_prescription` and `v_hr_zone` to every
   member caller, as it already did the reading views: a view has no row
   filter, so changing that needs a migration (a household view without
   the text); nothing in the app queries them.
   The numbers stay household-visible where the app uses them:
   `day_totals`, `household_overview` and the other day views show
   another member's kcal and protein target and what is left, never the
   reasoning (they never carried it). `targets` gives another member the
   values and resolved macros without `reasoning`.
   `next_prescription` and `programme` give another member `cue` and
   `fallback_note` as null (the fallback exercises' names stay), and
   `programme` gives another member's phases with `intent` null.
   Lift goal points are owner-only with the body ones: nothing reads
   them yet (ticket 45 will need a read that shares them, if it should).
   Checked and left household-visible: nutrition, the catalogue and Inbox
   entries (ticket 37's note). Training's free text and a write's reason
   in `history` were left too, then ruled owner-only (decision 137).
   Test: `owner-only-sweep.tools.test.ts`.

## Query is the agent's tool (8 Oct 2026)

136. **A signed-in member cannot call `query`.** A click test found that a
   member's own SQL could read owner-only rows: `FROM (v_target)` or
   `FROM (target)` slipped past the read guard, which took a parenthesis
   after FROM as a subquery and never checked the name inside. The app never
   calls `query`; the agent (no member) keeps it unchanged. The guard is
   fixed separately (fix/p0-privacy); this refusal stays as defence in depth
   until a member-facing need for raw SQL exists.

## Training's free text is owner-only (Hritvik's ruling, 8 Oct 2026)

137. **Free text on training records is its member's alone; the training
   itself stays household data.** *(Superseded in part by decision 167,
   22 Oct 2026: `session.note`, `session_set.note`, `cardio_block.note` and
   `load_change.reason` are household data now; a prescription's coach notes,
   a swap's reason and phases stay the member's alone. The rest below holds.)*
   Another member still sees the sessions,
   dates, templates, sets, loads, reps and cardio numbers, and gets null
   for: `OWNER_TEXT` (tools/records.ts) — `session.note`,
   `session_set.note`, `cardio_block.note`, `load_change.reason`,
   `schedule_swap.reason` — and `prescription_fallback.note`
   (`substitute`). `load_change` and `schedule_swap` now find their
   member through `OWNER_VIA` (prescription's programme; programme).
   - `history` of another member's record keeps who, when and what changed;
     each version's `OWNER_TEXT` fields are null and **every version's write
     `reason` is null** (the agent's or a member's words). A household
     record (owner null) and your own keep their reasons.
   - `amend` of another member's session or set shows `before`/`after`
     without their text; a field the amend itself writes comes back.
   - `programme` gives another member no phases (`phases: []`,
     `current_phase: null`; names, stance and intent all cite goals) and
     swaps with `reason` null.
   - `query`: `v_session` (phase names) and `v_cardio_block` (`b.*` holds the
     note) join the owner-only views; changing them is a migration. `v_set`
     has no text.
   - Checked and already without text: `last_trained`,
     `household_overview`, `needs_you` and the drafts list
     (summaries are names and dates), `week_summary` (owner-only).
     (`sessions`, `describeSet` and `lift_history` carry the set and cardio
     text now, per decision 167.)
   Test: `owner-only-training-text.tools.test.ts`.

## A parenthesized source is a source; programmes are their member's (8 Oct 2026)

138. **`checkQuery` keeps expecting a source inside a "(" that follows
   FROM, JOIN or a FROM-list comma**, unless the next word is SELECT, WITH
   or VALUES (a subquery). SQLite reads `FROM (name)`, `FROM ((name))` and
   `FROM (a JOIN b ON …)` as table references, so before this a name inside
   was never checked: `FROM (target)` read a raw table, for the agent too.
   Members are refused `query` outright (decision 136, kept as defence in
   depth); `memberRefusal` (tools/query.ts) is the gate a member-facing
   query must pass if that is ever lifted: every owner-only view it reads,
   and any word or quoted name anywhere that names an owner-only view or a
   raw table (`unit` and `metric` excepted: reference tables whose names
   are view columns). Test: `query-paren-source.tools.test.ts`.
   With it, the rest of a programme's coach text: a progression rule's
   `cue` is left out of `next_prescription` and `programme` for another
   member (`ruleShown`). `programme_change` and `set_target` refuse another
   member as `not_visible` (the member or the agent changes them), as
   `amend` already did since decision 135.

## Click-test P1 fixes (8 Oct 2026)

139. **An implausible reading asks first; the usual unit is per metric**
   (click test P1-2). `log_reading` checks the value with the domain's
   `implausibleReading` (domain decision 48) against the member's last
   confirmed reading of the metric on the same side in the same method
   segment (none when this reading starts a segment), and asks
   `implausible_reading` (path `["implausible_ok"]`, no options) before
   writing anything: "94 in (238.8 cm) is outside the range a waist at
   navel can be (40 to 200 cm). Did you mean 94 cm? If 94 in is right,
   say so." The "Did you mean" names the first other unit of the
   dimension in which the typed number would be plausible. The answer is
   `implausible_ok: true` (additive, optional), which logs it as typed,
   not suspect. `amend` of a reading's `value` or `unit` asks the same
   (compared with the reading before it, never itself) and takes the same
   `implausible_ok`. The importer's history is never asked about.
   `reading_metrics` gives each metric's `usual_unit` (additive): the
   unit the member's confirmed readings of that metric use most, the more
   recent on a tie, else the canonical unit; one grouped statement, four
   in all. The last reading's unit stays in `last`.
140. **`reading_metrics` lists the member's recent readings to fix**
   (click test P1-3). `recent` (additive): the member's latest 30
   confirmed readings, newest first, each with its id, metric, date,
   value, unit, side and body state, so the app can offer Edit (`amend`
   of value, unit, measured_on; already AMENDABLE, and asked about like a
   new reading, decision 139) and Remove (`retract`; already
   RETRACTABLE). One statement, so `reading_metrics` is five in all,
   within its budget. Owner-only as before; drafts stay in
   `health_drafts`.
141. **A pot shows the leftover helpings eaten from it, and a share
   refused as more than the pot names every share** (click test P1-7).
   `day_cooks` (and `household_overview`'s cooks, through `cooksOn`)
   gives each component `leftovers` (additive): each leftover serving's
   id, member, `you`, fraction (computeCook's, null for an unworked weighed
   one) and the day it was eaten, in the order eaten. With the shares and
   the remainder, that is the whole pot; before, a fully eaten leftover
   left a gap and a share change was refused for no visible reason. No
   statement is added (the servings were already loaded). The
   `portions_exceed_whole` question keeps its reason and ends with the
   shares (domain decision 49), a serving worded "leftover eaten by
   Hritvik 30%".
142. **The implausible-reading question tells only the reading's owner
   their earlier value** (review round). When the speaker isn't the
   reading's member (the agent logging a draft for someone else), the
   far-from-last question says "far from the last <metric> reading" with
   no earlier value or date, and the clarification's `implausible` extra
   carries only its kind. The out-of-range wording names only the typed
   value and the metric's fixed range, so it is unchanged.

## Click test, friction and polish (8 Oct 2026)

143. **A near-spelling is a fallback, not a match, judged per kind.**
   `catalogue_search` drops a kind's hits found only by near-spelling
   (every query word within an edit distance of a word, `NEAR_SPELLING`)
   when that kind has a better hit (name, prefix, substring, spacing or
   whole word): "rice" no longer offers a whey whose name has "Rich". A
   kind with only near-spellings keeps them all when nothing of any kind
   matched better ("musterd oil" still finds Mustard oil), else its first
   two at the bottom, so a recipe matching "peer" never hides the Pear a
   typo meant (review round). `fuzzyRank` (clarification options) is
   unchanged.
144. **Reps in reserve belongs to counted reps.** A set with no reps,
   counted by `duration_s` or `distance` (a hang, a plank, a treadmill
   line, a carry), is not asked `rir_needed`: with no RIR it is stored
   as `not_recorded` and confirms, for any member and any origin (decision
   29's "only imports confirm not recorded" stays for counted sets). A
   RIR given on such a set is kept. `describeSet` (`sessions`, `log_set`,
   `log_workout`) also returns the set's `duration_s` and `distance`
   (`{value, unit}`), additive and null for a counted set, so the app can
   say "26 min 40 s" rather than "? ×".
145. **`sessions` names a session's cardio blocks** (click test P2-20):
   `cardio` gains `block_ids` (in id order), additive, in the same
   statement that counts them, so the app can retract or amend them.
   `retract` and `amend` already took `cardio_block`.
146. **A session can be retracted once it holds no sets** (review of
   click test P2-20). `retract` takes `session` (its member's own, as
   every retract): refused with `session_has_sets` while a set is still in
   it (sets retracted in the same call don't count); any cardio blocks
   left go with it, as a rejected session's do. Removing a cardio or class
   session in the app retracts its blocks and then the session, so its
   card and its `energy_kcal` (week_summary's exercise energy) go too.
   `computed.sessions` leaves out a session that was removed.

## Click test P2 follow-ups (ticket 68, 8 Oct 2026)

147. **`amend` changes a food item's measure in place** (click test P2-8,
   Claude's call). On an `intake_item` of a food, `changes` may carry
   `measure` (a named measure of the food) or `unit` (`mg`, `g`, `kg`,
   `ml`, `l`, `piece`), never both, always with `amount_value`. The amount
   is resolved through the catalogue exactly as `log_intake` resolves one,
   with the item's food pinned by its ref (so its state stays): a measure
   is stored as entered, a unit in the food's reference unit, and the
   nutrients come back recomputed. An unknown measure or a unit the food
   isn't measured in asks as `log_intake` does (`unknown_measure`,
   `unit_mismatch`, at `changes.measure` / `changes.unit`); a measure with
   no amount asks `amount_needed`; a measure on any other item is
   `not_amendable`. Every version is kept, as for any amend. A set's load
   is still changed by retracting it and logging it again, since `log_set`
   checks a load against the gym's inventory. `day_meals` gives a food
   item its `food` (`ref`, `reference_unit`, `measures`), additive, for the
   app's Edit.
148. **`log_set` and `preview_set` take `template`** (click test P2-16,
   Claude's call). With member and date, `template` names the programme
   session the set's session follows, resolved as `log_workout`'s
   `{kind: "programme", template}` source is: the member's strength
   session that day following it is taken; else a lone plain session that
   day, which takes the template; else a new session is created as it
   (early, today), beside any session that day following something else,
   rather than joining it or asking (the next set with the same template
   finds it). The set links to that session's prescriptions. An unknown
   name asks `unknown_template` at `template`; with `session_id` it is
   refused (`session_or_member`). Without it, nothing changes: the
   session that day, or the schedule's next as of the date.
149. **All-caps notes get a previewed, versioned rewrite, never a silent
   one** (click test P2-19, Hritvik). Existing data is not rewritten by
   any build. `app/worker/scripts/sentence-case-preview.ts` reads rows
   (`{id, table, field, text}`, JSON on stdin) and proposes a sentence-case
   rewrite of each (`--md` for a before/after list), writing nothing: known
   acronyms and units keep their form (RIR, BMR, BIA, TSH, e1RM, BP, HR, DB,
   EZ, SS-A, kg, lb, km…), month and weekday names, the household's names,
   "I", "Zone 2" and "Upper A" are capitalised, quoted text is kept, and
   each sentence, line and bullet starts with a capital. In shouted text
   every other all-caps word is lowercased; in ordinary text only an
   emphasised common or long word, so an unknown acronym stays. `review`
   names short words it lowercased that read like acronyms. Hritvik sees
   the before and after first; the rewrite then goes through `amend` / the
   note tools, so each original stays in history. The skills now write in
   sentence case (skills decision 32).
150. **Near-spellings rank by closeness, and the closest survives a
   same-kind prefix hit** (amends decision 143; click test P2-4 left
   over). A near-spelling's score is 20 when its words are one letter off
   in all, one less for each further letter (never below 1, never above
   20), so `catalogue_search` and `fuzzyRank` list the closer first;
   between equally close ones `catalogue_search` puts the name nearer the
   whole query first ("beat": Beet before Bean sprouts), then catalogue
   order. A kind with a better hit keeps its single closest near-spelling,
   so "beat" still finds Beet beside Beaten egg, unless the query is
   spelled out, every word whole, in a better hit's name or alias ("rice"
   with Rice present still offers no whey's "Rich"; "beet" with Beet no
   Beef). A kind with only near-spellings is unchanged: all of them when
   nothing matched better, else its first two at the bottom.
151. **A treadmill line in a workout is a cardio block** (click test P2-13
   left over). In `log_workout`, a line on a cardio-machine exercise with
   no reps (its duration or distance) is stored as a `steady` cardio block
   in the session the sets go into, after any blocks it already has
   (`activity` the exercise's name, its `note` kept), in the same write;
   it comes back in `cardio` (`index` its line, `id`, `activity`,
   `duration_s`, `distance`, `position`), additive, and is no longer in
   `sets`. The block keeps the line's `steps`, and a `warm_up` line is a
   `warm_up` block (any other set type is `steady`). A counted line on
   such a machine stays a set, and so does a line naming its
   `prescription_id` or `substituted_prescription_id`, so that
   prescription keeps its progression (review P1-2). A session holding
   a block performs a cardio-machine prescription, as a cardio session
   does (decision 73), and `save_session_as_workout` turns such a block
   back into a one-set line after the sets, so a saved workout keeps its
   treadmill. It never drops a block (review P2): a session with no sets
   (cardio alone, a class) still asks `no_sets`, and a block that names no
   cardio machine, or has no duration or distance, asks
   `block_not_a_line`, naming it, and saves nothing. `log_set` is unchanged.
152. **A draft's author may withdraw it while nobody has consented to it**
   (ticket 69; amends decision 125's `decide()`). `reject` also allows the
   speaker (a member in the app, or the member the agent is talking with)
   who logged a draft, by `drafts.ts`'s own `logged_by` (the first
   version's `coalesce(actor_member_id, speaker_member_id)`, read by
   `authorsOf` in one statement, only when a reject names a draft that is
   not the speaker's own). Never once any version of the record had it
   confirmed (the member consented; a re-draft by decision 153 doesn't
   reopen that), and never from the Inbox, as `retract` refuses it. The
   reject is still written on behalf of the member it is about, and a
   portion still takes its intake item. `confirm` and `retract` keep the
   member-only rule: an author confirming their own draft about someone
   else would defeat the draft.
153. **Another member's edit makes a confirmed record a draft again**
   (ticket 69, Hritvik's ruling of 8 Oct 2026). `amend` of a member's
   confirmed state record (`STATE_TABLES` with an owner) by anyone for
   whom `stateFor(owner)` is a draft (another member, the agent talking
   with another member, or the Inbox) sets `state = 'draft'` and clears
   `confirmed_at`, its share and intake item moving together, so the
   member is asked again; auto-confirm's 48 h runs from that edit, as
   from any version. The result adds `state` and, for a draft about
   another member, `draft_for` (the member's name), as `log_intake`'s
   items say state and member. A draft that isn't the speaker's stays a
   draft; the member's own edit is unchanged (a draft about them confirms,
   decision of `amend`). Household records (cook, household_meal, the
   catalogue) have no member to ask and keep their state. Kept: a
   confirmed set's recorded RIR can't be blanked by anyone (the check
   runs before the re-draft). A record created in Coach mode that was
   once confirmed no longer waits for `end_session` when re-drafted
   (`autoConfirmBlock` reads `everConfirmedSql`, in both the cron and the
   drafts list), else it would never confirm by itself. A re-drafted
   session keeps its sets as they were; rejecting it still takes them
   (decision 146's dependents), as for any draft session.
154. **Ticket 69 review rulings (amend decisions 152 and 153).**
   - **An author's reject never takes what its member logged** (P0-1).
     For a session or a blood draw, the author may reject it only when
     every set, cardio block and lab result in it (what `dependents()`
     deletes with it) was logged by the same speaker and was never
     confirmed, and every set is still a draft. They go together. Otherwise
     the reject is a 403 `not_yours_to_decide` naming why ("Asha has
     logged sets in it, or some are confirmed"). The children are read in
     one statement (`childrenOf`), and `authorsOf` reads them with the
     drafts, so one more statement in all.
   - **The member's reject of a re-draft undoes the edit, never the
     record** (P1-1). When the member rejects a draft that was ever
     confirmed (by decision 153, only someone else's edit makes one), the
     version they last confirmed comes back as a new `amend` version:
     its amendable fields (and a food item's stored amount columns),
     `state = 'confirmed'` and its `confirmed_at`. A share and its item
     are restored together. A session's row is restored alone, and its
     sets keep their own state. The result lists these under `restored`
     (`table`, `id`, `version`, and what `amend` would have recomputed)
     and not under `rejected`. A never-confirmed draft is deleted as
     before. `lastConfirmedOf` costs one statement for every reject.
   - **The member's own edit never re-drafts, whatever the origin** (P2-1).
     That includes an Inbox write naming them as speaker. An Inbox edit
     naming no one, or another member, re-drafts.
   - **`day_meals` items say `ever_confirmed` and, on a re-draft,
     `edited_by`** (P2-3, P2-4). Both come from the versions
     `loggedByMany` already reads (`authorshipMany`), so no new statement.
   - **Parked** (P2-5): an edit of a household cook, component or cook
     line can change a member's confirmed portion without re-drafting it.
     It stays so, pending a ruling on the ticket.
   - **No import cycle** (P2-7). `LOGGED_BY`, `firstWriteSql`,
     `everConfirmedSql`, `authorsOf` and `lastConfirmedOf` live in
     `src/records.ts`, which `drafts.ts`, `autoconfirm.ts` and
     `tools/records.ts` import.
155. **Undoing many edits in one reject costs a constant number of
   statements** (ticket 69 re-review P1-R1; amends decision 154).
   `restoreConfirmed` puts back every record's last confirmed version
   set-based:
   - one `UPDATE … FROM json_each` per table, from one JSON of each row's
     values;
   - every version in one `versionsAcross`;
   - the catalogue loaded once;
   - every pot recomputed once, from one `loadCooks`. Its problems are
     asked as `amend` asks them, a share's item takes its pot's nutrients,
     and the result adds `pots`;
   - a plain item's nutrients from one `NutritionReader.prefetch`;
   - sets derived from one implements read and one exercises read.

   Measured: undoing 1, 15 or 100 items is 9 statements each; 98 items
   and 2 portions are 21. The test cap is 30.

   The delete side of a mixed batch is unchanged: it still costs about 3
   statements per deleted draft (its dependents read, version and DELETE),
   as before ticket 69.

156. **`LOCAL_DEV_IDENTITY` fails closed** (e2e spec §3; amends decision 58).
   - **What it takes:** exactly `member:<email>` or `service:<client id>`,
     the prefix in lower case, with no whitespace, comma or control
     character (`parseIdentity`, `auth.ts`), honoured only for requests to
     `localhost` or `127.0.0.1`.
   - **Anything else refuses every request**, `header`, `Header`, an empty
     value and a malformed one among them. A set variable never falls back
     to Access, so a mistyped value can't open anything. A well-formed
     member who is unknown or inactive is 403, as before.
   - **`serve(request, env, verify)`** is the default export's body,
     exported so a caller can serve a request with the verifier it gives;
     the default export passes the one `LOCAL_DEV_IDENTITY` or Access gives.

## An Inbox text is its sender's (9 Oct 2026)

157. **A member sees only the Inbox texts they sent** (amends decisions
   135 and the Inbox decision above; owner-approved). A Tell Claude text
   can carry health details, so like the free text of decisions 135 and
   137 it is not household data. The sender is `inbox_entry.created_by`
   (migration 0030): the member's id for an app call, the agent's
   `speaker` for an agent call, null for an agent call with none.
   `member_id` is the member the text is about, which may be someone
   else (a member can send a text about another member).
   - **`inbox_entries`:** a member caller gets only rows with
     `created_by` = them; `member` still narrows to the texts about that
     member, and a member may name only themselves: naming anyone else
     is 403 `not_visible`. Naming nobody now gives every text they sent
     (it gave the texts about them). The agent is unchanged: everyone's,
     `member` narrowing to the texts about them. Still one statement.
   - **`resolve_inbox_entry`:** the rule stays "the agent or the member
     it is about" (`not_yours` first, as before), but closing returns the
     text, so a member must also have sent it: otherwise 403
     `not_visible`, and nothing is written. An entry another member sent
     about you is closed by the agent.
   - **`history`** of an `inbox_entry` is `not_visible` to a member who
     didn't send it, even the member it is about.
   - Checked and without Inbox text: `household_overview`, `needs_you`,
     the day reads, the drafts list and `whoami` (none reads
     `inbox_entry`); `query` is the agent's (decision 136). A write's
     `reason` on records an Inbox resolution wrote is the agent's words
     and follows decision 137.
   - **A live gym-inbox run sees every member's texts, by design:** the
     agent is not a member, so `inbox_entries` gives it everyone's, and
     the person running the skill hears about them. The skill writes
     another sender's entry into the subject's records in its own neutral
     words (`label`, `reason`, `note`), never quoting the sender, since
     the subject reads those records.
   - Every refusal is `Ctx.assertSentInbox`, one message: naming another
     member in `inbox_entries` is refused as reading that member's texts.
   Test: `inbox-privacy.tools.test.ts`, including a resolved entry whose
   records and note never reach the subject's reads.

158. **A partial sum counts the items it leaves out** (ticket 72). A sum
   of nutrients adds what is known, so an item nobody can value (a food
   in a unit that is neither a measure nor its reference unit, a manual
   item with a blank) silently made a smaller, complete-looking total.
   Every total the app shows now carries `unknown_items`, per nutrient:
   how many of the summed items have that nutrient not wholly known
   (absent, or `known < of`), counted from the same coverage the sums
   carry (`unknownItems` in `nutrition.ts`).
   - `day_totals`, `what_if`'s `day` and every `dayViews` view: kcal,
     protein, carbs and fat. A day of only unknown items has an empty
     `so_far` and a `left` of the whole goal; its count is what says the
     left is "at most".
   - `day_meals`: each eaten slot's `totals` gains `{ kcal, protein }`.
   - `week_summary` days and `household_overview` members: `{ kcal,
     protein }` from their day view (no new statement).
   - `any` (every one of the above): the items with any macro not
     wholly known, each once, so the app's "N items unknown" counts a
     carbs-only unknown too and never double-counts.
   - Each `day_meals` item carries `partial: { kcal, protein }`: known
     for some of its parts but not all (a recipe with an unconvertible
     line), so its row reads "450+ kcal" and the meal's count can be
     found. An item known for none is `null` ("unknown"), not partial.
   - A sum known for none of its parts is `null`, never 0
     (`knownValue`; `day_meals` and `day_cooks` read values through it).
   Counted in items, not in coverage's parts: a recipe item's `of` is
   its lines, and the app words "1 item unknown". Additive; an older app
   ignores it. Test: `partial-totals.tools.test.ts`.

159. **Energy availability leaves out a day of unknown energy** (ticket
   74). `week_summary` averaged each logged day's known kcal, so a day
   with an item nobody can value counted that item as 0 and could raise
   a false low-EA flag. Of the ticket's two options (leave such days
   out, or keep them and word the result "at least" with a count), the
   smaller is to leave them out: the average stays a plain mean over
   complete days, the `low` flag needs no new wording or rule, and a
   partial day can never decide it.
   - A day is partial when `unknown_items.kcal > 0` (any item whose kcal
     is not wholly known, including a recipe with one unconvertible
     line), from the day view it already reads: no new statement.
     `any` is not used: an item missing only protein or carbs leaves kcal
     whole and doesn't bias the average.
   - `energy_availability.partial_days_excluded` counts them;
     `days_counted` is the complete days only.
   - A week whose every logged day is partial has no energy
     availability: `energy_availability_missing` is "every day logged
     this week has an item of unknown energy".
   Additive; an older app ignores the count. Test:
   `partial-totals.tools.test.ts`.

160. **Catalogue search scores by words** (ticket 75). `matchPrepared`
   (`fuzzy.ts`, behind `catalogue_search`, a clarification's options and
   `route_text`'s suggestions) scored the whole phrase first, so "oil"
   inside "boiled" tied with the oils, and a query with one word the name
   lacks ("wheat flour atta") scored 0. The tiers, best first:
   - 100 the name; 80 its prefix; **60 the query at a word start**
     (was any substring); 50 the query with spacing ignored, only when it
     isn't already inside a word; 40 every query word a word start, any
     order (`EVERY_WORD`, unchanged).
   - **22-39, all but one query word found:** at least one word a word
     start (three letters or more, or the whole word: "a" or "of" alone
     carries nothing), the rest near-spelt (counting half) or at most one
     missing; scored by the share found, `20 + 20 x (starts + near/2) /
     words`. "wheat flour atta" finds Whole-wheat atta (33); a multi-word
     typo with one word whole ("musterd oil") now scores here (35) where
     it was a near-spelling (20).
   - **21 the query only inside a word** (`INSIDE_A_WORD`): "oil" in
     "Potato, boiled". Above every near-spelling, so it is still offered,
     below every word-start match.
   - 1-20 near-spellings, as before (decisions 143, 150), except that a
     query word of one or two letters matching a word start now counts as
     found without the edit-distance check (it was checked by edit
     distance against whole words, and usually failed). So a mixed query
     that scored 0 can now score as a near-spelling: about 219 more name
     pairs on the household's names ("na napkro" for NAKPRO, 19), and
     about 10 near-spellings move by 1 (18 to 19).
   - The `catalogue_search` description states these bands, and that a
     partial hit (22-39) is never the food asked for: "not in the
     catalogue, closest names shown", never logged against ("paneer
     tikka" lists six paneers and no paneer tikka). The gym-nutrition
     skill says the same where it sends the agent to `catalogue_search`.
   Exact-name order is unchanged: the 100/80/60/50/40 tiers keep their
   numbers and their tie order, and every earlier search test passes
   untouched. Hits below 40 that tie now break by distance to the whole
   query (was near-spellings only), so the closer name of two partial
   matches comes first. A near-spelling of one word in a longer name
   ("miild" for "MillD High Protein Atta") already scored 20 and is
   pinned. "wheat flour" still finds "Amul High Protein Wheat Flour"
   first (it holds both words); knowing that atta is flour is an alias.
   CPU (Node, `process.cpuUsage` per call including the in-process
   SQLite, median / p95 over 40 warm calls): at the stress household's
   size (40 foods, 10 recipes) 0.6-0.7 / 0.9-1.4 ms before and 0.6-0.8 /
   1.1-1.7 ms after; at 300 foods and 200 recipes 3.5-4.3 / 4.0-5.8 ms
   before and 3.3-4.7 / 3.8-5.3 ms after. The word loop skips an edit
   distance whose lengths differ by more than the tolerance and stops at
   a second missing word. Test: `catalogue-search-words.tools.test.ts`.

161. **Several members locally: a dev-only entry with three locks** (e2e
   spec §3, Decided 3). The browser suite and the sample seed sign members
   in by the `X-Local-Identity` header against one Worker.
   - **Where:** `src/dev-entry.ts`, started as `wrangler dev --local
     src/dev-entry.ts`; never `main`, never imported, so the header code
     never ships. The deploy gate refuses a bundle naming the header, a
     config whose vars name `LOCAL_DEV_IDENTITY` or `LOCAL_IDENTITY_TOKEN`,
     and a secret of either name.
   - **Locks:** `LOCAL_DEV_IDENTITY` is exactly `header` (else the request
     goes to the shipped entry); the hostname is exactly `localhost` or
     `127.0.0.1`; `X-Local-Identity-Token` equals the run's 64-hex-character
     `LOCAL_IDENTITY_TOKEN`, compared in constant time.
   - **Answers:** a header other than exactly `member:<email>` (a
     duplicate joins with ", " and lands here) is 401; a well-formed email
     that is not an active member is 403. No default member.
   - **No CORS:** the Worker never sends `Access-Control-Allow-*`, so a
     page on another origin can't make a browser send the header.
   Test: `dev-entry.test.ts` (a trailing space or tab never reaches the
   Worker, since Fetch strips it from a header value; `parseIdentity`
   refuses it anyway); `shipped-graph.test.ts` (nothing `main` imports is
   the dev entry or names the header).

162. **The test household's fixed clock** (e2e spec §3, "The day", amended
   9 Oct 2026 by Hritvik). The phone baselines showed the seed's wall-clock
   times ("Logged by Kabir Fri 16:44"), which change on every run.
   - **Where:** `src/dev-entry.ts` only. In header mode, `LOCAL_FIXED_NOW`
     (an ISO instant) is the app's `now` for every request (through
     `createApp`'s `now`, the one clock seam, by `serve()`'s optional `now`:
     the dev entry calls the shipped `serve()` with it, and without it
     `serve()` runs on the wall clock as before) and the cron's
     auto-confirm runs at it, not at the trigger's time. A value that isn't
     an ISO instant answers 500 to every request rather than run on the
     wall clock. The shipped entry has no fixed clock.
   - **The instant:** Wednesday 7 October 2026, 10:00 Asia/Kolkata
     (`app/web/scripts/test-clock.ts`, the one definition): the dev worker
     helper passes it when asked: the suite's seed (`--fixed-clock`) and
     each slot's Worker. With `--fixed-clock` the seed refuses a Worker
     whose today isn't that day and uses no wall clock; a hand-seeded sample
     (`npm run seed:sample`, then `npm run dev -- --sample`) runs on today,
     as before. Every browser context the suite makes fixes its `Date`
     to it (`context.clock.setFixedTime`; timers still run).
   - **Not changed:** the migrations' `DEFAULT (strftime(..., 'now'))` on
     `member.created_at`, which the seed always sets itself.
   - **Size:** with every shot stable, the phone's 152 full-page baselines
     (36.8 MB, measured 10 Oct 2026) are kept as they are.
   - The deploy gate refuses `LOCAL_FIXED_NOW` in any shipped `vars`
     (`env.*` included) and as a secret, as it does the identity variables
     (`scripts/deploy-gate.ts`; web decision 120).
   Test: `dev-entry.test.ts` (today and a write's time at the instant, in
   the household's zone; a malformed value refused; the cron confirms a
   49-hour-old draft at the instant); `dev-worker.test.ts` (the argument, only when given); `entry.test.ts`
   (`serve()` with and without `now`); `e2e-config.test.ts` (the suite's
   seed passes `--fixed-clock`, `seed:sample` doesn't);
   `support.spec.ts` (the Worker's today and each member's page `Date`).

163. **An assistant asks; the member answers in the app** (redesign-a spec §5;
   migration 0031). `ask_member` (agent only) asks a member a question
   with 1 to 4 choices. About an Inbox entry it goes to the entry's sender
   (`created_by`), so `member` must be the sender, and an entry with no
   sender can't be asked about. Its `blocks` are drafts about that member
   only. `answer_question` is the recipient's (in the app, or through the
   agent speaking with them): a choice or their own words, once (a
   second answer, even a concurrent one, is 409 `not_open`, the
   `question_answers_once` trigger). The answer is stored and sent as a
   pending Inbox entry from the member about them, "Answer to assistant
   question 12: …", never quoting the question. Resolving or rejecting
   that entry closes the question. **Live:** an open question counts,
   shows and can be answered only while it has no blocks or one of its
   blocked records is still a draft, decided at read time (`liveSql`), so
   every path that settles a draft settles its question: confirm,
   reject, amend and its linked confirm, `end_session`, `retract`, and a
   rolled-back Worker's cron, with no hook (retract stays at 30
   statements). confirm, reject and amend also drop the questions they
   settle, set-based: one read, one UPDATE, one versions INSERT however
   many (decision 96); reject includes every dependent it removes and
   partner it restores. Duplicate blocks are 400 `duplicate_block`.
   The question row carries its `blocks`, written
   once, so its history shows an answered question's drafts. While a
   question is open or answered its drafts don't confirm by themselves
   (`autoConfirmBlock` returns `question`; `waits: "question"`).
   Share/item pairs hold together even if only one is named in the
   question. A block expires permanently at the first settling version
   after the question's creation write, so a later re-draft cannot
   revive it. The write-id boundary also works with equal timestamps
   and a rolled-back Worker's cron, without a new statement. A
   question is owner-only (`OWNER_ONLY.question`): its member's and the
   agent's. Test: `questions.tools.test.ts`; the 20-question confirm in
   `query-budget.test.ts`.

164. **Waiting is the durable cross-surface work queue, not every possible
   next action** (ChatGPT reconciliation, 16 Oct 2026). `waiting` combines
   open member questions, cross-member hand-offs and drafts, settlement
   rows, website text sent for review, and due lines. It owns the website's
   global waiting badge. Training prescriptions and equipment gaps stay in
   `next_prescription` and `inventory_gaps`; duplicating them here would make
   long-lived equipment gaps inflate the badge and would push the household
   read beyond its 30-statement budget. The result is member-private where
   its component reads are private, and remote OAuth members may call
   `waiting`, `answer_question`, and `inventory_gaps`; `ask_member` remains
   a privileged agent tool. Test: `waiting.tools.test.ts`,
   `query-budget.test.ts`, `remote-mcp.test.ts`, and the browser privacy
   table.

165. **Lift charts are a member-authorized Worker read, not a client-side
   reconstruction** (ChatGPT reconciliation, 16 Oct 2026). `lift_trends`
   lists a household member's lifts and Sunday-week volume, or returns one
   exercise's complete stable session series. RIR-adjusted e1RM, comparable
   method segments, top-set fallback, missing-estimate reasons, stored goals,
   drafts and inferred-rep provenance are computed by the Worker. A detail
   response includes warm-ups only for sessions that contain a plotted
   working set; warm-up-only sessions do not become orphan chart sessions.
   Bodyweight-multiple goals remain multiples and never disclose or infer a
   private bodyweight. The read is available to remote members, interactive
   agents and unattended readers. Its statement count is fixed with history
   length (four for the list and eight for detail in the scale test). Test:
   `lift-trends.tools.test.ts`, `lift-foundation.test.ts`, and
   `tool-capabilities.test.ts`.

166. **Nutrition charts are bounded Sunday-week Worker projections**
   (ChatGPT reconciliation, 16 Oct 2026). `nutrition_trends` returns at most
   four weeks of truthful day and week folds at once, plus replayable older
   four-week ranges. It clamps history to 26 pages (104 weeks), the member's
   first intake item or legacy manual day total, and the household-local
   current Saturday. Inputs are normalized before loading days, including a
   far-future `to`, so a request cannot amplify work. Unknown nutrients and
   partial pricing remain explicit; zero is a known value. It deliberately
   excludes readings, body composition and energy availability and is a
   household-visible read for remote members, interactive agents and
   unattended readers. At six cooks per day, newest and oldest pages use the
   same 20 statements and the measured 28-day JavaScript median was 8.20 ms.
   Test: `nutrition-trends.tools.test.ts`, `nutrition-fold.test.ts`, and
   `tool-capabilities.test.ts`.

## Training's free text is household-readable, and every owner reads their own notes (22 Oct 2026)

167. **The free text on training records is household data, and every
   owner reads their own.** This supersedes decision 137's free-text
   clause: `session.note`, `session_set.note`, `cardio_block.note` and
   `load_change.reason` are no longer nulled for another member. Another
   member still reads the sessions, dates, templates, sets, loads, reps
   and cardio numbers, and now also these notes and reasons. `OWNER_TEXT`
   (owner-only.ts) keeps only `schedule_swap.reason`, whose read
   (`programme`) already returns it whole. Consequence: `sessions`
   returns each session's `note` and each set's and block's `note` to
   every caller; `describeSet` adds `note`; `programme` returns each
   prescription's `load_change.reason` in its load history. The consumer
   of decision 137's `withoutOwnerText` (tools/records.ts) drops the four
   fields from its nulling because `OWNER_TEXT` no longer lists them.

168. **The notes an owner-only read selects are returned to their owner**
   (ticket 76). `reading.note` (via `body_trends` and `reading_metrics`'
   recent readings), `blood_draw.note` (via `blood_draws`), `goal_point.note`
   (via `body_trends`' goal points) and `hr_zone.basis` (via a new read) are
   returned: those reads are already owner-only (their `ownMember` gate
   refuses another member), so returning the note to the caller returns it
   to its owner alone. A new owner-only read, `heart_rate_zones`, lists a
   member's heart-rate zones with their `basis`, the means by which no tool
   read the table before. `legacy_audit_entry.reason` stays write-only by
   design: `add_legacy_audit_entry` records the imported Sheets history, and
   no read exposes it (a deliberate record, not a gap).
   Test: `owner-note-reads.tools.test.ts`, the browser privacy table.
