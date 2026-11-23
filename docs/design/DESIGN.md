# Design system: Household pot

Chosen by Hritvik on 6 Oct 2026, from variant B of the Today prototype (branch `prototype/today-directions`, commit `db3de70`). Every screen follows this file; the product rules are in [`PRODUCT.md`](PRODUCT.md).

## The world in one line

A stack of steel tiffin tiers on a kitchen counter. Steel greys hold the structure, haldi yellow marks *you*, and the shared pot is the one raised object on the screen.

## Colour

Restrained: steel neutrals, plus one accent that means "you", plus state colours that do real jobs. Every colour is a token with light and dark values. Never write a literal colour in a component.

| Token | Light | Dark | Job |
|---|---|---|---|
| `--bg` | `#eef1f3` | `#15191c` | page ground |
| `--card` | `#ffffff` | `#1c2328` | the raised object (pot card, sheets) |
| `--steel` | `#dfe5ea` | `#232b31` | tiers, inset panels, the ask box |
| `--steel-2` | `#c9d2da` | `#34404a` | tracks, other members' shares, borders |
| `--ink` | `#1f2a30` | `#e8edf0` | text, primary buttons, bar fills |
| `--dim` | `#56646e` | `#9aa8b2` | secondary text, provenance |
| `--haldi` | `#e3a008` | `#f0b429` | **you**: your share and your selection |
| `--haldi-ink` | `#5c3d00` | `#f7d47c` | **estimated** values (text on any ground) |
| `--leaf` | `#2f6b3f` | `#7cc790` | confirmed or complete state |
| `--chilli` | `#b4321f` | `#f07a63` | errors and failed writes **only** |

These changed from the prototype. Estimated values used chilli red; they now use `--haldi-ink`, because red is reserved for errors and over-target is never red. Being over a target is shown in `--ink` as "over by N".

## Type

- **Mukta** (Ek Type, Latin and Devanagari) for everything, in weights 400, 500 and 700. Fallback: `"Noto Sans", system-ui, sans-serif`.
- Numerals are tabular everywhere: `font-variant-numeric: tabular-nums`.
- Scale (rem): title 1.15 / 700; summary line 1.1; section head 1.0 / 700; body and list 0.9; meta 0.8–0.85.
- No uppercase labels, no eyebrows above headings, no monospace.

## Layout and spacing

- Single column, max 430 px, 16 px side gutter. Space steps: 4, 8, 12, 14, 16 px.
- **Today, in order:** title row (date + member pills) → "needs you" strip (own today only, at most 3 cards, "+N more") → "left" line → macro strip → **pot card(s)** → meal tiers → a quiet footer list (next session and its loads).
- Use gap-based layout throughout, with no stacked margins.
- **Space tokens** (added with the wide layout; its spec is retired to git history, 21 Oct 2026): `--gap-4`, `--gap-8`, `--gap-12`, `--gap-16`, `--gap-20`, `--gap-24` and `--gap-32` on `:root`, for the layout rules in `app/web/src/components/layout/layout.css`. Older rules keep their literal steps.
- **New structure goes through the primitives** in `app/web/src/components/layout/`: `Grid` (`wide`, `min` 300 · 340 · 380 · 480, `max` 2 to 4, `gap`, `fill`, `as`) and `Stack` (`wide`, `gap`, `as`: a column of parts, built for Catalogue A's section cards), each adding its `l-*` classes only on a wide screen, so the phone's markup never changes. A screen's own CSS sets only the look (colour, radius, type), never `display: grid|flex`, `grid-template-columns` or `flex-wrap`. Four classes also render on the phone: `l-stack` (a prescription or session card, `.rx`), `l-cluster` (a row of actions, `.acts`), `t-clamp` (the Train cue) and `t-trunc` (a pot bar's label), converted from the selectors the wide layout adopted (web decision 122). Two lints hold this and the next rule as ratchets (`app/web/test/layout-system.test.ts`; counts in `test/layout-baseline.json`, which `app/web/scripts/layout-baseline.ts` only lowers).
- **New written text goes through `<Text>`**, which says what the text does when it's long: `wrap` (the default), `clamp` (2 or 3 lines, only as a `<summary>`, so it always opens), `truncate` (one line with an ellipsis; the full text stays reachable through a `title`, a labelled ancestor or a link to the record) or `nowrap` (short app-written labels only, like "12 g"). Existing slots stay as they are.
- **Sketches, built by the first screen that needs one:** `Cluster` (`gap`, `align`, `justify`: a wrapping row of buttons or pills; today the raw class `l-cluster`, which existing rows of actions carry at every width, and a component when a new screen first needs one), `Pair` (`gap`: a label and its value, `minmax(0, 1fr) auto`) and `Switcher` (`gap`, `at`: side by side at or above `at`, stacked below).
- **Long text** (names, cues, notes, Tell Claude texts) wraps and never widens its column; a word longer than its line breaks. A collapsed summary of written text previews two lines with an ellipsis and shows everything when opened ([`app/web/DECISIONS.md`](../../app/web/DECISIONS.md) 81).

