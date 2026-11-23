# Importer decisions

Choices made building ticket *Snapshot and importer* where *Import design*,
*Parity gate for deleting formulas* or the schema tickets were silent or
ambiguous. Hritvik can veto any line.

## Snapshot

1. **Two grids per tab.** `formulas` is the `formulas: true` read (formula
   text, else the unformatted raw value); `values` is the plain read (the
   rendered, formatted strings). A cell's typed input is the formulas grid
   unless the cell holds a formula; then its rendered value is used. The
   repo's note that FORMULA mode is ignored is out of date (the research
   inventory says so too): it returned formulas for every tab.
2. **Capture by saved responses.** The MCP tool's large responses are saved
   to files and assembled by `gym-import assemble`; nothing is transcribed
   by hand. Ranges are explicit per tab (whole-tab ranges failed with "retry
   with a narrower request"), wide enough to cover each tab's data.
3. **File name** is the ISO 8601 *basic* timestamp (`20261005T190721Z.json`),
   which is file-name safe. Outputs go in a sibling directory of that name.
4. **Row counts** in the validator count rows with any non-blank cell, so
   rows that hold only per-row formulas are counted too (Nutrition's
   formula rows below the data). The loader itself skips formula-only rows.

## Loading through the Worker

5. **In process, not over HTTP.** `importWrite` runs the tools' own zod
   schema and handlers on a `node:sqlite` database through the Worker's
   `Db` interface, with `resolver = importer`, `origin = import`,
   `actor = NULL`, and the write time fixed to the snapshot's capture time
   (so a rehearsal is deterministic). No idempotency rows are written for
   imports.
6. **Imported records are confirmed.** `Ctx.stateFor` returns `confirmed`
   for origin `import`: they are the accepted Sheets history. Only the
   importer may confirm a prescribed member's set with RIR `not_recorded`
   (*Training schema*: imported sets without RIR are not recorded).
7. **Import-only tools** (`create_household`, `create_member`, `create_gym`,
   `create_exercise`, `create_programme`, `create_goal_point`,
   `add_legacy_audit_entry`, `create_implement`) live in `app/worker/src/tools/import.ts`, are
   ordinary zod-validated, write-logged tools, and are not in `TOOLS`, so
   `GET /tools` never lists them and `POST /tools/<name>` is 404.
8. **One write per sheet row**, so each record's origin is one row. A Log
   session is started by the first row of its group; a Cardio session by
   the first block's row; a blood draw by the Bloods header row.
9. **A refusal is a ruling.** Anything the API refuses (schema,
   clarification, rule, constraint) becomes a semantic `rejected_by_api`
   ruling with no proposal, so the row stays out until decided.

## Rulings

10. **Ids** are `<file>/<tab>!<row>/<code>[/<key>]`; decisions in
    `rulings.yaml` are re-applied by id. Decided rulings a later run no
    longer raises are carried over, so no decision is lost.
11. **Mechanical** = the four kinds *Import design* lists (numbers and
    dates stored as text, RIR as date serials, legacy DAY TOTAL rows,
    superseded Guide facts), plus rep ranges stored as date serials in
    Program (the same Sheets bug), plus parity differences whose cause the
    gate ticket names outright (a listed sheet bug, a missing formula, a
    load rounded for display, a stored recipe's manual macros).
    Everything else is semantic.
12. **Pending semantic rulings apply their proposal provisionally** so a
    rehearsal shows the fullest picture; a pending ruling with no proposal
    keeps its row out. The gate cannot pass while any is pending.
13. Text-number repairs are one ruling per row listing the columns; each
    decoded date serial is one ruling per cell.

## Catalogue

14. **Reference amount from the serving text**: a leading weight or volume
    ("100 g dry", "250 mL"); else a weight in parentheses ("1 scoop (33
    g)", also kept as the measure `scoop`; "~" approximations count); else
    one `piece`. Nutrients per serving are unchanged, so quantity in
    servings × reference amount is exact. The serving text is kept in
    `assumptions`.
15. **State** comes from the name or serving: `dry` ("dry", not "dry
    roasted"), `cooked` ("cooked", "boiled"), `raw`, `shelled` (an egg whose
    serving is an egg); else `as_sold`. A staple whose weight changes with
    cooking (rice, oats, atta, flour, dal, chana, millet, soya, makhana...)
    that states nothing gets a semantic `unclear_food_state` ruling.
16. **Price** min/max per serving = per reference amount; a source with only
    one of the two uses it for both.
17. **Recipes**: `derived` rows load their Recipe Ingredients lines by
    Recipe ID (never by dish name); `stored` rows keep E–H as manual
    per-serving macros and also keep any partial lines; `meal plan` rows
    become kind `idea`. Servings is 1 (Sheets macros are per serving).
    Ingredient prose (I) and assumptions (K) go to `source_assumptions`.

## Nutrition

18. **One intake item per row**, the member from the file (column L is not
    used). A ref'd row is `food` (qty × reference amount) or `recipe` (qty
    servings); a ref-less row is `manual` with its typed macros.
19. **Meal slots**: Breakfast, Lunch, Dinner, Snack, Pre-/Post-workout map
    directly; "Pre-workout snack" → pre_workout; "Evening" and "Dessert" →
    snack. A time serial proposes the slot for its hour (<11 breakfast, <16
    lunch, <19 snack, else dinner); "Meal" proposes lunch; both semantic.
20. **Provenance** `label` when Source says label / published /
    provider-declared, else `estimated`. Confidence Low/Medium/High; a
    missing one is `medium` with a note. Source text goes to the note; the
    label is "Item (Qty text)".
21. **DAY TOTAL** rows become the day's manual total and the day is marked
    `complete`; a day with items too also gets the semantic
    `day_total_with_items` (proposal: keep the items; the manual total is
    stored but unused while items exist). **NONE** rows become skipped
    meals; days get no status otherwise (open).

## Training

22. **Exercises**: one per distinct name, ignoring case; implement kind from
    a keyword table (unknown → semantic, proposal `other`). Names equal
    apart from a parenthesised qualifier get a semantic `exercise_mapping`
    ruling (proposal: keep separate; override `{alias_of: ...}` merges).
    Program names lose their superset tag ("[SS-A]"), which goes to the cue.
23. **Load from the typed total**: "per side" loads get a bar of
    (typed total − 2 × value), i.e. 0 for sled and cable rows, matching the
    sheet's "log plate load only"; "per hand" is unilateral when the typed
    total equals the value; "per leg" never is (43). "assistance" is a negative total;
    "Machine", "added" and blank are total; "bodyweight" is no load.
24. **RIR**: blank → not recorded; numbers and ranges as typed ("4+" is
    4–4, the domain's `parseRir`); date serials decoded (mechanical);
    unreadable text → semantic, proposal not recorded with the text in the
    note. Set types: blank/working/accessory → working, warm-up → warm_up,
    calibration; "substitute(ion)" → semantic (Sheets never says which
    prescription it replaced), proposal working. "20 per leg" reps are 20.
25. **Sessions**: Log rows grouped by date and Session; strength at the
    member's home gym; linked to the programme's template of that name.
    Week and Phase are not imported (derived); Muscle Group, Source and the
    typed Total/Volume/e1RM go to the write log's audit detail.
26. **Programme**: one active programme per prescribed member with a
    Program tab, templates in order of first appearance as a provisional
    rotation (semantic `programme_schedule`: Handover's weekday plan is
    prose; an override of `{template: weekday}` makes it a weekday plan).
    Rows without sets / rep range / RIR (cardio, holds, carries, activation)
    become notes on the programme (semantic). Progression rules are prose:
    "when NxM" proposes `rep_top` (N sets, M reps, RIR floor = the RIR
    target's low end), else `manual` (semantic). Last Moved, the prose rule
    and Current Wt go to a note on the prescription; no load_change events
    are invented. Phases are imported since ticket 25 (53).
27. **Cardio**: rows grouped by date and Type into one session; Dance/Class
    → session type `class`; block kind interval / warm_up / cool_down /
    steady from the type and block label. Typed pace is not imported (the
    app derives it); its text is kept in the block note. A non-integer HR
    proposes rounding (semantic).

## Body, bloods, goals

28. **Body columns by header**, since the files differ after column X. Only
    the AM-fasted weight is `fasted`; everything else is `not_recorded`,
    with Conditions kept on each reading and Note on the row's first.
    Measurer is not recorded. Height comes from People, dated to the
    member's first Body row (People holds no date). Not imported: Protein
    (duplicates Nutrition), Photos ("NOT YET"), and the derived 7-day
    average, ratios, skinfold sum and formula fat-free mass. BIA body water
    and BMR have no metric (semantic; a migration would add them).
29. **Bloods**: the table is the rows with a marker and a reference range
    after the Marker header; one draw per date column. Values "not
    retested/done" are absent; "not received" proposes a data flag. The lab
    and the missing units are semantic (proposals: the first sentence of the
    title cell; "not recorded"). Combined rows ("Creatinine / GFR") split.
    A value far below a range starting above 1 is a percentage stored as a
    fraction (semantic, ×100). Typed Change and Status are not imported
    (computed). Everything else on the tab is one owner-only note.
30. **Goals**: Trajectory target waist and weight are planned, absolute goal
    points per week; the typed actuals are not imported (they are
    readings). The undated goal lifts (Chart Data AD/AG) propose the Guide's
    target date (semantic).

## Prose and history

31. **The base Guide is Hritvik's** (the decomposition found it so); each
    section is a member note `guide: <section>`. NUTRITION TARGETS,
    TRAINING and MEDICAL - PROGRAM ON HOLD are superseded: they are version 1
    of `targets`, `training plan` and `programme status`, and People's
    Target basis / Handover's schedule and status are version 2. Hritvik's
    Guide tab is skipped when identical to base (semantic ruling if not).
32. **Handover**: Tracker date, Status effective and Last completed
    session/date are derived and not imported; the stray set dump in H1 is
    not imported (the sets live in Log); every other field is a note.
    "Active restriction" (unless "None...") and any "... flag" field propose
    an open flag (semantic).
33. Meal Prep and the Exercise Library are household documents; long prose
    in header cells (Cardio R1, Body protocol headers) becomes member notes.
34. **Agent Audit** rows of all four files become legacy audit entries; a
    blank time is not recorded; rendered text is used for the free-text
    fields.
35. **Not imported** (rendered or presentation only): Today, Charts, the
    person Catalogue mirrors, Daily Nutrition, Chart Data (except the goal
    lifts), Meal Plan (empty). Daily Nutrition and Chart Data feed the
    parity report.

## Parity

36. **Computed through the API**: Nutrition rows via `day_items`, days via
    `day_totals`, recipes via `v_recipe`, Food Source ratios from
    `v_food_source`, Body from `v_weight_7d` and `v_reading`, the Log from
    `v_set`.
37. **Tolerances** as ticket 09; where it gives none: Body ratios ±0.01 (one
    display unit), Log volume ±1 kg or 0.5% and e1RM ±0.5 kg. Chart Data
    daily micros use ±1% or 0.1 (the row display unit, since each row was
    rounded before the sum).
38. **Not compared**: typed inputs (ref-less meals, stored recipes, typed
    Body averages and ratios), rows a ruling holds back, and typed e1RM
    where the app computes none (only RIR 0 with 1–12 reps).
39. **Recognised causes**: a ref'd row that rendered blank →
    missing-formula (its day too); recipe iron → sheet-bug; a stored
    recipe's absent micros and cost → manual-macros; a cell with no formula
    (Food Sources D/E on the newest rows, Hritvik's Chart Data sodium) →
    sheet-bug; Chart Data's SUMIF reading 0 for unknown → sheet-bug; a
    ratio matching the hard-coded height → sheet-bug; a typed Log value
    matching the rounded load → rounding (all mechanical). A row the Catalogue
    mirror computed differently → sheet-bug, semantic; other typed Log
    differences → typed-error, semantic. Anything else is unexplained until
    ruled by hand.

## Final-load SQL

40. Plain multi-row INSERTs in foreign-key order, ≤ 90 KB per statement and
    ≤ 1 MB per file, no BEGIN/COMMIT/PRAGMA, without the rows the migrations
    seed. Ids are kept, so the write log, record versions and every link
    survive. Verified by replaying into a fresh migrated database (tests)
    and into a local D1 with `wrangler d1 execute --local` (rehearsal).

## Measurement cadences (ticket 27)

41. **The gap registry is seeded as Hritvik's cadences.** The importer
    reads `gap_registry` from `shared/config.yml` (`rehearse-cli` passes
    it; `rehearse()` seeds nothing without one, so fixtures stay
    independent of the repo config) and writes one
    `set_measurement_cadence` per entry, as the last stage. Its sources
    named his person file's tabs, so each is mapped through that file's
    headers: a Body column to its reading metric (the fasted-weight column
    to `weight` in `fasted`), Photos to `manual`, a Cardio HR column to
    `cardio_hr`, a Log exercise match to `exercise`. Anything else is a
    semantic `unmapped_cadence` ruling with no proposal. The origin is
    `config/gap_registry!<n>`, n the entry's 1-based position. The real
    rehearsal was not re-run for this.
42. **A label energy mismatch is ruled on before the write.** The importer
    runs the domain's `labelEnergyCheck` on each Food Sources row first.
    A miss is a semantic `label_energy_mismatch` ruling whose proposal is
    an override reason ("imported as typed ..."), applied while pending,
    so the source still loads and the rehearsal shows the fullest picture;
    rejecting the ruling leaves the source out. Without this, the API's
    clarification would leave every such source (and what uses it) out
    as `rejected_by_api`.

## Rehearsal build (ticket 25)

43. **(e1RM part superseded by 55.)** **The per-implement convention, read from the typed columns.** A
    per-leg row whose typed total equals one leg's load is a single-leg set
    that covered both legs (volume counts both), not a unilateral one; only
    a per-hand row reads as unilateral that way. The parity report
    compares a typed e1RM with the app's per-implement e1RM, and its
    rounding check rounds the per-implement load (what Sheets rounded), so
    an e1RM typed on the whole total is a semantic typed-error ruling, not
    "rounding". On this snapshot the 4 ruled rows now match, and 5 rows
    typed the other way (e1RM on the total) become new typed-error rulings.
44. **A pointer row's replacement takes its place.** A refused Log row
    ruled `{ replace_with_rows: "<file>/Log!<from>-<to>", at_position_of:
    "<file>/Log!<n>" }` (a block recovered from later rows) has those rows loaded
    right after it, so `log_set` appends them where the pointer stood and
    the session's `position`s are the real running order. The pointer row
    is still attempted and stays a rejected ruling.
45. **Metrics added by ruling.** A Body column ruled `{ add_metric:
    <code> }` is logged as that metric (seeded by migration 0020), in the
    unit its header names ("BIA BMR (kcal)"). Without a ruling, or with a
    header that names no unit, it stays out as before.
46. **Ruled progression rules are stored as the API's rule.** An
    override's `increment { min_kg, max_kg, basis }` becomes `{ min, max,
    unit: kg, basis }` (the check converts it into the load's terms), and
    0/0 becomes `"smallest_step"`; `rir_floor: from_prescription`, `cue`
    and `per_leg` pass through; a manual override keeps its cue.
47. **Non-rep Program rows ruled `{ prescription_target, progression:
    manual }` are prescriptions.** The target comes from the Reps cell:
    "20-25 min" is 1200-1500 s, "max time" a duration with no range,
    "30 m" a distance, "6-8" a rep range with no RIR. Sets, rest, the
    starting load (assistance negative), cue and fallback are read as for
    any prescription; the rule is manual. A cell that doesn't read as the
    ruled kind is a new `prescription_target` ruling. A row without such an
    override stays a programme note.
48. **A substitution set ruled `{ set_type: substitution, replaces }`**
    is linked to the prescription of that exercise (name or alias,
    ignoring case) in the session's template, else in the member's active
    programme. None found is a new `substitution_target` ruling.
49. **A value read by hand.** An `unreadable_value` ruled `{ reps, note }`
    loads the set with those reps, the note appended to the set's note.
50. **A left-out set's note goes on its prescription.** A refused set
    ruled `rejected` with `{ member_note_on_prescription: true }` writes a
    member note (topic "set left out of the import") on the prescription
    it was for: the exercise's prescription in the session's template (or
    the programme), else the template's one prescription whose name the
    set's name contains or is contained in ("Leg Press Machine" for
    "Leg Press"). The note has the date, session, set and the Sheets note.
51. **Manual macros for a refused row.** A refused intake row ruled
    `accepted` with `{ manual_macros, provenance, confidence, reason }` is
    logged again as a manual item with those values; label and note stay.
52. **The unitemised remainder.** A `day_total_with_items` ruled `{
    keep_items_plus_remainder: true, provenance }` adds one manual item
    (snack slot, label "Unitemised (DAY TOTAL minus items)", confidence
    low) for DAY TOTAL minus the items' totals as the API computes them.
    A macro the items already exceed would be negative: that is a new
    `remainder_below_items` ruling proposing 0 for it. The parity report
    explains a day total above Sheets' items-only total by exactly that
    item as `manual-macros` (mechanical: the ruling decided it).
53. **Phases.** The base Guide's PHASE MAP is Hritvik's (31): each "Wk
    ..." row is a phase through `programme_change` `add_phase`, named by
    its first clause ("Phase 1 Base"), with the row as its intent. Dates
    come from the row ("3 Aug - 11 Oct 2026", "12 Oct.", "17-30 May."),
    the year carried forward and rolled over at January; a phase given
    only its start ends the day before the next starts, so phases never
    overlap. The stance is read from the row's words (deficit / cut,
    maintenance, surplus). A row naming none, or a range ("maintenance to
    slight surplus"), is a semantic `phase_energy_stance` ruling proposing
    maintenance, or where the range ends up. A member without a phase map
    gets one open-ended phase proposed by a `phase_from_handover` ruling:
    named by the People goal, starting at the Handover's Status effective,
    deficit for a Cut, the status as intent. Phases already past and those
    still planned are imported alike: the map is the plan of record, and
    a later review changes them with `amend`.
54. **(Lists, barbell and sleds superseded by 58-60.)** **Gym inventories, as rulings.** Only a member with a programme gets
    one (Asha's and Kabir's gyms get none). The gym notes are prose,
    so every implement is a semantic `implement_inventory` ruling whose
    proposal is the whole implement, applied while pending. Read from the
    base Guide, the member's Program (L-P), Log notes, Agent Audit and
    Handover:
    - **Dumbbell racks**, one per unit, from lists ("kg rack runs
      a/b/c", "the rack runs a, b and c lb"); a trailing "..." leaves
      the maximum unknown; "N kg dumbbells do not exist" removes N.
    - **A barbell with pound plates per side** when the notes say the
      plates are pounds: every multiple of the smallest confirmed plate up
      to the heaviest per-side load named for a barbell lift.
    - **Fixed bars** from the bars the notes name.
    - **One implement per prescribed machine, cable or plate-loaded
      exercise**: every load lifted on it (in the basis it was lifted:
      per side for a cable fly, plates per side on a sled, whose weight is
      unknown, so `plates_only`), plus a measured stack's list; a stack
      that "steps in N kg" lists the multiples of N instead, and the loads
      it can't make (old phantom prescriptions) are named in the ruling.
      Pounds are read where the row's notes give them (a converted kg
      value within 0.25 lb of a 2.5 lb step is that step); a sled whose
      notes say "kg plates" stays in kg, and pound-plate loads on it are
      pointed out.
    Maxima are unknown everywhere except a closed rack list. Inventories
    load after the Log, so imported sets keep no implement and are never
    snapped. A prescription is linked (`create_implement`) only when its
    stored load is on the list exactly, in the implement's unit and a
    matching basis; Sheets' rounded conversions (6.8 kg for 15 lb) stay
    unlinked and are named in the ruling, so `next_prescription` never
    reports an off-list load that is only a rounding.

## Rehearsal, second build (ticket 25, batch 4)

55. **The split e1RM convention at parity.** The Log's typed e1RM is
    compared with `v_set`'s, whose share now follows the implement kind
    (a total on barbells and plate-loaded machines, per hand, side or leg
    on dumbbells and cables); the rounding check rounds that share, as
    before. Rows typed on the other side of the convention stay
    typed-error rulings; rows the old convention flagged that now match
    are no longer raised (their decisions are carried, as decision 10
    says). On this snapshot four rows are typed-error and five match.
56. **Compositions from the notes.** A Log row (per side, or a total) is
    imported as a composition when its note states one that adds up to the
    typed load, at the decimals it was typed with: "<n> kg bar + <n> lb per
    side" (the bar named), "bar + <n> lb per side" (the bar is the typed
    total less both sides, to the half kg) and "<n> kg + <n> lb per side"
    (two plates a side, no bar). A note whose composition doesn't add up is
    about another load ("progresses to ...") and is ignored. A row with no
    such note whose typed load is, as rounded, a composition stated on
    another row of the same exercise in the same file takes the earliest
    such composition: Sheets typed the rounded kg, the note said what was on
    the bar. Mechanical, since the note is explicit; no ruling.
57. **Native units for everything else.** A Log load is read in its native
    unit (the domain's `readNativeLoad`, decision 41 there) and logged so;
    the typed kg stays in the audit detail, and the bar of a per-side row is
    still the typed total less both sides, in kg. A load clean in neither
    unit or in both is a semantic `load_unit` ruling proposing the load as
    typed (applied with `as_stated`, so the API doesn't ask again). A
    programme's load is read natively too, but one clean in no unit stays as
    typed with no ruling: it is a plan (a barbell total of a kg bar and lb
    plates is clean in neither), and the coach moves it with
    `programme_change`.
58. **Inventories in native units, with directives.** Lists are amounts in
    their own units (a stack may mix them); a dumbbell "N kg do not exist"
    is recorded absent rather than dropped. A decision may override with
    directives instead of a whole implement: `top: unknown...` sets the
    list incomplete, `mixed_units` needs nothing more (every proposal is
    already native). Any other override is the implement itself, as before.
59. **Barbells and sleds take their loads from plates.** The loadable
    barbell carries the bar the notes name and no load list (the ruling
    keeps the key it was decided under); a plate-loaded machine is plates
    only with no list. The gym's plates are one plate set per unit, never
    complete: a denomination is confirmed where the notes say "N lb plates
    ... confirmed/available", absent where they say "no N kg plate", and
    otherwise inferred from each per-side amount lifted on a barbell or
    plate-loaded machine (a composition counts per unit), as the fewest
    common plates that make it. This raises no ruling: nothing is claimed
    as known (`inferred`, `complete: false`), and `inventory_gaps` asks.
60. **Linking prescriptions.** A prescription's load, read natively, links
    to a list it is on, or to a list whose top is unknown when it is above
    the known top in that list's unit (next_prescription then says
    unverified); to plate-loaded kit whenever its basis is per side. A
    barbell prescription typed as a total stays unlinked (its basis isn't
    per side), as before.
61. **Owner-only database.** `LocalDb` creates the rehearsal database
    file 0600 (its directory 0700) before SQLite opens it, so the file and
    its journal are never readable by others; the other outputs were
    already written 0600 by `writePrivate`.
62. **The second rehearsal.** Run twice with byte-identical rulings,
    parity and final-load SQL; the SQL replays into a freshly migrated
    database with the same rows in every table and no foreign-key
    violation. The gate passes with no pending ruling.


## Cutover fixes (6 Oct 2026, final snapshot)

63. **Load basis by ruling.** "Per ankle" is per leg (one ankle weight on
    each leg; the total is both), on Log sets and Program loads. Any other
    basis the app has no word for is a semantic `load_basis` ruling with no
    proposal, on the Log (the set stays out while it is pending) and now on
    the Program too, which used to drop the load without a word (the
    prescription still loads, without a load). A decided override
    `{ basis }` (the app's name, or Sheets' words) is honoured; a basis
    that is neither is a new `load_basis_override` ruling. Decided by the
    coordinator at cutover, vetoable by Hritvik.
64. **A decision holds only for the row it was decided on.** Every decided
    ruling stores `decided_on`, a 16-hex sha256 of the cells it records
    (`row`, keys sorted). When a later snapshot's row hashes differently,
    the ruling is raised again as `pending`, its old decision, override,
    note and row kept under `previous_decision` until someone decides it
    again; meanwhile only the proposal applies, provisionally (12), and
    the gate fails. A decision without a hash (every one before this
    change) takes it from the row stored beside it, so rulings decided on
    the 5 Oct snapshot are compared with the rows they were decided on.
    One that recorded no row (a parity ruling written by hand) can't be
    compared and is kept, as are the importer's own mechanical decisions,
    which it simply makes again. Two loaders read a decision before
    raising (an exercise alias, a Log block moved by a pointer row); the
    raise that follows still marks a stale one pending, so the gate
    catches it. Decided by the coordinator at cutover, vetoable.
