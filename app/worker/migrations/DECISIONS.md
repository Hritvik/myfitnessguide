# Schema decisions

Choices made while turning the schema tickets into D1 migrations, where the spec was silent, ambiguous or in tension. Each follows `CONTEXT.md` as closely as possible. Hritvik can veto any line.

## Cross-cutting

1. **Keys.** Every table has an `INTEGER` primary key. The Sheets refs (`FS001`, `R049`) are kept as `UNIQUE` `ref` columns on `food_source` and `recipe`, so humans and the importer keep a stable key, and lines still join by id.
2. **Dates and times.** Dates are ISO `YYYY-MM-DD`, checked with `date(x) IS x` (this rejects `2026-02-30`). Timestamps are UTC `YYYY-MM-DDTHH:MM:SSZ`, with no fractional seconds.
3. **Draft and confirmed.** `state` (`draft`/`confirmed`) plus `confirmed_at` sit on the records an entry produces: `session`, `session_set`, `cook`, `household_meal`, `portion`, `intake_item`, `reading` and `blood_draw`. Catalogue, programme, flag, target, goal and note writes are confirmed on write. A rejected draft is deleted, and its last content survives as a `record_version` with action `reject`. There is no `rejected` state.
4. **Pending is not modelled.** Inbox entries (the pending state) are left to *Inbox v1*, which the map lists as not yet specified.
5. **Write log.** There is one `write_log` row per API call. Every record the call touches gets a `record_version` row that points back to it. `resolver` is one of `claude_code`, `hosted_model`, `member`, `importer` or `system` (the 48 h auto-confirm). `origin` is one of `live`, `coach`, `inbox`, `app`, `import` or `auto_confirm`. `actor_member_id` is set only when a member wrote the record themselves.
6. **Idempotency.** A separate `idempotency_key` table stores the key, the tool, a request hash and the JSON response, so a retry can return the original response. Each key belongs to exactly one write.
7. **Legacy Agent Audit.** The 124 old audit rows go to `legacy_audit_entry`, not `write_log`. Their time is often missing (kept as not recorded) and their fields are free text.
8. **Member notes.** Each `member_note` holds an identity and a subject, and its prose sits in `member_note_version`. A note with `member_id` NULL is a household document, such as Meal Prep (*Body, bloods and prose schema* calls these "versioned documents").
9. **Cross-row rules stay in the API.** SQL does not enforce these: non-overlapping phases, portion fractions summing to at most 1, an amount unit that matches the food source's reference unit, snapping loads to the inventory, the record-only RIR exemption, and owner-only visibility. The one trigger in the schema checks that a reading's unit fits its metric.
10. **STRICT coercion.** STRICT tables still coerce lossless numeric text, so the Sheets text-numbers (`"35"`, `"1488"`) import as numbers. Text such as `"35 kg"` is rejected.

## Training

