# @myfitnessguide/web

The household's PWA, in four tabs. **Today** is the day: what's left, what needs you, shared pots, and meals with their provenance and drafts to confirm. **Train** is the next session's prescription with its loads and plates, the questions only the gym can answer, and the session history. **Progress** is your own body and health: the headline goal, trend charts, the week, and blood results with follow-ups (private to its owner). **Household** is everyone at a glance: each member's day, the shared meals, the leftovers to eat or discard, and what is waiting on others. Design: [`docs/design/DESIGN.md`](../../docs/design/DESIGN.md). Decisions: [`DECISIONS.md`](DECISIONS.md).

The app reads and writes only through the Worker's `/tools/<name>` API, the same one the agent uses. It never calculates nutrition; every number comes from the API.

## Run it locally

Everything below is local. Nothing here uses `--remote` or deploys.

### 1. Your identity for `wrangler dev`

Create `app/worker/.dev.vars` (gitignored, never commit it):

```sh
LOCAL_DEV_IDENTITY="member:<your Access email>"
```

The Worker honours it only for requests to localhost (see the comment in `app/worker/wrangler.jsonc` and `app/worker/ACCESS.md`). In production there is no such variable: Cloudflare Access signs you in and the page carries no credentials.

### 2. Seed the local D1 from the rehearsal (optional, private)

The rehearsal's final-load SQL lives outside the repo, in `~/.local/share/myfitnessguide/snapshots/<timestamp>/final-load/`. It is household data: load it only into your local D1, and never commit it or screenshots of it.

From `app/worker`:

```sh
npx wrangler d1 migrations apply gym-tracker --local
npx wrangler d1 execute gym-tracker --local --file ~/.local/share/myfitnessguide/snapshots/20261005T190721Z/final-load/final-load-001.sql
npx wrangler d1 execute gym-tracker --local --file ~/.local/share/myfitnessguide/snapshots/20261005T190721Z/final-load/final-load-002.sql
npx wrangler d1 execute gym-tracker --local --file ~/.local/share/myfitnessguide/snapshots/20261005T190721Z/final-load/final-load-003.sql
npx wrangler d1 execute gym-tracker --local --file ~/.local/share/myfitnessguide/snapshots/20261005T190721Z/final-load/final-load-004.sql
npx wrangler d1 execute gym-tracker --local --command "SELECT (SELECT count(*) FROM intake_item) AS items, (SELECT count(*) FROM member) AS members"
```

The files apply in name order; each is atomic. To start again, delete `app/worker/.wrangler/state` and repeat.

**Schema skew:** the 20261005T190721Z final-load was generated on `build/rehearsal-2`, which adds migrations 0021-0023 (split e1RM, mixed-unit inventories, set compositions). Until that branch merges, apply those three to your local D1 before the final-load files, without committing them:

```sh
git show build/rehearsal-2:app/worker/migrations/0021_split_e1rm.sql > /tmp/m21.sql   # likewise 0022, 0023
npx wrangler d1 execute gym-tracker --local --file /tmp/m21.sql
```

### 3. Start it

```sh
npm run dev -w @myfitnessguide/web
```

This reuses an API already answering on `:8787`, or starts `wrangler dev --local` there (from `app/worker`), then starts Vite on <http://localhost:5173>, which proxies `/tools` to the Worker. `npm run dev:web -w @myfitnessguide/web` runs Vite alone.

Useful URLs: `/?date=2026-10-04` shows another day; `/?member=Asha` shows another member's day (household data only; their flags and staleness are never read).

### Sample household (for screenshots that may be committed)

```sh
npm run seed:sample -w @myfitnessguide/web      # builds app/worker/.wrangler/sample, invented data only
npm run dev -w @myfitnessguide/web -- --sample  # serves it as Asha
npm run dev -w @myfitnessguide/web -- --sample-long  # the stress household (seed it with -- --long)
```

