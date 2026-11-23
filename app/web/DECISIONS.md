# Web app decisions

Built for ticket 29 (*Web app shell and the Today screen*) on 6 Oct 2026, in the Household pot design (`docs/design/DESIGN.md`, chosen from prototype variant B), against the Worker's `/tools` API and the rules in ticket 15 (*Agent API surface*).

## Stack

1. **Vite 8 + React 19 + strict TypeScript, no UI kit.** Two runtime dependencies (`react`, `react-dom`); dev dependencies are Vite, its React plugin, TypeScript, Vitest and the type packages. All pinned exactly (root `.npmrc` has `save-exact`).
2. **A static PWA manifest, no service worker.** `public/manifest.webmanifest` with SVG and PNG icons (a steel tiffin with a haldi tier) makes it installable. There is deliberately no service worker and no offline write queue: a queued write could land after a member has changed their mind, and offline writes were ruled out for this ticket.
3. **Mukta from Google Fonts**, weights 400/500/700, `display=swap`, with the fallback `"Noto Sans", system-ui, sans-serif` from DESIGN.md. Tabular numerals on `body`.
4. **Tokens as CSS variables in both themes, following the phone** (`prefers-color-scheme`), with no in-app theme switch. One token was added beside DESIGN.md's: `--on-haldi` (text on a haldi fill, 7.3:1 light, 8.8:1 dark), because `--haldi-ink` is light in dark mode and fails on haldi. The pot card's shadow colours are tokens too, so no component rule holds a literal colour.

## Talking to the API

5. **One client, `callTool(name, input)`: POST `/tools/<name>` with JSON, `credentials: "same-origin"`, `redirect: "manual"`.** In production the page and the API share an origin behind Cloudflare Access, so the Access cookie is the only credential and the app holds none. An expired Access session answers with a redirect (opaque) or an HTML login page; both read as signed out.
6. **Every answer becomes one of six outcomes:** `ok`, `needs_clarification` (the question, shown inline, never as an error), `invalid` (the first issue, with its path), `error` (code and message), `signed_out` (401, or 403 with `unauthenticated`/`forbidden`), `offline` (the fetch threw). A 403 `not_visible` stays an error: it is about one record, not about who you are.
7. **Writes are plans with fixed idempotency keys.** A tap makes a plan of one or more tool calls, each with its own key fixed when the plan is made. "Try again" reruns the same plan with the same keys, so a step that already landed is replayed by the API rather than written twice.
8. **Write status sits next to the thing written**: "Saving…", then "Saved"-style words in `--leaf` ("Confirmed.", "Share changed to 40%.", "Marked the rest leftover."), a question in `--ink`, or a failure in `--chilli` that says what to do next ("Not saved: you're offline. Try again when you're back online." / "… Refresh to see the latest, then try again." / "… Change the value and try again."). Two known questions are reworded in plain words (`portions_exceed_whole`, `nothing_unaccounted`); any other is shown as the API asks it.
9. **In development Vite proxies `/tools` to `wrangler dev --local` on :8787**, which signs localhost requests in as `LOCAL_DEV_IDENTITY` from `app/worker/.dev.vars`. `npm run dev` starts wrangler when nothing answers on :8787 and reuses it otherwise.

## Reading the day

10. **Existing tools where they fit:** `day_totals` (left, targets, so far), `flags`, `staleness`, `next_prescription`, and for writes `confirm`, `reject`, `amend`, `mark_remainder`. `query` over `v_*` was not needed.
11. **Three new read-only tools where nothing fit**, in `app/worker/src/tools/screens.ts` (one new file plus a one-line registration; no existing tool, migration or `wrangler.jsonc` changed):
    - `whoami`: the signed-in member, the household's members with them first, and today's date in the household's time zone. The app needs to know who "you" are, and "today" must be the household's day, not the phone's.
    - `day_meals`: the day as meals in order, each **eaten** (with its items and its kcal and protein), **skipped**, **nothing yet** (an open day) or **not recorded** (a partial or complete day with nothing there); each item with its provenance, ± kcal, state and, for a draft, who logged it; and the day's `estimate`. Per-meal totals and the day's ± are nutrition, so they come from the API, not the UI.
    - `day_cooks`: each cook eaten that day, with each present member's share (the signed-in member's first, marked `you`), the remainder and its status, the members with no portion, and `ask`: the viewed member's draft portion with its kcal and who logged it, given only to that member (or the agent).
12. **The day's estimate is the sum of each item's dominant ± kcal** (the conservative bound; independent errors would combine to less), and the largest is named. Estimated items with no ± are counted separately, because real data has many of them and the screen must not imply they are certain.
13. **Meal order:** pre-workout, post-workout, breakfast, lunch, snack, dinner. Breakfast, lunch, snack and dinner always show (so an empty one reads "nothing yet"); the workout meals show only when used or skipped. There is no time of day on an intake item, so tier headers carry kcal and protein but no time.
14. **A meal on a partial or complete day with nothing logged is "not recorded"**, not "nothing yet": the day is closed, and blank is never zero.
15. **Another member's day shows household data only.** Selecting their pill reads their `day_totals`, `day_meals`, `day_cooks` and `next_prescription`; their flags and staleness (owner-only) are never requested. Their drafts show who logged them but no buttons: only the member a draft is about can confirm it.
16. **`?member=` and `?date=` in the URL** select the member and day, so a past day (for example the last day of real data) can be opened and reloaded.

## The screen

17. **Order and parts exactly as DESIGN.md:** title row and pills, the left line, the macro strip, pot cards, meal tiers, the footer. The pot card is the only raised element.
18. **The macro strip uses a 5-row subgrid** so the four tracks stay level when one column says "over by". Over a target is "over by N" in `--ink`, with a full track; never red. A floor or remainder is a caption line ("floor 45", "the remainder").
19. **Split bar widths are flex-grow by share**, so the 2 px gaps never push the total past the card. Segments under 13% of the pot hide their label visually; the bar's `aria-label` always names every share, the remainder and who wasn't there.
20. **The pot ask:** "Yes, confirm" confirms the portion, and the API confirms its intake item in the same write (ticket 32; before that the app named both). "Change my share" opens an inline percent field; saving amends the portion's fraction, which (the member's own edit) confirms the portion and its intake item in one write, so there is no second confirm call. "Mark the rest leftover" calls `mark_remainder` with provenance `estimated` (the schema has no "reported"). With no draft but an unaccounted remainder on your own day, the card still offers "Mark the rest leftover".
21. **Three absences look different:** nothing yet is a dashed outline, skipped a solid outline with "skipped" in ink, not recorded a dotted outline in italic.
22. **Amounts:** the member's own words when short and not a repeat of the name ("2 medium"), otherwise the structured amount to at most two decimals ("118 g", "0.33 pc", "2 roti", "1.5 servings", "38% of the pot").
23. **Loading is a static skeleton in the layout's shape**; nothing animates except the split segments and the tracks (400 ms ease-out, only under `prefers-reduced-motion: no-preference`). A re-read after a write, on reconnect, or on returning to the app is quiet (no skeleton).
24. **Offline:** a read-only banner over what was loaded ("Showing the day as loaded at 17:20"), with every write button disabled, and a quiet re-read on reconnect. Offline with nothing loaded shows a "You're offline" screen.

## Tests

25. **Seams, chosen by the build agent (no one was available to confirm them):** the Worker's HTTP seam for the three new tools (`app/worker/test/screens.tools.test.ts`, through the existing harness); and in the app, `callTool` with an injected fetch, `loadToday` with an injected call, `buildToday` (API data in, screen model out) and the write plans with `runPlan`. Components and CSS are checked by screenshot (`docs/design/critiques/today/`), not unit tests. Test data is invented (Asha, Kabir, Noor).
26. **The MCP tool-list pin** (`app/skills/test/live-tools.txt`) gained the three names in a "ticket 29, not yet deployed" block, because `app/skills` tests pin the Worker's tool list. That is the only change outside `app/web` and the new Worker file.

## Follow-ups from the Today build (ticket 32)

27. **One origin.** The Worker serves `dist/` as static assets (`assets` in `app/worker/wrangler.jsonc`), and only `/tools` and `/tools/*` run the API code, so the page and the API share the Access sign-in. `npm run deploy` at the repo root builds the app, then deploys. `wrangler dev` needs `dist/` to exist; `npm run dev` creates it empty (Vite serves the app in development).
28. **"Logged by" names the speaker.** An agent's write now records the member the agent was talking with, and the app names them ("Kabir logged your 38%"); "the agent" (or "the Inbox") only when none was recorded.
29. **A portion's ±** is shown in the pot ask in `--haldi-ink`, as DESIGN.md asks of estimated values: "(about 180 kcal, estimated ±35, mostly ladle size)". With no size it says "estimated" alone, still in `--haldi-ink`; a weighed or counted share names its provenance in ink.
30. **Next session's loads** follow the "Next session" row in the footer, on your own day only: one row per lift with a load, written as it goes on the bar. A composition is the bar plus the plates a side ("20 kg bar + 10 kg + 5 lb a side", "2 × 20 kg a side"); a plain load is its value with its basis ("16 kg", "12.5 kg a hand"). Another member's day still shows only their session.