11. **The set table is `session_set`,** because `SET` is an SQL keyword. The domain term stays *Set*.
12. **Load status.** `session_set.load_status` is `entered`, `none` (no external load, such as bodyweight) or `not_recorded`. This keeps "no load", "never captured" and an entered 0 distinct, as *Not recorded* requires.
13. **Blank versus not-recorded RIR.** A NULL `rir_status` means blank, which only a draft may have. `not_recorded` means the value was never captured, and `recorded` means the range is present. The database rejects a confirmed set with blank RIR. Whether a set may be confirmed live as `not_recorded` depends on the member's programming mode, so the API checks that.
14. **Set types.** The types are `warm_up`, `working`, `back_off`, `substitution` and **`calibration`**. Calibration isn't in the spec, but `gymcalc.SET_TYPES` and the Log data use it, so imported rows need it.
15. **Bar weight.** A plate-loaded set stores the bar as `bar_value` + `bar_unit`, in its own unit (20 kg bar plus 12.5 lb per side), and only on a `per_side` load.
16. **Assisted loads are negative,** both in `implement_load` and on sets.
17. **Load basis versus implement loading.** A set's basis is `total`, `per_side`, `per_hand` or `per_leg`. An implement's `loading` is `total`, `per_side` or `plates_only` (rule 20). `load_list_complete = 0` marks a fixed bar whose maximum is unknown (rule 21).
18. **Total load in SQL.** `v_set` computes the total only for `total` (value) and `per_side` (2 × value + bar). **`per_hand` and `per_leg` are left NULL**, because the spec doesn't say whether to double them; the domain package decides. `v_session.sets_load_uncomputed` counts these sets. **Superseded by 0012:** a set now carries `unilateral` (allowed only on `per_hand`/`per_leg`), and `v_set` doubles a per-hand or per-leg value unless the set is unilateral, which is the domain package's `totalLoad` rule.
19. **lb to kg** uses the exact 0.45359237. (`gymcalc` uses 1/2.20462, which differs by about 3e-7 relative, well inside parity tolerance.)
20. **Volume and e1RM.** Both need a positive total (assisted and bodyweight sets stay empty, as in `gymcalc`). e1RM also needs `rir_high = 0` and 1–12 reps. Session volume excludes warm-ups.
21. **Progression rules** are a JSON object with `kind` set to `rep_top` or `manual`. `rep_top` must carry `target_sets`, `rep_top` and `rir_floor` (gymcalc R3), and an optional `autoregulation` object holds the autoregulation branch. The domain package owns the full shape.
22. **Current load is not stored.** A prescription holds its starting load, and each `load_change` stores only the new load. `v_prescription` derives the current load.
23. **Schedules.** `schedule_slot` maps an ISO weekday (1 = Monday) or a rotation position to a template. `schedule_swap` holds one-off swaps, where a NULL template means no session that day. A partial unique index allows at most one active programme per member.
24. **Week and phase.** `member.week_anchor_date` anchors the week, and `v_session` derives the week number and the phase covering the date.
25. **Session gym.** A gym is required only for strength sessions, since cardio can be outdoors and dance isn't at a gym. `session.energy_kcal` holds a class's energy cost (rule 27).
26. **Home gym.** `member.home_gym_id` is the gym that imported sessions are assigned to.
27. **Aliases** are unique across the whole catalogue, ignoring case, so an alias resolves to exactly one exercise. Tags are lower snake_case.
28. **Cardio enums.** Block kinds are `warm_up`, `steady`, `interval`, `recovery` and `cool_down`. Speed is in `km/h` or `mph`, and distance in `m`, `km` or `mi`. Steps are a separate integer.

## Nutrition

29. **Food source states** are `as_sold`, `raw`, `dry`, `cooked`, `soaked`, `drained`, `shelled` and `in_shell`. Reference units are `g`, `ml` and `piece`. Amounts are in `g`, `ml`, `piece` or `measure` (with a `measure_id`).
30. **Intake by recipe.** Besides a food source, a portion and manual macros, an intake item may be a **recipe by servings**. Many of the 252 legacy Nutrition rows with a ref point at `R…` recipes. Importing them as portions would mean inventing cooks that never happened, and a cook is "one real preparation". This is a deliberate extension of the three sources in `CONTEXT.md`.
31. **Provenance on portion items** lives on the portion, so an intake item that comes from a portion has NULL `provenance`. Every other item requires it.
32. **Cooked weight is per component,** with its provenance. A single-component cook carries the whole cooked weight. The API gives every cook at least one component, so a portion always points to one.
33. **Remainder dispositions** are `leftover` or `discarded`, for `rest`, a fraction, or a weighed amount. Marking a remainder "eaten by someone" creates a new portion, not a disposition.
34. **One portion per member per component.** A second helping is an amendment.
35. **Household meals and cooks** are many-to-many, through `household_meal_cook`, so leftovers can belong to a later meal.
36. **Meal slots** are `breakfast`, `lunch`, `dinner`, `snack`, `pre_workout` and `post_workout`. The importer maps free-text meals to these, and anything it can't map goes to a ruling.
37. **The legacy `DAY TOTAL`** becomes a manual total on `day_status`, and `v_day_intake` uses it only on a day with no items. Skipped meals have their own `skipped_meal` table.
38. **Recipes.** Names are unique per household (the dedupe in rule 32). Manual macros are per serving, all four are required with a reason, and `recipe.servings` says how many servings the lines make.

## Body and health

