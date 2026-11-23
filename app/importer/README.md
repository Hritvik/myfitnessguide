# Importer

The one-time move from Google Sheets to D1 (ticket *Snapshot and importer*,
designed in *Import design* and *Parity gate for deleting formulas*).

```
snapshot JSON  ->  load into a local SQLite through the Worker  ->  rulings.yaml + parity.md/json + final-load SQL
```

Everything it reads and writes besides this code is household data and
lives **outside the repo**, owner-only (0600):

| What | Where |
|---|---|
| Raw `sheets_values_batch_get` responses | `~/.local/share/myfitnessguide/raw/<capture time>/` |
| Snapshots | `~/.local/share/myfitnessguide/snapshots/<ISO basic timestamp>.json` |
| Rehearsal outputs | `~/.local/share/myfitnessguide/snapshots/<timestamp>/` (`rulings.yaml`, `parity.md`, `parity.json`, `rehearsal.sqlite`, `final-load/*.sql`) |
| Members (names, Access emails, modes, home gyms) | `~/.config/myfitnessguide/members.json` |

Never commit any of them.

## 1. Snapshot (read-only)

Sheets and Drive are read, never written. Read every tab of the four files
(ids in `shared/config.yml`) twice with the google-workspace MCP tool
`sheets_values_batch_get` (auth profile `user-primary`): once with
`formulas: true` (formula text, or the unformatted raw value) and once
plain (the rendered values). Use explicit A1 ranges per tab, a few tabs per
call. Save each response as `<file>-<formulas|values>-<n>.json` (file is
`base`, `hritvik`, `asha` or `kabir`) in a directory named for the
capture time (`2026-10-05T19-07-21Z`), then:

```sh
npm run gym-import -w @myfitnessguide/importer -- assemble --raw ~/.local/share/myfitnessguide/raw/2026-10-05T19-07-21Z
npm run gym-import -w @myfitnessguide/importer -- validate ~/.local/share/myfitnessguide/snapshots/20261005T190721Z.json
```

The snapshot is versioned (`format: myfitnessguide-sheets-snapshot`,
`version: 1`): per file its spreadsheet id, name and modified time; per tab
the range read, its size and both grids, padded to one rectangle. The
validator checks every expected tab is present and every grid is
rectangular, and reports row counts.

## 2. Rehearse (local only)

```sh
npm run gym-import -w @myfitnessguide/importer -- rehearse ~/.local/share/myfitnessguide/snapshots/20261005T190721Z.json
```

This builds a fresh `rehearsal.sqlite` with every D1 migration applied and
loads the snapshot **through the Worker's own tool handlers and
validation**, in process (`@myfitnessguide/worker/importing`), as resolver
`importer` with origin `import`. Each write log row carries its Sheets
origin (file, tab, row) in `resolver_detail`, plus any typed values the app
recomputes (Log total, volume, e1RM). What has no API path yet (the
household, members, gyms and their implements, exercises, the programme,
goal points, the old Agent Audit rows) goes through import-only tools that
validate the same way and are not HTTP routes. Phases go through
`programme_change`. The gym inventory and the phases are read from prose,
so each implement and each unclear phase is a ruling to check.

If `members.json` is missing, the first run writes one with placeholder
emails (`*@placeholder.invalid`). Put the real Access emails in before the
final load.

It then writes:

- `rulings.yaml`: every row that failed validation or mapping, with its
  origin, the cells, the problem, a proposed fix, `kind` and `decision`.
  Mechanical rulings are decided by the importer. Decide each semantic
  ruling by setting `decision: accepted` (apply the proposal, or `override`
  when given) or `rejected` (leave the row out). The next run re-applies
  every decision by id, so runs are deterministic. A decision re-applies only
  while the row it was decided on is unchanged (`decided_on` hashes it): a
  row edited since comes back `pending`, with the old decision under
  `previous_decision`. A parity difference can
  be ruled by hand: add a ruling with the difference's id
  (`<file>/<tab>!<row>/parity/<metric>`), a `cause` and a decision.
- `parity.md` / `parity.json`: the app's computed values against what
  Sheets rendered, at the gate ticket's tolerances, each `within`,
  `explained` (with a cause) or `unexplained`. **The gate is PASS only when
  nothing is unexplained and no ruling is pending.**
- `final-load/final-load-NNN.sql`: the rehearsal database as INSERTs, in
  foreign-key order, each statement under 90 KB and each file under 1 MB,
  without transactions and without the rows the migrations seed. Generated,
  never executed.

Repeat (decide rulings, re-run) until the gate passes on a fresh snapshot.

To check the SQL against a local D1 (miniflare) before cutover:

```sh
cd app/worker
npx wrangler d1 migrations apply gym-tracker --local --persist-to /tmp/gym-d1
for f in ~/.local/share/myfitnessguide/snapshots/<timestamp>/final-load/*.sql; do
  npx wrangler d1 execute gym-tracker --local --persist-to /tmp/gym-d1 --file "$f"
done
```

## 3. Cutover (Hritvik runs this; the importer never does)

From *Import design*, step 5. Run from `app/worker`, where `wrangler.jsonc`
must name the real production `database_id`.

1. Announce a short logging pause; the agent holds anything said in chat.
2. Protect every tab (owner-only) and prefix the four file names with
   `[FROZEN]` (by hand, in Sheets).
3. Take the final snapshot (section 1) and rehearse it with the decided
   `rulings.yaml` copied next to it. Proceed only on **Gate: PASS** and
   with real emails in `members.json`.
4. Load an empty production database:

   ```sh
   npx wrangler d1 migrations apply gym-tracker --remote
   npx wrangler d1 execute gym-tracker --remote --command "SELECT count(*) AS n FROM write_log"   # must be 0
   for f in ~/.local/share/myfitnessguide/snapshots/<final>/final-load/final-load-*.sql; do
     npx wrangler d1 execute gym-tracker --remote --file "$f" || break
   done
   ```

   Files apply in name order; each is atomic. If one fails, stop: fix,
   re-create the database (or delete its rows), and start the load again.
5. Check the counts against `parity.md` → *Records loaded*, e.g.
   `npx wrangler d1 execute gym-tracker --remote --command "SELECT (SELECT count(*) FROM intake_item), (SELECT count(*) FROM session_set)"`.
6. Merge the thin skills that point at the MCP server.
7. Smoke test: one real meal and one set through the agent, totals checked.
8. Resume logging; write the held entries.

Rollback: revert the skills, remove the protections and the `[FROZEN]`
prefix, and discard the production D1 data. Nothing in Sheets changed
apart from protections and names.

## Development

```sh
npm test -w @myfitnessguide/importer        # vitest, synthetic fixtures only
npm run typecheck -w @myfitnessguide/importer
```

Fixtures (`test/fixture.ts`) are invented values in the real column layout.
Never put real household data in a fixture.