## Wide screens (1024 px and wider)

Added 7 Oct 2026 with the desktop layout (its spec is retired to git history, 21 Oct 2026; the build's decisions are in `app/web/DECISIONS.md`). Below 1024 px nothing here applies, and the phone layout above is unchanged.

- **One app, two layouts.** `useWide()` reads `(min-width: 1024px)` once before the first paint and follows it. The frame keeps fixed slots (sidebar, top bar, screen, tab bar), so a screen and the "+" sheet never remount when the window crosses the line, and no write or held "Try again" is lost.
- **The sidebar:** 220 px, `--steel`, sticky, full viewport height, scrolling inside itself if short. From the top: "Household" with the More menu, the four sections, a "Catalogue" head (0.8 rem, `--dim`) and its five links (Foods & recipes, Workouts, Exercises, Gyms & equipment, Words I've learned), then the member pills at the foot and one line of key hints. A link is 0.9 rem with a radius-8 hover in `--steel-2`; the current one is filled `--ink` with `--bg` text, like a selected pill. A section's or pane's link returns to what was last open in it. There is no tab bar and no top bar.
- **The More menu** keeps "What I've learned" and "Send feedback". Its "Catalogue" entry is phone-only (the sidebar has the panes); on the phone it reopens the last catalogue place.
- **The screen and its bands** (the wide-layout spec §2, retired to git history 21 Oct 2026). The screen fills the window up to a 2,400 px safety cap (reached at about a 2,620 px window: the box is border-box, so its 2,400 px include the gutters, plus the 220 px sidebar; the spec's 2,684 is an erratum), 20 px above and 104 px below (room for the floating "+", so it never covers the last row). A band sets only the side gutter, the gap between parts and the cap; columns come from the content. Desk (a 1,024–1,439 px window) and wide (1,440–1,919): 24 px gutter, 16 px between parts. Very wide (1,920 and up): 32 px and 20 px. Regions sit 24 px apart at every width. **Type and padding never scale:** a wider window gets more columns, never bigger text or looser cards. Prose keeps a 72-character measure. Progress and Health stay at 1,180 px until their charts are drawn at their rendered width (the charts build). Only `useWide()` and the very-wide band's one media query (`min-width: 1920px`, which sets the gutter and the gap) read the window; every template and density is a container query on the screen, so crossing a threshold remounts nothing. The date bar and anything urgent (the needs-you strip) run the full width; below them each screen's regions. A screen without its own layout has two columns, `minmax(0, 1.25fr)` and `minmax(320px, 1fr)`, each a stack of parts. Your own view is on the left; the thing you'd check next is on the right.
- **Regions per screen** (each screen's layout in `app/web/src/layout.ts`; its tracks, areas and thresholds in `app/web/src/components/layout/layout.css` under `.cols.<name>`; a region with nothing in it falls back to the template without it):
  - **Train:** next (the next session), list (the sessions) and open (the session open). Below a 1,150 px screen, next on the left and the list over the open session on the right (`minmax(0, 1.25fr)`, `minmax(320px, 1fr)`); from 1,150 px three columns, `minmax(0, 1.3fr)`, `minmax(260px, 300px)` and `minmax(380px, 1fr)`. The prescriptions are a grid of cards at least 340 px wide that keep card width (a lone card never stretches; an empty track may sit at the right): one, two, then three across at 1,440, 1,920 and 2,560 px windows. An open session lists its sets in two columns from a 560 px panel (a 1,920 px window). Without an open session the list keeps its designed track. J and K move through the list, and Enter opens a session, an older one too, in the open region.
  - **Today:** rail (the left line and the macros), meals, tail (close the day, the footer) and house (the pots, the household). Below a 1,500 px screen the rail, meals and tail stack on the left (`minmax(0, 1.25fr)`) beside the house (`minmax(360px, 1fr)`); from 1,500 px three columns, `minmax(300px, 340px)`, `minmax(0, 1fr)` and `minmax(360px, 0.8fr)`, with the rail's macros two across. A meal tier at least 520 px wide shows each item's kcal and protein in their own columns ("kcal unknown", never 0).
  - **Progress:** head, charts (a grid of charts at least 480 px wide, at most four across) and table (full width beneath): built with the charts.
  - **Household, Health before the charts build, and the "+" sheet** keep the two columns.
- **The catalogue** has no full-width part: the list (`minmax(260px, 320px)`) then the record (`minmax(0, 1fr)`); Words keeps two columns (`minmax(0, 1.25fr)`, `minmax(320px, 1fr)`). A food's or recipe's head, facts line and actions run the record's width; on a wide screen its sections are cards in a grid (at least 340 px, at most three across: one, two, then three at 1,024, 1,440 and 1,920 px windows): a food's Per 100 g, Micronutrients, Measures and yields, Used by, Words, and Price and tags; a recipe's Lines (across the grid's full width, so long line names and their buttons keep their room), Used by and Words. Each is a `--steel` card with a 0.9 rem head, 10 px 12 px inside, except two that keep the look they have on the phone: Used by keeps its 3 px `--dim` left border and 8 px 12 px padding, and Words keeps its 0.95 rem head. Used by stays above the buttons. An open edit spans the grid, its fields in the same grid. With nothing open: "Pick one from the list." On the phone the same pane shows one at a time, with the panes as pills and a back link from a record, and a record's sections in the order they always had.
- **Parts, not new screens.** A screen declares its parts once, in the phone's order, each on a side: `full`, or a region of the screen's layout (`left` or `right` for a screen without its own layout; otherwise one of its named regions, such as Train's `next`, `list` and `open`); the phone stacks them in that order and the wide layout only places them. A part may be wide-only (Today's household column, Progress's range switch and readings table) or phone-only, never a different version of a phone part. Wide-only wrappers (regions, grids, section cards, a tier's numbers, Train's open session) render only on the wide layout, so the phone's markup never changes. A part may move on the wide layout only, to just after another (Progress's log entry).
- **The "+" sheet** is a 360 px panel from the right edge, full viewport height, square-cornered, with no scrim, so the page beside it stays usable; it is the same sheet as the phone's, with the same tabs (Food, Workout, Set, Reading, and Tell Claude last). Its shadow is the card's, cast left. While it is open the floating "+" leaves the layout and the tab order.
- **Tables** are allowed on wide screens for lists people compare (the readings): hairline `--steel-2` rules, heads in `--dim` at 0.8 rem, left-aligned, tabular numbers, no zebra. A row people open (a session, a catalogue record) is a plain row, hover `--steel`, and the open one lifted to `--card` with the near shadow. Health's blood draws are such rows on both layouts, not a table: each draw (date, lab, result count, how many out of range) opens in place to all of its results, so an earlier draw's values can be read on a phone and on desktop alike.
- **Keyboard** (both layouts): N opens the sheet on Food and Shift+N on Tell Claude; / searches the screen (or the sheet's Food search while it is open); J and K move between rows and Enter opens one; E edits the open record; G then T, R, P, H or C goes to a section; ? lists them. Esc closes the list, then the sheet, then an open edit, then a menu, and does nothing while a write is in flight or a send is held for "Try again". Keys are ignored while typing and with Ctrl, Cmd or Alt, and never while an input method is composing. Visible hints (`<kbd>`, 0.75 rem, `--dim`, a 1 px `--steel-2` border) appear in the sidebar's one line and in the "?" list only. Focus rings stay 2 px in the current text colour.
- **No new colours.** Every wide rule uses the colour tokens above; the space tokens (`--gap-*`) are the only tokens the wide layout added.

## Use of space (wide screens)

- **Minimum card widths** (`CardMin`): a needs-you card 300 px; a prescription and a record section 340 px; a meal tier 380 px; a chart 480 px. A grid adds a column only when another card of that width fits.
- **Density follows the card's own width** (container queries, never the window): a meal tier at least 520 px wide shows each item's kcal and protein; an open session at least 560 px wide lists its sets in two columns. (The charts build adds Progress's: its weekly table drops its two cost columns below 760 px.)
- **The fold:** at 1,920 × 1,080 each screen's primary object (the next session, the day's meals, the open record; the headline chart once the charts build lands Progress A) starts in the top 400 px. The layout sweep checks it from 1,920 px.
- **Critiques** check **use of space at 1,920+**: no empty band, no lone card stretched past its reading width, no region with nothing in it. A new screen's spec shows it at 390, 1,280 and 1,920 px with real-length content before it is built.

## Components

- **Member pills:** round pills. The selected member is filled `--ink`. Members only see their own private data; household data is shared.
- **"Left" line:** one sentence, *"Left today: **406 kcal** and **51 g protein**. Estimate ±180 kcal."*
- **Macro strip:** four equal columns (Energy, Protein, Carbs, Fat). Each has the label, the amount left (bold), a 6 px track filled in `--ink`, and "N of target" beneath. No rings. A floor or remainder target shows in the caption, not as a colour.
- **Pot card** (the signature move, and the only element with a shadow):
  - a header with the dish, "one pot", and who cooked it when;
  - a **split bar**, 38 px tall, with one segment per present member: yours in `--haldi`, others in `--steel-2`, and the unaccounted remainder **hatched**;
  - absent members named in the legend ("Kabir wasn't there, so no portion");
  - an inline **ask** panel for a draft about you: **Yes, confirm** · Change my share · Mark the rest leftover.
  - Shadow: `0 1px 2px` plus `0 6px 18px`, ink at 6–8%. Radius 14.
- **Meal tier:** a `--steel` panel, radius 12 (the first tier 16 at the top, like a tiffin lid). The header has the slot, plus time, kcal and protein. Items are listed with provenance on the right ("weighed", "label", "counted", or "estimated ±60" in `--haldi-ink`).
- **Empty tier:** a dashed `--steel-2` outline with "nothing yet". A skipped meal says "skipped", and a value that was never captured says "not recorded". These three must look different.
- **Footer list:** label on the left and state on the right, separated by hairline rules. Nothing raised.
- **Buttons:** the primary is filled `--ink` with `--bg` text, radius 8. The secondary is an outline. Every button names its action.

## States and motion

- A draft always carries "Logged by <name>" and stays visible until it's confirmed, changed, or auto-confirmed after 48 h.
- Show write status (saving, saved, failed) next to the thing written. Failed uses `--chilli`, with what to do next.
- Motion: the split bar and the tracks animate their width when a value changes (≈400 ms, ease-out), and only when `prefers-reduced-motion` allows it. Nothing else animates.
- Focus rings are always visible: 2 px in the current text colour.
