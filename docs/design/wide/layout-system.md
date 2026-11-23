# Layout system (proposal, ticket 66 step 2)

Status: proposal for review with the mockups in this folder (`0-index.html`). Nothing here is built yet. The mockups' own CSS (`.l-*`, `.t-*` in each file) is a working sketch of it.

## What exists and what goes wrong

- `app/web/src/layout.ts` declares each screen's parts once (`PartSpec`, `arrange`) and `components/Split.tsx` renders them as the phone stack or `.cols` with two `.col`s. Keep this: it is what keeps the phone and wide layouts from drifting.
- The structure below a part is ad-hoc CSS in `app/web/src/styles.css`: `.cols` is a fixed `minmax(0,1.25fr) minmax(320px,1fr)`, `.catalogue-cols` a fixed list and record, and `.app.wide > .screen` stops at `max-width: 1180px`. So at 1,920 px about 500 px is empty, and every screen is two columns whatever its content.
- Overflow is guarded rule by rule (`min-width: 0` on `.col`, `.cat-row > :first-child`, `.rx header span`; `summary.clamp`), pinned by `app/web/test/overflow.test.ts`, and found after the fact by `app/web/scripts/sweep-layout.ts`, which is run by hand.

## Primitives (`app/web/src/components/layout/`)

Each is a small component with one CSS rule set. Each gives its children `min-width: 0` and takes its gaps from the space steps (4, 8, 12, 16, 20, 24 px), never a literal. Screens compose them; a screen's CSS keeps only the look (colour, radius, type), never `display: grid`, `grid-template-columns` or `flex-wrap`.

| Primitive | Rule | Replaces |
|---|---|---|
| `Stack gap` | grid, `grid-template-columns: minmax(0,1fr)` | `.col`, `.l-stack`, the `display:grid; gap` in `.rx`, `.tier`, `.record`, `.pot` |
| `Cluster gap` | flex, wrap, baseline | `.acts`, `.legend`, `.who`, `.memberbar` |
| `Split` (label · value) | `minmax(0,1fr) auto` | `.item`, `.needs`, `.foot > div`, `.cat-row` |
| `Grid min max? fill?` | `repeat(auto-fit, minmax(min(100%, max(min, (100% − (max−1)·gap)/max)), 1fr))` | `.macros` (with `max=4`), `.micros`, and the new card grids |
| `Switcher at` | flex-wrap with `flex-basis: calc((at − 100%) · 999)`: side by side at or above `at`, stacked below | `.cols` on Today B (rail beside meals) |
| `Columns areas` | a named-area grid for a screen's few fixed regions, with each area's `minmax` | `.cols`, `.catalogue-cols` |

`Split.tsx` stays the one place that turns parts into regions. It renders `Columns` with the screen's region list instead of `.cols` and two `.col`s. `PartSpec.side` widens from `"full" | "left" | "right"` to a region name (for example Train's `"next" | "list" | "open"`). The phone path is unchanged (`arrange(…, false)` still returns the declared order).

## Text (`components/Text.tsx`)

Every text slot that shows member-, agent- or catalogue-written text renders through `<Text>` and declares one of these behaviours:

- `wrap`: the default. Sets `overflow-wrap: anywhere` (names, notes, food names).
- `clamp={n}`: `-webkit-line-clamp: n`, with an expander (the `summary.clamp` pattern in `TrainScreen.tsx` generalised). It is only allowed where opening is possible.
- `truncate`: one line with an ellipsis, and the full text must be reachable through a `title` plus an accessible name, or a link to the record. Pot segments (`.seg > span` in `PotCard.tsx`) are the model.
- `nowrap`: for short, app-written labels only (a dose, a unit, "12 g"). Keeps a number with its unit, as the weekly table does in `3-progress.html`.

A lint test replaces the string checks in `overflow.test.ts`. It fails on a JSX text node holding a variable outside `<Text>` in `screens/` and `components/`, and on `white-space: nowrap` without `text-overflow` in a non-label rule.

## Width bands and density

Column counts come from content. The bands only set the gutter, the gap and the safety cap. No component reads the window width; only `useWide()` (1,024 px) still does, to pick the shell.

| Band (window) | Screen width (minus the 220 px sidebar) | Gutter · gap | Typical result |
|---|---|---|---|
| phone < 1,024 | 390-ish | 16 · 16 | unchanged |
| desk 1,024–1,439 | 756–1,171 | 24 · 16 | today's two regions; card grids 1–2 across |
| wide 1,440–1,919 | 1,172–1,651 | 24 · 16 | three regions where a screen has them (Train A); grids 2 across |
| very wide ≥ 1,920 | 1,652–2,340 | 32 · 20 | grids 3–4 across; switchers open (Today B rail) |

- **No `max-width: 1180px`.** The screen fills the window up to a 2,400 px safety cap. Prose keeps its own measure (`max-inline-size: 72ch` on a `Text` of more than a paragraph).
- **Type and padding never scale.** A wider window gets more columns, not bigger text or looser cards.
- **Container queries for card density, not media queries.** A card switches density by its own width (`container-type: inline-size`):
  - a meal tier ≥ 520 px shows each item's kcal and protein columns;
  - an open session ≥ 560 px lists its sets in two columns;
  - the weekly table's card < 760 px drops its two cost columns.
- **Minimum card widths** (the `Grid min`): prescription 340 px; meal tier 380 px; chart 480 px (at most 4); catalogue record section 340 px (at most 3); needs-you card 300 px.
- **Above the fold at 1,920 × 1,080:** each screen's primary object (next session, the day's meals, the headline chart, the open record) starts in the top 400 px.

## Stress fixtures and the gate

- **One synthetic household, two densities.** `scripts/seed-sample.ts --long` already writes long names, cues and notes. Extend it to the shapes the mockups use, and keep it invented (never copy from the real D1 or backups):
  - many: 40+ foods, 20+ sessions, 11 items in a meal, 6 leftovers;
  - empty: a member with no target, no sessions, an unpriced week, a week with no complete day;
  - short: one-word names.

  `npm run dev` seeds it by default, so every manual check sees it.
- **Fixtures for unit tests:** the same shapes in `app/web/test/fixtures.ts` (`stressHousehold()`), so view-model tests cover them.
- **The sweep gates the merge:**
  - `scripts/sweep-layout.ts` already detects `page-scroll`, `spill`, `clipped`, `overflow`, `offscreen` and `covered`. Its widths become 390, 768, 1,024, 1,280, 1,440, 1,920 and 2,560, in light and dark.
  - It runs as `npm run test:layout -w @myfitnessguide/web` against the `--long` fixture, and in CI (or a pre-push hook while the repo has none) after `npm test`.
  - Exit 1 blocks the merge.
  - Its `findings.json` and outlined screenshots are the review artefact.
- **Specs and critiques:**
  - DESIGN.md gets this file's bands, minimum card widths and density rules, and "use of space at 1,920+" joins the critique checklist (`docs/design/critiques/`).
  - A new screen's spec shows it at 390, 1,280 and 1,920 with real-length content before build, as these mockups do.

## Order of work

1. Primitives and `Text`, with the lint test, and no visual change (today's two regions expressed as `Columns`).
2. Lift the 1,180 px cap and set the bands.
3. Screens one at a time, in the order Train, Catalogue, Progress (with the charts build) and Today, each behind the sweep.