39. **Readings** use `body_state` (`fasted`, `fed`, `post_exercise` or `not_recorded`) for the conditions state, because `state` is the draft/confirmed column on every record. `measurer` is `self`, `member` (with `measurer_member_id`), `professional` or `not_recorded`.
40. **Metrics and units** are seeded reference tables. A trigger rejects a unit whose dimension doesn't fit the metric's. Height is a reading, so waist:height uses the stored height. The BIA metric list (skeletal muscle mass, fat mass, fat %, fat-free mass, visceral fat) is a best guess at Body columns AC–AI and can be extended with an `INSERT`.
41. **Flag subtypes** are `health_watch`, `restriction`, `event` and `data` (for "report never received"). The energy-availability flag is a `health_watch` flag. Flags are confirmed on write.
42. **Targets.** A `target` holds the date, provenance (`agent`, `member`, `professional` or `import`) and reasoning. Each `target_value` is a nutrient with a kind: `target`, `floor`, `ceiling`, `remainder` (no stored value) or `reference_intake` (the RDA block).
43. **Goal points** cover either a metric or an exercise's e1RM. Each has a tier (`planned` or `stretch`) and a basis (`absolute` or `bodyweight_multiple`, which has no unit), uses `value_low`–`value_high` for ranges, and can carry a `headline` flag. Every goal point needs a `week_of` date, so the undated goal lifts need an import ruling.
44. **Lab results** may be qualitative (`value_text`) or carry a comparator (`<0.5`). Their status is computed only for plain numeric values.

## Views for `query`

45. **Views include drafts,** with a `state` column, so the caller filters.
46. **The views compute macros only.** Micronutrients, coverage, protein bands, cost and target "left" belong to the domain `day_totals`. A total with any uncomputable line is NULL, not an undercount.
47. **The 7-day weight average** uses fasted readings from day−6 to day, within the day's method segment. It doesn't drop suspect readings, because the spec gives no rule for that.

## Tooling

48. **`wrangler.jsonc`** has a placeholder `database_id` (all zeros) until the D1 database is created, so a deploy or `--remote` command fails rather than touching anything. The migrations were checked with `wrangler d1 migrations apply --local` against a scratch persist directory.

## Ticket 27 (backend gaps)

49. **`session_set.reps_inferred`** (0013) is 0 or 1, default 0, so every
    existing and imported set counts as reported. It may be 1 only when
    `reps` is present: an inferred count is still a count.
50. **`measurement_cadence`** (0014) holds one cadence per member and name
    (lower snake_case). `source` is `reading` (with `metric`, and
    `body_state` when only one state counts), `cardio_hr`, `exercise`
    (with `exercise_id`) or `manual` (with an optional `last_done_on`);
    CHECKs keep each source's columns to that source. `every_days` is 1 to
    366.
51. **`exercise.bodyweight_dominant`** (0015), default 0. `v_set` is
    recreated so `e1rm_kg` is NULL for a flagged exercise (volume
    unchanged), the domain's rule; it also exposes `bodyweight_dominant`
    and the set's `reps_inferred`.
52. **`food_source.energy_override_reason`** (0016): NULL, or the reason
    a label whose macros don't reconcile with its energy was saved
    anyway.

## Ticket 25 (rehearse the import until parity passes)

53. **Superseded by 58.** **The per-implement e1RM convention** (0017). `v_set` gains
    `implements_sharing` (1 for a `total` load or a unilateral set, else
    2) and computes `e1rm_kg` on `total_load_kg / implements_sharing`.
    Volume and the total are unchanged and still count every limb. A
    per-side load with a bar shares the bar between the sides.