The sample lives in its own local D1 directory, apart from your real local data. It has a shared pot with a draft about Asha logged by Kabir, an absent member, an unaccounted remainder, a skipped meal, an empty meal, a flag and an overdue cadence.

The stress household (`-- --long`) is the same household with long text everywhere and the wide-layout spec's stress shapes: 40 foods (one used by six recipes), 25 sessions (23 over the last twelve weeks, every other one with a long note, plus the base sample's 2), an 11-item dinner with one item of unknown kcal and protein, six leftovers, eight Tell Claude texts, Kabir with no target, one-word names and a two-letter gym. The layout sweep checks against it; `stressHousehold()` in `test/fixtures.ts` gives the same shapes to view-model tests.

The seed runs one local Worker on the dev-only entry (`app/worker/src/dev-entry.ts`) and signs each member in by the `X-Local-Identity` header with a token new to each run, on a port the OS picks. `--persist <dir>` writes the D1 elsewhere (the browser suite seeds into its run directory) and `--port <n>` fixes the port. The seed deletes that directory first, so it takes only one under `app/worker/.wrangler` (never `.wrangler/state`, your real local data) or the temp directory, unless you add `--persist-anywhere`. A Worker already on the port stops the seed before it writes anything.

## In production

The Worker serves the built app (`app/web/dist`) as static assets on the API's own hostname, behind the same Access application, so there is one sign-in and the page holds no credentials. Deploy both together from the repo root with `npm run deploy` (see `app/worker/ACCESS.md`, Routine operations). `wrangler dev` needs `app/web/dist` to exist; `npm run dev` creates it empty when it is missing, since Vite serves the app in development.

## Tests

```sh
npm test -w @myfitnessguide/web       # data mapping and state logic (vitest)
npm run typecheck -w @myfitnessguide/web
npm run build -w @myfitnessguide/web
```

Layout is checked by screenshot, not unit tests (see `docs/design/critiques/today/`). The layout sweep checks long text on every route and state:

```sh
npm run test:layout -w @myfitnessguide/web   # the gate: reseeds --long, builds, sweeps; exit 1 on any finding
```

The sweep is the browser suite's `layout` project: a fresh stress household, every state in `scripts/states.ts` at 390, 768, 1,024, 1,280, 1,440, 1,800, 1,920 and 2,560 px, light and dark. It flags sideways page scroll, text or controls outside their card or column, clipped text with no way to read it, off-screen sheets and controls under the floating "+", and, from 1,920 px, a primary object below the top 400 px (`fold`); each flag fails its test with the outlined shot attached, and `findings.json` (with the run's wall time, budget 10 minutes, and loads over 2 s) is in the run directory and in the run's summary, `$TMPDIR/myfitnessguide-e2e-last/layout.json` for the gate. Narrow it with `node app/web/scripts/sweep-layout.ts --widths 390,1440 --themes light --only <state>`.

The gate blocks a merge on any flag (the root README says how to install it).

The phone is guarded by its pixels: the `phone` project compares every state at 390 × 844, light and dark, with the baselines committed in `app/web/e2e/phone.spec.ts-snapshots/` (at most 0.5 % of pixels may differ). `npm run test:layout` runs the sweep and the phone together; the merge gate runs it. A baseline changes only on purpose:

```sh
node app/web/e2e/run.ts --projects phone -- --update-snapshots --grep "<state>"   # then commit, naming the state and why
```

To compare this branch's phone with any commit instead (a one-off), `node app/web/scripts/sweep-layout.ts --phone-check --base <commit> [--allow <state>]`.

## The browser suite

`app/web/e2e/` runs the real Worker on a local D1, seeded fresh each run with the stress household and its Private shape, for Asha, Kabir and Noor at 390 and 1,440 px (e2e spec, `docs/superpowers/specs/2026-10-08-e2e-suite-design.md`). Each Playwright worker gets its own copy of the D1 and its own Worker on a port the OS picks, signed in by the dev-only entry's header with a token new to each run. Everything a run writes goes under `$TMPDIR/gym-e2e-*`, deleted when the run is green and kept, with traces, when it isn't (below).