## Follow-ups

- **The other screens:** Drafts, Household meal, Live session, Trends and Data health, each its own ticket. A wider desktop layout belongs with them.

## App display (spec 2026-10-06)

31. **The shell:** a global member bar on top and a bottom tab bar (Today · Train · Progress · Household; one stroke icon set, labels always shown, the active tab filled in `--ink`, never haldi). On a wide screen the tabs keep to the app's 430 px column. Routes `/`, `/train`, `/progress`, `/progress/health`, `/household` with `?member=`, `?date=`, `?range=`, `?week=`; each tab keeps its sub-page and scroll. `/train/lift/:slug` and `/train/board` open Train until v2. No router dependency: `route.ts` parses and builds URLs, tested.
32. **Progress is owner-only as a whole.** For another member its loaders return "Progress is private to *name*." without a call.
33. **The strip** shows only on your own today (the household's today from `whoami`, never the phone's clock), and replaces the footer's flag and staleness rows; Today no longer reads `flags` or `staleness`.
34. **The Today footer is one line**, the next session linking to Train (spec §13's proposal), now that Train shows the loads.
35. **Plate diagram:** heights from a table of standard plate sizes per unit (display only; no conversion), at most 8 drawn with "+N", each labelled in its own unit; stacks and dumbbells show a value; assisted loads read "N kg assistance". Rotated labels get 28 px; the longest real denomination, "1.25 kg", measures 26.7 px at 9 px in Mukta.
36. **A prescription has no heart-rate band in the schema;** cardio rows show their duration and cue, and no band field was invented.
37. **Two-tap gym answers** where a tool takes them without a number: an unverified step on a listed implement (`add_implement_load` / `remove_implement_load`), and plate denominations (`record_plates`: the tapped ones available, the rest absent). Stack tops, rack ends, bar and sled weights need a number, so they say "Tell the agent at the gym".
38. **Charts are hand-drawn SVG** over `charts/scale.ts`; the latest reading is haldi, goals ink at low emphasis, method changes cut lines, marks clamped inside the drawing, every chart has its title, a summary line and a data table. A target shows as `low`, or "low–high" when they differ, in the metric's own format ("0.50", "74.0 kg"), never a midpoint. The headline value and verdict don't depend on the range; with "All", the stacked charts share one axis.
39. **Health groups markers by the draw they came from** (the schema has no panel column), out-of-range first, each with its draw's lab and date; reports never received are open `data` flags.
40. **Household:** a member row opens that member's Today; a leftover is eaten by a member at a meal (two taps: who, then which meal, asked in words, because the API dates it today and needs the slot; all six meal slots are offered) or discarded. A failed write is resent only with "Try again", which reuses its idempotency keys; the slot buttons stay disabled until then.
41. **History link** on each of Today's items and each of Train's sets opens the audit trail in place, on a row of its own. Train's "Show earlier" appends earlier sessions without leaving the page (the next session and the scroll stay).
42. **Sheets-era notes** come from the API (`honesty`, `imported`): "Imported from Sheets.", the typed-macro share when high, and "estimated, no ± recorded".

## Food tab (spec 2026-10-06, Task 17)

43. **Confidence follows provenance:** follows the household rubric (gym-nutrition skill): weighed and label are `high`; counted is `medium`; estimated is `low` (a portion or preparation assumed). The member never picks a confidence, and a `dominant_uncertainty` (what, and ± kcal) is sent only when they fill it in.
44. **A food's states are its catalogue siblings of the same name** (from `catalogue_search`). The amount row names the state of the ref picked and shows the other states as chips, so a state is always chosen; switching state drops the usual amount, which belonged to the other state.
45. **A share of a pot is `mark_remainder` with `disposition: "eaten"`,** one write, by percent or grams. A share of a pot whose rest is already leftover is recorded as a leftover serving through the Worker's own path (the app sends member and meal slot); any question the Worker does ask shows inline.
46. **Offline, the picker filters what is loaded** (pots and recents); search needs the network, and a Save waits for it with the entry kept.


## The + sheet (spec 2026-10-06, input)

47. **The meal by the household's clock.** `whoami` gives `time` (HH:MM in
   the household's zone); the sheet suggests breakfast until 10:30, lunch
   until 15:00, snack until 18:30, then dinner. The day is the one being
   viewed.
48. **Every Save is a plan, through the one write hook** (`useWrites`,
   extended: `run` returns each step's answer via `runPlanResults`, and
   `slot(key)` gives a form its Save): one key per call, fixed when the
   plan is made; "Try again" resends the same plan; a failure or a
   question keeps the entry; the next Save is a new plan. A sign-out is
   the caller's: Today and Train reload, the sheet keeps the entry
   (`KEEP_ENTRY`) and says so beside "Sign in again". A Save bumps
   `useSaved()`, and screens re-read.
   Unlike Today's confirm buttons (decision 24), a sheet's Save stays
   tappable offline: spec §10 has it say "Not saved: you're offline. Try
   again …" and keep the entry, and there are still no offline writes.
49. **Confidence follows provenance** in the Food tab, as decision 43
   records and the code does: weighed and label are high, counted is
   medium, estimated is low. (The input plan's draft had counted high and
   estimated medium; 43 is the household rubric and stands.)
50. **Workout rows carry the planned load; reps and RIR start empty**
   (the target is the placeholder), so a plan is never logged as done.
51. **Free text is read on "Read it"**, not per keystroke. A span mapped
   by hand is replaced by the item's name and the text is routed again, so
   the API reads the amount; the mapped row counts as edited. A resolved
   row's words can be changed: only those words are routed again and
   their rows take its place, edited. What a Save or a send took leaves
   the text, so nothing is saved twice.
52. **Feedback's context**: route with query, the day viewed, the build's
   git commit (`__APP_VERSION__`), phone below 700 px, and the time.
53. **Preview latency** (p50/p95 of `what_if`, `preview_set`,
   `preview_meal`, and `route_text` beside them; `commit_route` only with
   `--writes`, since it saves) is measured on the deployed Worker after the
   deploy (`npm run latency -w @myfitnessguide/mcp`) and added here then.
   `route_text`'s first (cold) run is printed apart: its heavy case was
   about 10-16 ms of CPU cold in Node, against Workers Free's 10 ms.
   Previews are debounced (400-500 ms) either way.
   **Measured 7 Oct 2026, Worker `2d4fbf06`, 20 runs each** (wall time
   from Mumbai through Access; CPU from `wrangler tail`, a sample of the
   calls): `what_if` p50 137 / p95 170 ms, CPU 9-20 ms; `preview_set`
   p50 173 / p95 223 ms, CPU 5-7 ms; `preview_meal` p50 84 / p95 125 ms,
   CPU 5 ms; `route_text` (a 12-piece line) p50 238 / p95 270 ms, **CPU
   25-28 ms**. Every call returned ok, but `route_text` (and `what_if` at
   its high end) is over the Free plan's 10 ms CPU, so a request may be
   cut off (error 1102) when Cloudflare enforces it. Raised with Hritvik:
   the Workers Paid plan, or making the router cheaper.
54. **A reading is a tab in the "+" sheet**, with the strip's cadence
   card and Progress opening it pre-set: the sheet already carries the
   day, the Save status, the keys and the kept entry. Readings are
   owner-only, so the tab is always for you and says where someone else's
   go (chat, as their draft). A weight always asks fasted or not, unless
   the cadence said fasted; a sided metric always asks the side; the unit
   starts at your last one. Five tabs put the tabs on their own row.
55. **Closing a day sits under Today's meals, on your own day**: the
   meals with nothing logged as Skipped toggles, then complete or partial
   in one `set_day_status`, which saves the skipped meals with it;
   reopening keeps them. The strip's yesterday card says so.
56. **Drafts to check**: draft readings on Progress, draft blood draws on
   Health, from `health_drafts`, each confirmed or rejected in one write,
   in the strip's words for who logged it and when it confirms by itself.
   A draft the hourly auto-confirm settled while shown answers `not_draft`;
   the section reads its `history` and says when it confirmed and the way
   to change it now (chat: retract a reading, correct a draw), never
   "Try again". The Reading tab gives back the "for" member it set aside;
   closing a day sends only the skipped ticks still offered.
57. **Food in the member's words** (input critique, 7 Oct 2026). A
   catalogue state shows as words ("as sold", "in shell"), never its code,
   and a ref (FS007) never shows: `foodLabel` for the app's own labels,
   `plainFood` for labels the API wrote for the agent (`learned`'s target,
   `route_text`'s preview names and option labels). Only the known states
   are rewritten, so a dish's own brackets stay.
58. **A workout's set is one aligned line** (input critique): number,
   load, reps (or seconds, or distance), RIR and remove under column
   heads, with the load's kind (bodyweight, not recorded) on the line
   below. A set's `preview_set` feedback leaves out which session it would
   start: the Save (`log_workout`) decides that from the workout. After a
   Save the sheet says how many sets went where, then each linked
   prescription's state, so a saved workout with no prescription still
   says what happened.
59. **A routed question with nothing to pick is answered in words**
   (input critique). `route_text` asks "how much of the X: a share or
   grams?" with no options; the row offers "Say how much", which opens
   the row's words to change and reads them again, as "Change the words"
   does for a resolved row, with a hint naming the forms the router reads
   ("half the dal", "10% of the dal", "150 g of the dal"; the router reads
   a percent as a share since the final fix wave). A second share of
   a pot (`duplicate_portion`) is worded for the member, never "a portion
   of whole; amend it".
60. **A share in grams asks for the whole pot's weight.** When any share
   in the meal panel is "In grams", a "Whole pot, weighed (g)" field
   appears for the cook and its value goes to `household_meal` as the
   cook's cooked weight (weighed). Left empty, the grams share is sent as
   it is and the API's `cooked_weight_needed` question shows in the app's
   plain words, in the preview and on Save.
61. **The page title follows the route** (`pageTitle`): Today, Train,
   Progress, Health or Household, set as the place changes, so a browser
   tab, the history list and a shared link name the page, not a static
   "Today".
62. **One food-state list and every load kind on the Set tab.**
   `FOOD_STATES` (format.ts) is the API's list, read by the new-food
   picker and `plainFood` alike (a Worker contract test pins it). The Set
   tab's "Load as" chips are `LOAD_CHIPS`: Weight, Plates, Bodyweight and
   Not recorded, as the workout rows already offer; none is defaulted.
63. **The latency script refuses an unsafe write run.** `--writes` needs
   an explicit `--date` at least 30 days from today (past or future),
   runs at most 5 times and then measures only `commit_route`; runs must
   be a whole number of at least 1; no runs gives null percentiles. This
   amends 53's "only with `--writes`".
64. **A first step's definitive refusal is rejected, not held**
   (`refusedOutright`), like `invalid` (round-2 ruling of Task 25): a 4xx
   error code the API raised (`not_visible`, `not_draft`, `not_pending`,
   `not_this_member`, `not_found`, a 422 constraint, ...) on the plan's
   first step means nothing was written, so the entry unlocks and a
   changed entry is a new plan. Held for "Try again" with the same keys:
   offline, 5xx, a proxy's own error page (`http_NNN`), 408 and 429, the
   409 `idempotency_key_reused` (a write with that key landed), and any
   refusal after an earlier step landed.
66. **Progress's wide table lists the chart's own rows with the nearest
   earlier 7-day weight.** No tool returns a value per week, so the rows
   are the lead chart's dated readings and goal points (newest first),
   each with the latest 7-day fasted weight the weight chart gives on or
   before that date and within 7 days; none in that window is blank.
   Weigh-ins and tape readings fall on different days, so an exact-date
   match almost never showed. The web selects a point the API gave and
   computes nothing.

67. **Free text goes to Claude.** The sheet's last tab is "Tell Claude": one
   box, sent whole (trimmed, at most 5,000 characters, one span over all of
   it) with one `submit_to_inbox` step and one key per tap. The app reads
   nothing itself; decision 51 (read on "Read it") is retired. The Worker's
   `route_text` and `commit_route` stay for the coming in-app reader.

68. **Offline means the browser says so.** A request with no answer is
   offline only when `navigator.onLine` is false. Online, it is an error
   ("The server didn't answer. Try again.", http 0) and held like any 5xx.

## Desktop UI (spec 2026-10-07)

69. **Two layouts, one app, the phone untouched.** `useWide()` picks the
   frame at 1024 px. The frame keeps fixed slots (`appSlots`), and
   `SheetHost` and `CatalogueStoreProvider` sit above it, so crossing the
   breakpoint remounts neither the screen nor the sheet: an open sheet, an
   edit in progress and a held plan keep their state and keys (checked in
   the browser both ways, Task 26). Each screen declares its parts once in
   the phone's order (`layout.ts`); the phone renders them as fragments,
   so its DOM is the live build's (`e342c18`): at 390 px every screen's
   `#root` is byte-identical, light and dark, except Household's Waiting
   on you (spec §4, with `tabindex="-1"` on its plain rows for J/K), the
   top menu's links (Catalogue, and What I've learned as a link, spec §2)
   and `data-search` on the sheet's Food search. A part moved between the
   phone's stack and a wide column does remount: its unsaved typed text
   (a pot card's share field, a reject reason) resets, but every write
   status and held plan lives in the screen's `useWrites` or the catalogue
   store, which don't.
70. **Waiting on you confirms in one write.** Ticked drafts go in one
   `confirm` (all or none; Worker decision 126 made it set-based). A batch
   refused because a draft settled meanwhile wrote nothing, so it is not
   held: the list re-reads, each settled row leaves with how it settled
   (from its history), the other ticks stay, and Confirm is a new plan. A
   held batch's Try again goes through the same rule. Rejecting stays one
   at a time, with a reason the member writes. The list is an inset
   `--steel` panel, like Drafts to check, so the pot cards stay the
   screen's raised objects.
71. **The catalogue edits through the tools, never around them.** Every
   write is a plan with one key, a reason the member writes (never
   pre-filled; the old "Forgotten in the app" is gone with `LearnedSheet`)
   and a re-read once it lands. Edit sends only the changed fields; an
   emptied micronutrient is `null` (unknown), never 0. A ref never shows;
   it lives in the URL and the plans. Drafts and held plans live in the
   catalogue store. A recipe line, added to a recipe or written in a new
   one, answers an ambiguous food with an optional "State, if it asks";
   left blank, the API asks. Exercises are read-only until ticket 38.
72. **Keys never fight the browser or a field.** Only Esc acts inside a
   field; nothing fires with Ctrl, Cmd or Alt. Rows, the search, Edit and
   Cancel take part by `data-row`, `data-search`, `data-edit` and
   `data-cancel`, so a new screen joins by marking them. Esc closes the
   list of keys, then the sheet, then an open edit; with nothing open, Esc
   in the screen's search leaves the field so J and K move through what it
   found. Hints show only in the wide sidebar. Enter in Tell Claude is a
   newline (67); "Send to Claude" sends.
73. **The sheet is a panel on a wide screen.** The same sheet, placed as a
   360 px panel with no scrim and not modal, so your day stays usable
   beside it; Esc closes it and focus returns to what opened it.

## Try again and waiting texts (hotfix 584e0c7, tickets 62 and 64)

74. **"Try again" finishes the form's Save** (ticket 62). A form's
   post-save step (close it, reset it, show what was logged) is passed
   with the plan (`write.run(plan, after)`; `closeOnSaved(onBack)` for a
   form that closes) and kept with it (`writeBook`), so "Try again" runs
   it too: a held Save whose retry lands closes or resets the form exactly
   as its own Save would have, and Save can't fire again with new keys for
   a write that landed. `retry` returns the result. Every form that acts
   on its Save does it this way: food amount, a pot share, new food, the
   meal panel (and its own Try again), a set, cardio, a reading, a
   workout, Tell Claude, a rack plate, feedback, save-as-workout on
   Train, a leftover eaten on Household, and a pot card's share.
   Drafts to check keep their own retry (`decide`), which re-reads history.
   The desktop's own forms do the same: a catalogue edit, every small form
   (a measure, a recipe line or added line, a word, a bar or a load, a
   workout line added or removed), a new food or recipe (which opens the
   new record), and Waiting on you (Confirm clears the ticks or settles a
   refused batch; Not mine closes its reason). Their status-watching
   effects and wrapped retries are gone. The "+" sheet counts every
   attempt, Try again included, as in flight (`writeBook`'s `track`).
75. **Today shows a member's texts waiting for Claude** (ticket 64).
   Today also reads `inbox_entries` (pending, the viewed member named, as
   entries are household-readable) and keeps that member's entries for the
   day shown. Under each meal, a line per text: Waiting for Claude:
   "<text>"; an empty meal with one says "sent to Claude", not "nothing
   yet" or "not recorded" (a skipped meal still says skipped). Close the
   day never offers a meal with a waiting text as skipped; since
   `set_day_status` replaces the list, closing again clears an older skip
   on that meal. A failed inbox read shows no lines and offers every empty
   meal, as before. An entry with no meal (only an agent can send one) is
   not shown. Logging an item into a skipped meal does not clear its
   `skipped_meal` row (no write touches it but `set_day_status`); Today
   shows the meal as eaten, and the next close drops the skip.

## Fixing what was logged, and no home gym (tickets 61 and 63)

76. **Your own confirmed food has Edit and Remove on Today** (ticket 61).
   Two quiet links beside "history" on each confirmed item of your own day
   (any date); a draft keeps Confirm / Not eaten, and another member's
   items get nothing. Remove asks once, inline ("Remove 2 pc Whole egg from
   Breakfast?" Remove / Keep), then sends one `retract` of the record the
   API takes: the `portion` for a pot share, the `leftover_serving` for a
   leftover helping (`day_meals` now names it, Worker decision 134), else
   the `intake_item`. The reason is fixed, "Removed in the app"; the member
   types nothing.
77. **Edit amends only what changed, where it lives.** Edit opens an
   inline form on the row, pre-filled: the amount in its own unit (a food's
   `amount_value`, a recipe's `recipe_servings`, a pot share's percent or
   grams on its `portion`; a typed item has none), the meal and the day (up
   to today). Save sends one `amend` per record with changes, reason
   "Corrected in the app"; nothing changed says so and sends nothing. A
   pot share's portion goes first and the item's `meal_slot` / `eaten_on`
   after: the share is the step that can ask (more than the pot) or be
   refused, and a first step that asks or is refused writes nothing, so
   the meal and day never move without it. The
   form replaces "reopens the food amount form": the "+" sheet's amount
   form has no meal or day and needs the food's ref, which a Today row
   doesn't carry, so the edit lives on the row like the catalogue's small
   forms. A leftover helping can't be amended (Worker: retract and log
   anew), so its Edit says "A leftover helping can't be changed. Remove it
   and log it again."
78. **Your own confirmed sets have Edit and Remove on Train**, in a
   session's body (both layouts). Edit changes reps and RIR only, checked
   as the Set form checks a new set (reps a whole number to 200, RIR "2" or
   "1-2", RIR required on a prescribed member's working set); one `amend`
   of the changed fields. A cleared RIR is `not_recorded`. The load is
   never edited: `log_set` checks a load against the gym's inventory and
   `amend` doesn't, so the form says "To change the load, remove the set
   and log it again." Remove is one `retract` of the `session_set`. Same
   fixed reasons as 76 and 77.
79. **Each fix is a held plan with its own key** (`fix:` and `fix-edit:`
   per record) in the screen's `useWrites`, with the form's close as its
   post-save step (`closeOnSaved`, decision 74): Try again resends the
   same keys and closes the form when it lands. While one is held, Edit
   and Remove on that row are off; Try again is the way on. A row that
   leaves when its write lands takes its status line with it.
80. **"Which gym are you at?" is answered with gym chips** (ticket 63).
   The Worker asks it (`gym_needed`) with the household's gyms as options
   when a member with no home gym logs into a day with no session. A
   question's status now carries its options; the Set and Workout tabs
   show the gyms as chips under the question, and a chip resends the asked
   plan with `gym` added to its `log_set` / `log_workout` step under the
   same keys (`answerPlan`, `writeBook.answer`; a question wrote nothing,
   so the API takes the corrected call under that key), running the Save's
   own post-save step. The preview's identical line is not repeated while
   the Save asks it. Setting a home gym stays out of scope.

## Coach notes are private (P0 privacy, 2026-10-08)

81. **Train shows a prescription's coach text only on your own Train**
   (click-test P0-1). The notes cite measured BMR, BIA and bloods, so
   another member's Train (`/train?member=X`) shows each prescription's
   exercise, dose, load and state, and no cue and no fallback note, with no
   placeholder: `buildTrain` sets `cue` to null and leaves the fallback
   note out when the view isn't your own. The fallback exercises' names
   are training, not text, so they still show ("Or: Machine row."), on
   their own line when there is no cue to open (`.rx .fallback`). The
   Worker already sends the text as null to another member (Worker
   decisions 135 and 138); this keeps the screen right on its own.
   A prescription's cue and fallback note stay their member's alone
   (decisions 135, 138 and 167), and the swap reason does too (167), so
   the screen's rule is unchanged.

   Training's *own* free text is now household data (Worker decision 167,
   superseding 137's free-text clause): session, set and cardio notes and
   load-change reasons are readable by any member. Train's screens are
   unchanged and do not show them: `buildHistory` words a session's own
   note as "Imported from Sheets." when the API marks it imported and
   otherwise omits it, `setText` words a set without its note, and the
   cardio line words blocks and time only. So another member's Train reads
   the same training numbers it did before; a read that chose to surface
   the notes would be new product, not this decision.

## Long text and the layout sweep (fix/wide-overflow)

82. **Long text never widens a column; a collapsed summary is a two-line
   preview.** A prescription's cue rendered on one line (`white-space:
   nowrap` on its `<summary>`), and a grid stack sizes its one implicit
   track to its widest child's min-content, so a paragraph-long cue pushed
   `.rx`, the wide `.col` and the phone `.screen` to thousands of pixels:
   the cue ran under the Sessions column and the page scrolled sideways on
   both layouts (and the "+" sheet opened off-screen on the phone). The
   rules now:
   - Every single-column stack that holds member- or agent-written text
     sizes its track with `grid-template-columns: minmax(0, 1fr)`
     (`.screen`, `.col`, `.rx`, `.record`), so nothing inside can grow it.
   - `body` has `overflow-wrap: break-word`: a word longer than its line (a
     pasted code, a URL) breaks instead of running out of its box. It
     doesn't change min-content sizes, so nothing that fits moves. A flex
     item holding such text also gets `min-width: 0` and `overflow-wrap:
     anywhere` (a catalogue row's name, a record's title), and its short
     neighbour keeps its line (the row's hint, a prescription's dose).
   - **The clamp rule:** a collapsed `<summary>` showing written text
     (`summary.clamp`; today the cue) shows at most two lines, cut with an
     ellipsis, long words broken anywhere; opened, it shows all of it. A
     clamped box can't be a list item, so the disclosure triangle is drawn
     (within a pixel of the native one).
   - A label clipped to fit a fixed box ends in an ellipsis and can still
     be read whole: a pot segment's name has the segment's `title`, and the
     bar's description and legend.
   - The floating "+" never covers the last row: the page leaves room below
     it (phone `.app` 140 px for the tab bar and the "+"; wide `.screen`
     104 px).
   - The wide screen is as tall as the window, and its parts sit at its
     top (`align-content: start`): a short page (another member's private
     Progress) no longer spreads its title and note down the window.
   `scripts/sweep-layout.ts` checks all of this against the long-text
   sample (`npm run seed:sample -w @myfitnessguide/web -- --long`) on every
   route and state at 390-2000 px in both themes; `test/overflow.test.ts`
   pins the stylesheet rules.

## Click-test P1 fixes (8 Oct 2026)

83. **A measure chip converts the amount; an implausible amount asks
   first** (click test P1-1). Picking another measure keeps the same food:
   the amount is converted through the measures' sizes (118 g picked as
   "medium (118 g)" is 1 medium; 2 medium back to g is 236 g; at most two
   decimals), never kept as a count of the new measure. A piece food's
   measures have no size in pieces, so there a measure (or pieces) starts
   at 1; with nothing typed a measure starts at 1 and a unit empty
   (`switchMeasure`). Save then asks, inline, before an implausible item is
   written (`foodCheck`): one item over 1,500 kcal (what_if's kcal for that
   exact item, asked at Save if the preview hasn't answered yet), or an
   amount 4 or more times the member's usual amount of the food in the
   same measure or unit (recent_items' usual; this check works offline
   too). The rule follows the training side's implausible-load check
   (a ratio against the member's own history, a warning that never
   blocks); food's ratio is wider (4, not 1.6) since two eggs instead of
   one is ordinary. "Save anyway" sends the item as typed; any change to
   the amount asks again. Nothing is refused.
84. **Every question with options is answered in one tap** (click test
   P1-6; generalises decision 80). Any question whose status carries a
   `path` and string or number options shows them as chips under it
   (`questionChoices`, `QuestionAnswer` in the Set and Workout tabs); a chip
   resends the asked plan with the answer set at that path inside the asked
   step (`answerPlan` now sets nested paths, copying, never mutating:
   `gym`, `load.implement`, `sets.3.load.implement`), same keys, the Save's
   own after-save. So "Which cable was the Lat Pulldown done on?"
   (`implement_needed`, whose options the Worker already gives: the
   session's gym's implements of the exercise's kind, now pinned by a Worker
   test) is answered like "Which gym?". The Set tab keeps the chosen
   implement for the exercise's later sets (cleared by Change exercise), so
   set 2 doesn't ask again. The gym chips keep their "Which gym" label;
   other questions' chips are labelled "Answers".
85. **A reading defaults to your usual unit for that metric, shown beside
   the value; an implausible one asks** (click test P1-2). The Reading tab
   settles the unit from `reading_metrics`' `usual_unit` (Worker decision
   139), never the last reading's unit (which put a waist in inches after
   one inch reading); a Worker without it leaves the unit to choose unless
   the metric has one. The value's label carries the unit ("Waist at
   navel, in cm", or "(choose the unit)"). log_reading's
   `implausible_reading` question shows as asked, with one chip, "Yes,
   it's right", which resends the reading with `implausible_ok: true`
   under the same key (`questionChoices`, decision 84). Changing the unit
   chip and saving again is the other way out. Nothing is refused.
86. **Your own readings have Edit and Remove on Progress** (click test
   P1-3), the same pattern as ticket 61 (decisions 76-79): "Your readings",
   on both layouts (right column wide, after the weight chart on the
   phone), lists `reading_metrics`' `recent` (Worker decision 140) in
   words ("Body weight: 700 kg, fasted, Tue 6 Oct"), five then "Show all",
   each with history, Edit and Remove. Remove asks once and sends one
   `retract` of the reading ("Removed in the app"); Edit changes the value,
   the unit and the day (up to today), one `amend` of only what changed
   ("Corrected in the app"), checked as the Reading tab checks a new one.
   An implausible edit is asked about by the Worker; under the question
   (the row's status line) is "Yes, it's right", which resends the same
   plan with `implausible_ok` under the same key. Held plans per record (`fix:reading:N`, `fix-edit:reading:N`)
   as decision 79. A fix re-reads the list and the trends. Readings of
   another member are never listed (Progress is private).
87. **Your own sets that went in as drafts are named, and confirmed on
   Train** (click test P1-5). After a Workout Save, the result says which
   sets log_workout stored as drafts and why, from its own answer (each
   set's `state` and `snap`): "4 of them went in as drafts, not confirmed:
   Romanian deadlift sets 1-4, because 32.5 kg isn't on the gym's list for
   the Olympic bar. Confirm them on Train if that is what you lifted." A
   draft for another reason names the sets without a reason it doesn't
   have. On Train, your own draft sets (in a session's body, both layouts)
   carry "A draft, not confirmed yet." and "Yes, confirm" (one `confirm`
   of the set under `confirm:set:N`; a refusal, such as a prescribed
   set still without RIR, says why), so the strip's "drafts about you …
   Open Train" lands where they can be confirmed. Household's Waiting on
   you still lists them too. Another member's drafts get no button.
88. **The pot card shows an eaten leftover; a refused share says why**
   (click test P1-7). Each leftover helping eaten from a pot
   (`day_cooks`' `leftovers`, Worker decision 141) is a segment of its bar
   in the eater's kind ("Kabir 28% (leftover)", "You 28% (leftover)"),
   between the shares and any remainder, in the bar's description and in
   the legend ("28% eaten as a leftover by Kabir on Wed 7 Oct"). On Today
   and Household alike (one `potCard`). A share change refused as more
   than the pot now says the shares the server named: "With the others'
   shares, that comes to more than the whole pot: Hritvik 40%, Asha 35%,
   leftover eaten by Hritvik 30%. Enter a smaller share."; an older
   Worker's question without them keeps the plain copy. No new segment
   kind, so no new colour.

## Review round (8 Oct 2026)

89. **An answer only ever answers the entry it was asked about; option
   chips only where options are answers; one check per Save tap.**
   - A question's answer (a chip, "Yes, it's right") carries what the
     form would send now; `writeBook.answer` resends the held plan only
     while that is still the asked entry (`matches`, `sameInput`: same
     values, any key order, idempotency key ignored), else sends nothing.
     Every chip site (`QuestionAnswer` in the Set, Workout and Reading
     tabs; a reading's Edit in `Fixer`) also clears the question as soon
     as the form no longer matches, so the chips and the stale question
     go together and the next Save asks afresh. Before, typing 700 kg,
     Save (asked), changing to 70 and tapping the chip wrote 700.
   - The food form's "Save anyway" shows only for the item it asked
     about (`askedFor`), and its Save runs its what_if check once at a
     time (`oneAtATime`): Save is off while the check runs, so a double
     tap sends one plan with one key.
   - `questionChoices` offers chips only for `gym_needed` and
     `implement_needed` (options are values at their path, checked end to
     end in fixes-contract) and the reading's "Yes, it's right". Any other
     question with options (`load_needed`'s "not_recorded",
     `unit_unclear`'s "50 kg", `position_past_end`) stays a plain question
     in the Worker's own readable words.
   - A workout logged for another member says "<Name> confirms them on
     their Train" for its drafts, not "Confirm them on Train".

## Click test, friction and polish (8 Oct 2026)

90. **Food in a few words, and a search that says when it found
   nothing.** The day's biggest uncertainty is named by its first
   sentence when that is short (`shortUncertainty`: at most 40
   characters, no ref, a leading capital lowered), so an agent's note
   ("Egg size. FS016 is a large egg …") reads "the biggest uncertainty
   is egg size, ±40, in Whole egg"; a longer one names only the item. A
   pot ask's "mostly …" follows the same rule. A recent food's usual
   amount in grams or ml is a whole number ("usually 8 g", and the
   amount field starts at 8); a measure or piece keeps two decimals. A
   food whose name already ends on its state ("White rice, cooked") is
   not followed by "(cooked)" again, in `foodLabel` and `plainFood`
   alike. The Food search's placeholder names what it finds (no ref),
   and a search whose answer has nothing to log says so, naming a
   recipe idea it found, with the two ways on: a new food, or teaching
   the word in the Catalogue's Words. Near-spellings are the Worker's
   (Worker decision 143).
91. **A form that closes on its Save says what it saved where it
   closes to** (click test). `closeOnSaved` hands the saved status to
   the form's close, and the Food tab's list (after a food, a pot share,
   a dish or a new food) and the Set tab's exercise list (after cardio)
   show it as a saved line in `--leaf` until the member types or picks
   again. The plans say what and where: "Logged Banana (as sold), 118 g
   to Breakfast.", and for another member "… to Kabir's Breakfast, as a
   draft for Kabir to confirm."; a dish "Logged Rajma to Dinner.". A new
   food's name starts as the search that found nothing, and once added
   the search turns to it and runs again, so it is there to pick.
92. **A dish's ingredient starts in the food's own unit.** A household
   dish's added ingredient starts on the food's own unit (grams, ml or
   pieces, `referenceChip`), as the Food tab does; a measure (tsp, katori)
   is always the member's tap, so "10" for ghee is 10 g, never 10 tsp. (An
   implausible food amount asks first: decision 83.)
93. **A row's status goes once the member moves on** (click test). On
   a row's Edit and Remove (decisions 76-79), Cancel, Keep, Close, and
   opening Edit or Remove again clear what the row's last write said
   when it has said its piece: a question ("more than the whole pot"), a
   refusal, or a saved "Changed." (`clearsOnLeave`). A write going
   through or held for Try again stays. A food's Edit says "To change
   the measure, remove it and log it again.", as a set's says of its
   load; changing a measure or a load in place needs the API (`amend`
   takes neither).
94. **A hold, a carry or a cardio line is not a lift** (click test). In
   the Workout tab, a timed or measured line with no load planned (a
   programme's Zone 2 treadmill, a dead hang) starts with no load, reads
   "no load", and has no RIR field; a counted line with none still asks
   for a load (decision 50). On Train such a set reads by what was stored:
   "Treadmill walk: 26 min 40 s", "Farmer carry: 20 m with 24 kg a hand",
   its RIR only when one was given. The Worker no longer asks RIR of them
   (Worker decision 144). A cardio-machine line is still saved as a set,
   not a cardio block (Worker decision 73 counts either as performing it).
95. **Closing a day says what it will do** (click test). On an open day
   (a reopened one), unticking a meal the API has as skipped saves at
   once (`unskipPlan`: one `set_day_status` that keeps the day open with
   the other skips), so the meal stops reading "skipped" now and a
   reload agrees; a new tick is still the panel's until the close sends
   it (decision 55). Closing, either way, with offered meals neither
   logged nor ticked asks once inline, naming them ("Snack and Dinner
   have nothing logged and aren't marked skipped, so they will read 'not
   recorded'. Close the day anyway?" Close anyway / Not yet). The "+"
   sheet's Food and Tell Claude tabs say when the day they log into is
   closed, and that it stays closed; a log never reopens a day by itself.
96. **Train's forms start where the plan is and say what they did**
   (click test). Picking an exercise in the Set tab, or opening it from a
   prescription, starts a fresh form (`draftForExercise`): the next
   session's load as planned (bar and plates included, the same
   `plannedLoad` the Workout tab uses), reps, seconds and RIR empty, and
   nothing typed, previewed or asked about the exercise before. A Set is
   counted in Reps or Seconds; a timed prescription starts on Seconds with
   no load and RIR optional (decision 94). The plate builder's "no bar
   given" chip is "The gym's own" (the API reads the implement's bar or
   sled), not "The machine's own". A workout row's load names its basis
   beside the unit ("lb a side"). "Save this session as a workout" keeps
   "Saved as …" under its button once the form closes. A holding or
   can't-move reason drops the API's trailing aside in brackets
   (`plainReason`), so "(… (manual rule))" never nests.
97. **A lab unit and a status say only what the report said** (click
   test). A unit stored as the import's "not recorded" is no unit, never
   printed after a value. A marker the API didn't compare (a range in
   words, a value like "<0.5") reads "not checked against the range", not
   "no status"; the wide blood-draw table says "None out of range" only
   when every result was checked ("2 not checked against a range", "1 out
   of range, 1 not checked").
98. **A recipe line's food is suggested from the catalogue** (click
   test). The catalogue's "Add a line" Food field lists the catalogue's
   food names for what is typed (`catalogue_search`, debounced, two
   characters or more, each name once: its states are the State field's),
   as a native `datalist`, so "onion" offers "Onion, raw" before the API
   has to say there is no such food. A typed-by-hand reason that already
   ends a sentence isn't stopped twice ("absent..").
99. **"Not eaten, remove it" asks once** (click test). On Today, a draft
   about you asks inline before it is rejected ("Remove Greek yogurt 100
   g? Kabir logged it; it goes for them too." Remove / Keep), as Remove
   does on your own rows (decision 76); no reason is asked, unlike
   Household's "Not mine", since "not eaten" is the reason. A draft's
   amount still follows decision 22 (the member's own words when short).
100. **Nothing typed or held is dropped without a word** (click test).
   A Save held for Try again in any of the "+" sheet's forms counts as
   busy (`HeldContext`, beside decision 74's in-flight count), so Esc
   leaves the sheet open over it, as over a held Tell Claude send.
   Reloading or leaving the page asks first (the browser's own "Leave
   site?", `useUnsavedGuard`) while the Tell Claude box has text, a
   sheet's Save is going through or held, or a row's Edit has changes.
   A leftover can be eaten in part: "How much of the pot (%)" under
   "Eaten by …", empty for all of it, from 1% to what is left
   (`leftoverShare`; `mark_remainder` takes the fraction of the pot). The
   Reading tab's metrics come in two named groups ("Logged before, latest
   first", "Not logged yet"), so the order reads as one.
101. **Your own cardio has Edit and Remove on Train** (click test), as
   sets do (decisions 78-79): a quiet Edit and Remove on a confirmed
   cardio or class session's row. Remove asks once ("Remove 45 min of
   dance class on Wed 7 Oct?") and retracts its blocks, then the session
   itself (one held plan, a key per step; Worker decision 146), so the
   card and its energy go too;
   Edit changes a lone block's minutes in one `amend` of `duration_s`; a
   session of several blocks says to remove it and log it again. Fixed
   reasons, held plans under `fix:` / `fix-edit:` keys, as before.

## Click test P2 follow-ups (ticket 68, 8 Oct 2026)

102. **A food row's Edit changes its measure** (click test P2-8; Worker
   decision 147). Under "How much" a Measure select offers the food's
   measures with their sizes, then its own unit ("egg (50 g)", "g"), with
   the stored one chosen. Choosing another converts the amount so it still
   means the same food, as the Food tab's chips do (decision 83's
   `switchMeasure`), and Save sends the amount with its new measure or
   unit in the item's one `amend`. "To change the measure, remove it and
   log it again" stays only for a food whose stored measure the list
   doesn't hold. A set's load is still removed and logged again. A new
   amount or measure is checked before Save as the Food tab checks one
   (decision 83, review P2): over 1,500 kcal by `what_if`, or 4× the
   member's usual amount of the food (`recent_items`), asks inline with
   "Save anyway", which holds only while the form holds the amount it was
   asked about (`editAmountCheck`, `askedFor`).
103. **"Log a set" on a later session's card starts that session**
   (click test P2-16; Worker decision 148). When Train's next session is
   on a later day (Upper A, Fri, seen on a Wednesday), its rows' "Log a
   set" opens the Set tab carrying the card's template, and the Save sends
   it, so the set starts Upper A today, early, rather than landing in the
   session the schedule has for today. Today's own card, and the "+"
   anywhere else, send none. The template belongs to the member and day the
   card opened on (review P1-1): choosing another member or another day in
   the sheet drops it (`forMember`, `forDate`, and an owner-only tab that
   sets the member aside), and it is sent only while the day is today
   (`setTemplate`), so a set for Kabir or for yesterday never starts a
   stray session.
104. **Earlier blood draws open on both layouts** (click test P2-22).
   Health's wide-only draws table becomes a "Blood draws" list on both
   layouts (after the flags on a phone, in the right column on desktop):
   every draw, newest first, each a row whose summary gives its lab and
   day, result count and how many are out of range (decision 97's
   wording), and which opens in place to all of that draw's results,
   worded as the panels word them. The panels above still show each
   marker's latest value; an earlier value is read by opening its draw.
   DESIGN.md's tables rule no longer lists the draws.
105. **A draft the agent logged shows its structured amount** (click test
   P2-26; supersedes decision 22 for agent drafts). On Today, an item that
   is a draft and was logged by the agent (live chat or the Inbox) reads
   by its food's name and stored amount ("Provilac High Protein Milk
   280 ml"), never the label's words ("provilac milk 280ml"): those were
   the agent's paraphrase, not the member's, and they stay in the item's
   history. A draft a member logged, and every confirmed item, keep
   decision 22 (the member's own words when short); so does decision 99's
   "Remove …?" question, which names the row as shown.
106. **The rest of the click test's P2 batch** (ticket 68):
   - A set's Edit never asks reps of a set not counted in reps (fixes.ts):
     a hold's Edit has Seconds (one `amend` of `duration_s`), a carry's
     none, and neither requires a RIR (Worker decision 144).
   - A new recipe's Food fields offer the catalogue's food names as "Add a
     line" does (decision 98): one `datalist`, for the line being typed.
   - A timed prescription reads in seconds unless every bound is a whole
     minute: "2 × 30–45 s", "20–30 min", never "0.5–0.75 min".
   - A gym session holding a treadmill block (Worker decision 151) keeps
     its sets summary and gets a "Cardio: 1 block, 20 min" row; its
     Remove retracts only the blocks, so the session and its sets stay
     (decision 101's session retract is for a session of cardio alone).
     The Workout tab says "2 sets and 1 cardio block saved".
   - A day after today in the week reads "Ahead", with no status and no
     "Rest", rather than "Nothing logged · open".
   - Health heads its data flags "Data to check", not "Not received": a
     data flag may be readings that disagree, not only a missing report.
107. **Your own draft on another member's day can be taken back** (ticket
   69; Worker decision 152). On another member's Today, a plain draft
   item you logged (in the app, or through the agent talking with you;
   never the Inbox) says "you can take it back until they do" and has
   **Take it back**, asking once ("It goes from their day."), which
   rejects it with the reason "Withdrawn in the app by who logged it".
   A portion's or a leftover serving's item still waits for its member
   (it is decided through its share). Confirming stays theirs. A record
   they had confirmed and you then edited (Worker decision 153) still
   shows the action, and the Worker refuses it with its own message.
108. **A re-draft is yours to keep or undo** (ticket 69 review; Worker
   decision 154; amends decision 107).
   - **Your own day:** a draft you had confirmed (`ever_confirmed`) reads
     "Draft, edited by <editor>." It offers **Keep their change** (confirm)
     and **Undo their change**, a reject that the Worker answers by
     restoring what you confirmed. It replaces "Yes, confirm" / "Not eaten,
     remove it" there. A plain draft still reads "logged by".
   - **Another member's day:** **Take it back** now shows on a draft the
     Inbox logged naming you, as the Worker allows. It never shows on a
     record that was ever confirmed.
   - **Pot card:** a portion's re-draft is still settled there with its
     present wording.
109. **A re-drafted share reads as a re-draft on its pot card too**
   (ticket 69 re-review; amends decision 108).
   - **Wording:** when `day_cooks`' ask says `ever_confirmed`, the card
     reads "Edited by <editor>: your N% (…). Keep their change?"
   - **Actions:** it offers **Keep their change** (confirm), **Undo their
     change** (a reject, which the Worker answers with a restore) and
     **Change my share**. "Mark the rest leftover" waits until the share
     is settled.

## An Inbox text is its sender's (9 Oct 2026)

110. **Waiting texts are the ones you sent** (Worker decision 157; amends
   decision 75). The Worker gives a member only the Inbox texts they
   sent and refuses naming another member, so Today and the sheet's
   Tell Claude tab read `inbox_entries` naming nobody (`WAITING_INPUT`,
   `freetext.ts`) and keep the texts about the member shown
   (`waitingAbout`): on another member's Today you see only the texts you
   sent about them, never theirs. Waiting on you still names you, which
   the Worker allows, and shows your own texts about you.

## Wide layout (spec 2026-10-08)

111. **Layout goes through primitives, written text through `<Text>`, and
   two lints hold both.** `components/layout/` holds `Grid` and `<Text>`
   (wrap, clamp, truncate, nowrap); a primitive adds its `l-*` classes only
   on a wide screen, so the phone's markup is never touched. New structure
   lives in `layout.css`; outside it, only the selectors in `ADOPTED` may
   set `display: grid|flex`, columns or wrapping, and that list only shrinks
   (ticket 67 converts and deletes them). The text lint (a variable read
   straight into an intrinsic element, through Vite's own parser) and the
   structure lint are ratchets over the counts at `c9524c6` (287 and 127):
   a count may only fall, and a fall lowers the baseline in the same
   commit. Stack, Cluster, Pair and Switcher are sketches in DESIGN.md
   until a screen needs one.
112. **The layout gate blocks a merge; the phone check is a sweep mode.**
   `npm run test:layout -w @myfitnessguide/web` reseeds the stress household
   (the `--long` sample: many, empty and short shapes, invented), builds,
   and sweeps every state at 390, 768, 1,024, 1,280, 1,440, 1,800, 1,920
   and 2,560 px in both themes (1,080 px tall from 1,920, where a state's
   primary object must start in the top 400 px), with three catalogue
   records a pane; any flag exits 1. It is out of `npm test`. With no CI,
   pre-commit runs it at `pre-merge-commit` and, because git skips that
   hook when a merge stops on conflicts, at `pre-commit` while `MERGE_HEAD`
   exists and the merge brings `app/web` or `app/worker` changes (wherever
   its conflicts are). What a merge brings is `HEAD...MERGE_HEAD`, the
   merged branch's own changes since the merge base, so a stale docs-only
   branch is not gated by how far the target has moved. Both paths, a
   docs-only merge and a stale branch were checked in a scratch clone with
   `LAYOUT_GATE_DRY_RUN=1`. A fast-forward, a squash merge (`git merge
   --squash`, concluded by a plain commit with no `MERGE_HEAD`), a rebase, a
   cherry-pick, a clone without the hooks and `--no-verify` still pass it,
   until ticket 67's deploy gate. This branch reaches `main` by such a
   bypass: `main` (3de4c3c) is its ancestor since Task 15's merge, so the
   owner moves `main` with `git branch -f main build/wide-layout` (a
   fast-forward) and no hook runs; its tree was gated already, at 0 flags
   (69 states, 0 failed; 295,854 ms in the conflicted-merge hook and
   300,825 ms standalone, Task 15). The one
   sanctioned skip is `SKIP=layout-gate-merge,layout-gate-conflicted-merge`,
   which skips the gate alone: concluding a conflicted merge (the
   `pre-commit` stage) still runs TruffleHog, and a clean merge's
   `pre-merge-commit` stage runs no TruffleHog either way. It is only for a
   failure the merge didn't cause, after running the gate once more, and
   said so in the merge commit's message. Budget 10 minutes, measured at
   296 s on the work Mac (69 states, 16 viewports, 1,104 shots; 8 Oct
   2026). The phone check
   (`sweep-layout.ts --phone-check --base <ref>`) builds the base in a
   temporary worktree and compares every state's 390 px `#root` HTML byte
   for byte and its pixels (at most 0.5 % may differ), light and dark;
   `--allow` lets a named state differ, with its diff kept for review.

113. **Bands, not breakpoints: the cap goes, type never scales.** The
   wide screen fills the window up to 2,400 px (was 1,180), so at 1,920 px
   nothing sits empty beside it. The cap is border-box, so it is reached at
   about a 2,620 px window (2,400 plus the 220 px sidebar); the spec's 2,684
   is an erratum. A band sets only the gutter, the gap between parts and the
   cap (24 · 16 below a 1,920 px window, 32 · 20 from it, by one media
   query); columns come from the content through container queries on the
   screen (`container: screen`), so a threshold remounts nothing and only
   `useWide()` and that one media query read the window. Type and padding never scale. Prose keeps a
   72-character measure. Progress and Health keep 1,180 px: their charts are
   fixed viewBoxes drawn at full width, so a wider card would scale their
   text; the charts build lifts the cap when it draws each chart at its
   rendered width.

114. **Train A: three regions from a 1,150 px screen, one session list.**
   Train's regions are next, list and open (`TRAIN`); below a 1,150 px
   screen the open session sits under the list as before, and from it in
   its own column (1,150 rather than the mockup's 1,172 at 1,440, so a
   scrollbar can't drop 1,440 to two). The prescriptions are a grid of
   340 px cards that keep card width (`fill`, auto-fill): a member with one
   or two prescriptions never gets a card stretched across the region, and
   an empty track at the right is accepted. The sessions "Show earlier" adds, its status and the pick
   live in one list (`useSessionHistory`, keyed by member; `historyStep`
   drops an action for another member), which both the list and the open
   session read, so an earlier session opens beside the list and J and K
   reach it. An open session at least 560 px wide lists its sets in two
   columns (the query reads its content box: 536 px, 560 less the panel's
   12 px padding each side, so a 1,920 px window qualifies). Without an
   open session the list keeps its 260–300 px track from 1,150 px.

115. **Catalogue A: the wide catalogue goes through `Split`.** `Panes`'
   wide branch no longer repeats Split's two columns: it draws `CATALOGUE`
   (regions list and record) as `.cols.catalogue`, a list track of
   260-320 px and a record that takes the rest, so workouts, exercises and
   gyms get the wider record. Words has no record to open and keeps two
   columns through `words-cols` (passed as Split's `className`), with its
   1.25fr / 320 px tracks now under `.cols.catalogue.words-cols`. The wide
   catalogue no longer carries `catalogue-cols`; its `styles.css` rules are
   left as they are (spec §5) and match nothing until ticket 67's clean-up.
   The phone branch is untouched.

116. **Catalogue A: the record's sections in a grid.** A food's or
   recipe's sections are cards in a 340 px grid (one, two, three across),
   each a `RecordSection` (`Stack` with a `<Text>` heading: the first use of
   a Stack, built for it, on `attrs.ts`' shared phone branch); a food's last
   card is "Price and tags", since its history stays the head's "history"
   link; a recipe's facts line and method stay full width above Lines, Used
   by and Words, and Lines spans the grid's full width (owner's ruling on the
   final review, 9 Oct 2026: in one 409 px track at 1,920 its line names
   wrapped to three lines and its buttons stacked). An open edit spans the grid and lays its fields in the same
   grid. The phone draws the sections as before. Workouts, exercises and
   gyms get only the wider record (115).

117. **Today B: the meals get their own column from a 1,500 px screen;
   each item's kcal and protein from a 520 px tier.** Today's regions are
   rail, meals, tail and house (`TODAY`). Below a 1,500 px screen (about a
   1,768 px window, so 1,440 keeps two columns) they read as before: rail,
   meals and tail on the left, the house on the right; from 1,500 px the
   rail, the meals and the house sit side by side with the rail's macros
   two across. A tier at least 520 px wide shows each item's kcal and
   protein, worded by the view model ("kcal unknown" and "P unknown" for a
   value nobody knows, never 0), drawn only on a wide screen. The macro
   strip's five-row template (each macro a subgrid spanning five rows)
   becomes ten rows in the rail, so the second pair sits on rows six to ten
   and each pair's labels, amounts, tracks and captions stay level. The
   tail can be empty (another member's day with no next session: no
   close-the-day, no footer row), so the footer part is null when it has
   no rows and `.cols.today` falls back to the template without the tail
   in both bands: no empty row, no stray gap.

## A partial total says so (ticket 72, 9 Oct 2026)

118. **A sum that leaves out unknown items reads as partial, with the
   count.** "Blank is never zero" (decisions 14 and the catalogue's
   unknown micronutrients) applied to sums: an item nobody can value (Tofu
   by the `piece`, a unit that is neither a measure nor its reference
   unit) used to drop out of its meal's and its day's totals, which then
   read as complete. The Worker counts the items each sum leaves out
   (`unknown_items`, per nutrient, from the sums' own coverage; Worker
   decision 158); the app never recomputes a sum, it only words the count.
   - **Eaten or so far** is at least what it reads: `1,315+ kcal`,
     `P 75+ g`. **Left** is at most: `at most 406 kcal`; **over by** is at
     least: `over by 120+ kcal`. The `+` and "at most" go only on the
     nutrient whose sum is partial.
   - **The count** follows the numbers once: `· 1 item unknown`, the
     larger of the kcal and protein counts (one unknown item is almost
     always unknown in both). Worded by `atLeast`, `atMostWord` and
     `unknownTail` in `format.ts`, the one wording everywhere:
     - a meal tier's header (`kcalWords`/`proteinWords` with the count):
       "1,315+ kcal, P 75+ g · 1 item unknown"; a meal nobody can value
       still reads "kcal unknown, P unknown", with no count;
     - Today's left line: "Left today: at most 406 kcal and at most 51 g
       protein · 1 item unknown." (so far: "1,194+ kcal … · 2 items
       unknown. No target is set for this day.");
     - the macro strip: amount `≤406` (over: `5+`), caption `1,194+ of
       1,600`; the count is in the left line just above, so the narrow
       columns stay one line;
     - Household's table and Today's household glance: "At most 406 kcal
       and at most 51 g protein left · 1 item unknown";
     - Progress's This week: "1,850+ of 2,000 kcal · 1 item unknown",
       "P 132+ g"; the track's fill stays the known sum's;
     - the Food tab's preview: "Left today after it: at most …".
   - An item known for none of a nutrient reads "kcal unknown"; one known
     for some of its parts (`partial`, a recipe with an unconvertible
     line) reads "450+ kcal", so the meal's count can be found.
   - The count is the Worker's `any` (items with any macro unknown, each
     once, a carbs-only unknown too); an earlier Worker without it falls
     back to the larger of kcal's and protein's. A meal header carries it
     whenever it shows a number.
   - A day with items but none of a nutrient known never reads as nothing
     or zero: This week says "kcal unknown · 2 items unknown" and "P
     unknown" (not "Nothing logged"); the strip says "unknown of 1,600"
     with no track (not "0+ of 1,600").
   - An older Worker without `unknown_items` reads as before (the field
     is optional). Review round 1 (P1-1, P2-1, P2-3, P2-4).
   Tests: `today.test.ts`, `household.test.ts`, `week-health.test.ts`,
   `food.test.ts` ("ticket 72"), on the stress household's Tofu.

119. **The phone is guarded by its pixels, not its bytes** (e2e spec §8; amends decision 112;
   retires the wide-layout plan's byte freeze).
   - **What runs:** the browser suite's `phone` project compares every
     sweep state at 390 × 844, light and dark, with baselines committed in
     `app/web/e2e/phone.spec.ts-snapshots/`: at most 0.5 % of pixels may
     differ, each counted past a threshold of 0.25 (calibrated on identical
     builds on the fixed clock: largest ratio 0.000184, 0.018 %, no pixel
     more than 4 off in a channel). 152 baselines, 36.8 MB (10 Oct 2026).
   - **The gate:** `npm run test:layout` is now `layout` + `phone`, run by
     the merge hooks. The `#root` HTML may change (a hook, a class) where
     the pixels don't.
   - **A baseline changes** only with `--update-snapshots`, in a commit
     that names the state and says why. A missing baseline fails; nothing
     is written into the tree by a run.
   - **`--phone-check --base <ref>`** keeps a pixel comparison with any
     commit, for one-offs. Decision 112's byte-for-byte `#root` comparison
     is gone.
   - **Retired after** three clean runs in a row (wall times 348,778,
     349,740 and 346,713 ms); a run a day after the baselines were recorded is checked
     before the ADOPTED conversion (decision 122).

120. **`npm test` runs the browser suite's fast subset; `npm run deploy`
   needs the full suite** (e2e spec §9, §11; Decided 1).
   - **`npm test`** at the root: every workspace's unit tests, then
     `test:e2e:fast` (J1, J9, J11, J20 at 390 as Asha, the privacy API
     families, the aborted save, a phone shot per tab; budget 2 minutes).
     No commit hook: the deploy gate is where the full suite is required.
   - **The stamp:** `npm run test:e2e` on a tree clean at its start and end,
     with every test passing the first time (a quarantined test's failure or
     flake doesn't fail the run but denies the stamp; at most 3 entries for at
     most 7 days, never privacy), `node_modules` matching
     `package-lock.json` and no ignored source under `app/`, writes
     `<git common dir>/e2e-pass/<HEAD>.json` with the tree hashes of `app/`,
     `package.json` and `package-lock.json`, the installed tree's hash, the
     Playwright and Chromium versions, the counts and the wall time. The
     household's date is fixed (Worker decision 162), so it can't change
     during a run: a seed that reports any other day fails the run.
   - **The gate** is the Worker's `deploy`, reached from the root's
     `deploy` or the Worker's own: arguments; config (wrangler's own reader,
     every `env.*` block, no redirect, no `keep_vars`; none of
     `LOCAL_DEV_IDENTITY`, `LOCAL_IDENTITY_TOKEN`, `LOCAL_FIXED_NOW` in any
     `vars`, binding or field) and the environment (no `WRANGLER_*`,
     `CLOUDFLARE_*` or `CF_*` variable outside the sign-in, account and
     logging allow-list, from the shell or `app/worker/.env*`); then it
     builds the web app itself, so a stale `dist` can't ship; bundle and
     secrets, with the Worker's name passed by `--name` to every wrangler
     call; then the stamp, which also refuses a drifted `node_modules` or
     ignored source. Just before `wrangler deploy` (the installed binary,
     never `npx`) the tree, config and environment are read again, and the
     uploaded bundle is checked afterwards. `E2E_GATE_OVERRIDE="<reason>"`
     stands in for the stamp only; it is printed and appended to
     `overrides.jsonl` with whether the tree was dirty and the trees that
     shipped. A run that stamps records how much of the log it read, so the
     next run lists every override past that point, including one made
     while it ran. The gate closes the layout gate's bypasses (a
     fast-forward merge, a clone without the hooks) at the deploy.

121. **A committed browser suite** (e2e spec; ticket 67 part 1).
   - **What runs:** `@playwright/test` 1.64.0 with its own Chromium,
     against the real Worker on a local D1 seeded fresh each run with the
     invented stress household and its Private shape (a canary in every
     owner-only field). Each worker slot has its own copy and its own
     Worker on an OS port, members signed in by the dev-only entry's header
     with a per-run token (Worker decision 161).
   - **Projects:** `journeys` (J1–J23, J26, J27, each member at 390 and
     1,440), `privacy` (six pairs × six families × two widths, every tool
     classified; never quarantined), `failure` (six forms × eight cases),
     `forms` (sixteen forms × part 2's awkward inputs), `layout`, `phone`,
     `support`; `fast` is the tagged subset `npm test` runs.
   - **Rules:** probes assert what each step changes and what it doesn't,
     with numbers from the write's own answer; no sleeps; no test-only
     attributes; every output under the run directory.
   - **Measured:** on the work Mac at 4 workers (10 Oct 2026): fast 53 s
     (budget 2 min); layout + phone 343 s (budget 10 min); the full suite
     1,129 s, 18.8 minutes (budget 30 min): 2,087 passed, 0 failed, 0 flaky,
     0 quarantined, 20 skipped (the disputed form rows, `fixme` pending
     ticket 80, counted as skipped in the stamp, never as passed or
     failed); worker-minutes journeys 24.2, forms 17.2, layout 18.9,
     privacy 7.9, phone 2.6, failure 2.1, support 0.1. Each stamp records
     them as `worker_minutes_<project>`. No lever was applied: the full
     suite is inside its budget, so journeys (the largest term) still run
     every member at both widths.

122. **`ADOPTED` is converted; amends decision 111** (e2e spec §8; the
   wide-layout plan's follow-up).
   - **The amendment:** decision 111 said a primitive adds its `l-*`
     classes only on a wide screen and the phone's markup is never
     touched. Four classes now render at every width: `.rx` elements carry
     `l-stack` (its 6 px gap as `--g`), `.acts` rows `l-cluster`, the Train
     cue's summary `t-clamp`, and the pot bar's label goes through `<Text
     mode="truncate">`. The phone is held by its pixels (decision 119),
     which did not change.
   - **Cluster is a raw class,** `l-cluster` in `layout.css` (flex, wrap,
     8 px), not a component: the rows that carry it are existing JSX. A new
     screen's first wrapping row builds the `Cluster` component.
   - **`.l-cluster` sets its own `--g`** (8 px), as `.l-grid` does, so an
     `.acts` row inside an `.rx` card keeps its 8 px rather than inheriting
     the card's 6 px. Every other `--g` reader sets it on the same element
     (`.rx`, or a primitive's `g-*` class). No `@property`, so it holds on
     any browser.
   - **Deleted:** the four selectors' structure rules in `styles.css`, the
     clamp's four companions, the unmatched `.catalogue-cols` rules, and
     `ADOPTED` with its exemption in the structure lint, whose count fell
     to 125.

123. **Prep is a strip, and a due prep card points at it.** Today renders
    `day_prep`'s pending tasks above the needs strip, through `<Text>` (no
    raw text nodes), under `id="prep"`. `needs_you`'s `prep` card is a link
    to that anchor, so the Worker's card union and the web's stay in step;
    a card kind without a `strip.ts` case would render `undefined` and
    crash the strip. Test: the text/structure lints, `load.test.ts`, and
    the privacy tool table.