54. **Non-rep prescription targets** (0018). `prescription.target_kind`
    is `reps` (the rep range, as before), `duration` (`duration_low_s` /
    `duration_high_s`, both NULL for "max time") or `distance`
    (`distance_value` + `distance_unit`). Only a reps target has a rep
    range; `sets` and the RIR target are now optional on every kind (both
    RIR ends or neither). The table is rebuilt (SQLite can't drop NOT NULL),
    with `PRAGMA defer_foreign_keys` for D1; it runs before any data is
    loaded. `v_prescription` gains the target columns.
55. **The progression rule CHECK** (0018) also accepts `rir_floor:
    "from_prescription"` and `increment: "smallest_step"`, and a
    `rep_top` rule only on a reps target. The full shape (increment unit
    and basis, `cue`, `per_leg`) is the API's zod `RULE`.
56. **`session_set.position`** (0019): the set's 1-based place in its
    session's running order, unique per session. `set_number` only counts
    one exercise's sets. Existing rows are numbered in id order; the column
    is nullable only because SQLite can't add a NOT NULL column without a
    default, and the API always sets it. `v_set` exposes it.
57. **BIA body water and BMR** (0020), as Hritvik's rulings named them:
    `bia_body_water_kg` (mass) and `bia_bmr_kcal` (energy). Energy is a
    new dimension with the unit `kcal`; the `unit` and `metric` tables are
    rebuilt for it (their dimension CHECK can't change in place), with the
    reading triggers, `v_reading` (energy's canonical unit is kcal) and
    `v_weight_7d` dropped and recreated around the rebuild. Seeded rows,
    so the final-load SQL leaves them out.

## Ticket 25, second build (batch 4 rulings)

58. **The split e1RM convention** (0021). `v_set` recreated:
    `implements_sharing` is 2 for a per-hand or per-leg set that isn't
    unilateral and for a per-side set whose kind is `cable`, else 1. The
    kind is the set's implement's, or the exercise's `implement_kind` when
    the set names none (every imported set), so the view joins the
    exercise and left-joins the implement, and exposes `implement_kind`.
59. **Mixed-unit inventories** (0022).
    - `implement_load` is rebuilt with `unit` (each load's native unit)
      and `status` (`available` or `absent`: a load known not to exist),
      unique per implement, load and unit. Existing rows take their
      implement's unit. Nothing references the table, so the rebuild needs
      no foreign-key deferral; `v_implement` is dropped and recreated
      around it, listing loads with their units, lightest first, and the
      absent ones.
    - `implement.bar_value` / `bar_unit`: a bar's or sled's own weight,
      NULL when unknown (both or neither).
    - `plate_set` (one per gym and unit, `complete` 0/1) and `plate` (a
      denomination, `confirmed`, `inferred` or `absent`; assumed to come
      in enough pairs, so no count). `v_plate` lists them for `query`.
      A barbell or plate-loaded implement loaded per side or plates only
      takes its loads from these, derived by the API, not stored.
60. **A set's load as a composition** (0023). `session_set.plates` is a
    JSON array of `{ value, unit, count }` per side, allowed only on a
    `per_side` load (CHECK: valid JSON, a non-empty array). The bar stays
    in `bar_value` / `bar_unit`. `load_value` / `load_unit` hold the
    plates' exact sum as well (the plates' unit when they share one, else
    kg), so the CHECKs that tie `load_value` to `load_status` still hold
    and a reader that doesn't know compositions still sees the load.
    `v_set` computes a per-side total from the plates (`json_each`) when
    there are any, and exposes `plates`. A JSON column, not a child table,
    because a composition is one field of one set, so `amend` changes it
    like any other field.
61. **`retract` as a version action** (0024). `record_version.action`
    allows `retract`: the last content of a confirmed (or draft) record
    removed because it should not exist. SQLite can't change a CHECK in
    place, so `record_version` is rebuilt with every row copied (ids,
    versions and data unchanged). Nothing references it, so no
    foreign-key deferral is needed.

## App input (spec 2026-10-06)

62. **One alias store** (0030). `alias` holds the household's other names for
    food sources, recipes, exercises and workouts: one row per word, unique
    ignoring case across every kind (`UNIQUE (household_id, alias)` on a
    NOCASE column), so a word has one meaning. `target_id` is the record of
    that kind; it has no foreign key because it points at one of four
    tables (none of which the API deletes). `created_by` is the member who
    taught it (in the app, or the member the agent was talking with); NULL
    for aliases copied from `exercise_alias` or imported. The migration
    copies every `exercise_alias` row with its id and recreates `v_exercise`
    over `alias` (same columns); every reader switched in the same change.
    **`exercise_alias` is kept, unread by the new Worker**, because D1
    applies a migration before the deploy and a rollback runs the previous
    Worker on the migrated database: in both windows the old Worker reads
    its aliases there. A follow-up migration drops it once the new Worker
    has settled, first copying any alias the old Worker wrote meanwhile.
63. **Workouts** (0030). `workout` is household-level, named once per
    household ignoring case. `workout_line` has an integer id and a unique
    position per workout, one target (reps low/high, a duration or a
    distance), an optional default load (`load_kind`: a value with unit
    and basis; plates per side on a bar, stored as `session_set` stores a
    composition; or none), an optional RIR range and rest. A substitution
    is not a line set type: it needs a prescription.
64. **`session.workout_id`** (0030): nullable, with `CHECK (workout_id IS
    NULL OR template_id IS NULL)` on the added column; existing sessions
    read NULL.
65. **`inbox_entry`, `feedback`, `route_stat`** (0030). An Inbox entry is
    pending until resolved or rejected, which needs a note and stamps
    `resolved_at`; its spans are a non-empty JSON array of `{text, start,
    end}`. Feedback's context is a JSON object, and anything past `new`
    carries a triage note. A router stat counts at least one piece and
    points at its write; it is written only for app writes and never
    versioned.

## Set corrections and structures (0037, 27 Oct 2026)

66. **A compound set is one row** (0037). `session_set.structure` names the
    shape (`simple`, `drop_set`, `rest_pause`, `superset`, `cluster`) and
    `segments` holds the physical efforts as JSON
    (`[{sequence, load, reps, duration_s?, distance?, rir?, note?}]`), at
    least two. The row's own `load_value`/`reps` stay the **opening**
    segment, so every constraint, reader and view that knows nothing of
    segments still sees a true set (the one it starts with). A simple set
    stores no segments and computes exactly as before. `rir_scope` says
    whether the RIR belongs to the whole set or to a segment; a segment's
    own RIR lives in its JSON.
67. **A carry may be per side** (0037). `sides` is a JSON array of
    `{side: left|right, distance_m?, reps?, duration_s?}` and
    `distance_basis` says whether `distance_value` is the whole carry
    (`total`) or the distance each side covered (`per_side`, the default
    when sides are given). `carry_type` names how it was held. The row's
    distance is still a real distance, so old readers keep working.
68. **`v_set` sums a compound set's volume** (0037). The view appends
    `structure`, `segments`, `rir_scope`, `carry_type`, `sides`,
    `distance_basis`, `version`, `draft_reason` and `total_reps`, and its
    `volume_kg` is the sum of every segment's load × reps (by each
    segment's own basis) when segments exist. A simple set's volume and
    e1RM are unchanged; a compound set's strict e1RM is still the opening
    segment's, which is the honest estimate from a set whose later
    segments were lighter.
69. **`version` is the correction precondition** (0037).
    `session_set.version` starts at 1; `update_set` names the version it
    read and a different one is refused with `set_version_conflict` (409)
    rather than overwriting another writer's change. The correction is one
    `UPDATE` plus one `record_version` (action `amend`), so the previous
    content and the reason stay in the record's history.
70. **`draft_reason` makes a stale draft findable** (0037). A draft is
    `off_list` (the load is not in the gym's inventory), `rir_needed`,
    `awaiting_member` (a coach-mode or review draft) or `review` (a bulk
    report). `add_implement_load`, `revalidate_set` and
    `revalidate_session` re-check only the `off_list` drafts, so a
    deliberate draft is never confirmed by accident; `end_session` clears
    the reason when it confirms a set.
71. **Implement words join the one alias store** (0037). SQLite cannot
    widen the `kind` CHECK in place, so `alias` is rebuilt with the same
    ids and rows, allowing `implement` as a fifth kind; `v_exercise` is
    dropped and recreated around the rebuild. One word still means one
    thing across foods, recipes, exercises, workouts and implements, and
    `learn_alias` / `forget_alias` version every change. `chooseImplement`
    reads the word only when it does not match an implement's own name, so
    the common path adds no statement; a word naming an implement at
    another gym asks (`implement_elsewhere`) rather than silently using it.
72. **Corrections do not reorder a session** (0037). `update_set` keeps the
    set's position; `set_number` and `exercise` may change, and a number
    another set of that exercise already has is refused
    (`set_number_taken`, 409) before the write. A corrected confirmed set
    stays confirmed unless the correction makes it invalid (a blank RIR or
    an off-list load), in which case it becomes a draft with its reason.
73. **Equipment is retired, not deleted** (0038). `implement.archived_at` /
    `archived_reason` keep a sold or out-of-service machine out of
    `inventory` and `inventory_gaps`, while its sets, loads and
    prescriptions still read it by id. `set_implement_archived` restores it.
    A piece in use cannot change how its loads are read (kind, loading)
    without changing the meaning of past sets, so `update_implement` refuses
    that until it is unused; renaming and notes are always safe.

74. **Prep is a child of the recipe, and the plan's schedule is a table**
    (0039). `recipe_prep_step` is an ordered child of `recipe`, so a step
    moves and versions with the recipe it belongs to; the action is the
    operation and food/amount are columns, which lets two same-night soaks
    merge into one task. `prep_task` holds the schedule a saved plan
    derives, one row per task keyed by `task_key`; its content columns are
    immutable (a plan revision inserts a successor's rows and carries the
    old state), and only `status`/`settled_*` may change. Nothing existing
    is rewritten: a recipe with no steps and a plan with no prep read
    exactly as before. `prep_task.window_start`/`window_end` are the one
    deliberate exception to rule 2: they store household-local wall clock
    (`YYYY-MM-DDTHH:MM`), the form the member reads, never UTC; a CHECK
    holds the format and `window_start <= window_end`, and `due_on` stays
    the calendar date for ordering.