```sh
node app/web/e2e/run.ts --projects support      # one project; -- <playwright args> passes through
```

```sh
npm run test:e2e:fast -w @myfitnessguide/web   # @fast: the tests tagged @fast in their own projects (npm test runs it)
npm run test:e2e -w @myfitnessguide/web        # everything; on a clean tree with nothing flaky it writes the deploy stamp
```

`retries: 1` shows a flake as `flaky`; a flaky run passes but earns no stamp. A test that flakes twice in a week goes into `e2e/quarantine.ts` with its date and reason: it still runs and reports but doesn't block the run, for at most 7 days by the wall calendar, at most 3 entries, and never a privacy test; its failure or flake still denies the stamp. A seed or global setup that fails is a failure (exit 1), and the run prints `setup.log`'s path. The household's date is fixed, so no run is void: a seed that reports any date but the fixed one fails the run. The stamp goes into the git common directory (`$(git rev-parse --git-common-dir)/e2e-pass/<commit>.json`, shared by every worktree), keyed by the tree hashes of `app/`, `package.json` and `package-lock.json`. A full run earns it only when every project ran (a project whose tests were all skipped didn't), nothing narrowed it (no Playwright arguments after `--`, and no `E2E_` variable such as `E2E_WIDTHS` or `E2E_THEMES` set; `E2E_WORKERS` is fine), `node_modules` matches `package-lock.json` (the stamp records a hash of `node_modules/.package-lock.json`), and no source-like file under `app/` is hidden by an ignore (a global one included) outside `node_modules`, `dist` and `.wrangler`. `app/worker/.dev.vars` is out of scope: `wrangler deploy` never reads it. `run.ts` refuses unknown flags and a preset `E2E_RUN`, and reads only the report its own run wrote; `forbidOnly` keeps a stray `test.only` from focusing a run.

Measured on the work Mac at 4 workers (10 Oct 2026): fast 53 s, layout + phone 343 s, the full suite 18.8 minutes (worker-minutes: journeys 24.2, layout 18.9, forms 17.2, privacy 7.9, phone 2.6, failure 2.1, support 0.1).

Every run writes `summary.json` (the verdict, counts, wall and setup times, problems, and the layout project's `findings.json` with its flags and slow loads over 2 s) and copies it to `$TMPDIR/myfitnessguide-e2e-last/<mode>.json` (`fast`, `full`, `layout`, or `projects-<a+b>`). A green run (passed, nothing flaky, no quarantined test failing) deletes its run directory; a failed, flaky or interrupted run keeps it, with traces, slot logs and `findings.json`, and prints its path.

The test household lives on a fixed clock: Wednesday 7 October 2026, 10:00 in Asia/Kolkata (`scripts/test-clock.ts`; worker decision 162). The suite's seed (`--fixed-clock`) and its Workers read it as `LOCAL_FIXED_NOW`, and every browser context fixes its `Date` to it, so no shot shows a date or time that moves between runs. A hand-seeded sample (`npm run seed:sample`) runs on today.

The `phone` project (part of `npm run test:layout`) shoots every state at 390 × 844, light and dark, full page, and compares it with its committed baseline in `e2e/phone.spec.ts-snapshots/` (at most 0.5 % of pixels past a 0.25 threshold). The 152 baselines take about 35 MB, since the long Today and Train screens run to 12,847 px; full-page shots were kept on purpose (9 Oct 2026). A baseline changes only through `node app/web/e2e/run.ts --projects phone -- --update-snapshots`, in a commit that names the state and says why. `--phone-check --base <commit>` (above) runs the `phone-base` project.

## Not yet

- **No service worker.** The manifest makes it installable; offline shows a read-only banner over what was loaded, and writes are off until the phone is back online.
