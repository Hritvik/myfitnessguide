# Cloudflare setup and Access runbook

The Worker and D1 are defined as code in `wrangler.jsonc` and `migrations/`.
The Access pieces live only in the dashboard; this file is their record.
Terraform was considered and rejected on 5 Oct 2026: it would put the
service-token secret into a local state file and fight wrangler over the
same resources.

## Local configuration

The deployment config is gitignored; only placeholders are committed:

- `app/worker/wrangler.jsonc` - copy from `wrangler.example.jsonc`

Fill in the D1 database id, the Access team domain and AUD tag, the service-token
client ids, and the OAuth KV namespace id. `npm run deploy` reads the local file;
nothing here needs to be committed. `npm test` copies the template in when the
local file is missing, so a fresh clone runs green with placeholder values.
The deploy gate exempts that path from its ignored-source check (it reads and
validates the config itself), so a filled-in local config does not block
`npm run deploy`.

The OAuth MCP needs two secrets on the **same** Worker, set once (they are not
in `wrangler.jsonc`): `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
(`npx wrangler secret put GOOGLE_CLIENT_ID --name myfitnessguide`, likewise the
secret). The provider keeps grants in the `OAUTH_KV` KV namespace bound in
`wrangler.jsonc`.

## What exists

| Thing | Value | Where |
|---|---|---|
| Cloudflare account | `<account-email>`, ID `<account-id>` | |
| D1 database | `gym-tracker`, ID `<d1-database-id>`, location `apac` | `wrangler.jsonc`, binding `DB` |
| Zero Trust team | `<team-name>` → `<team-name>.cloudflareaccess.com` | Zero Trust → Settings |
| Worker | `myfitnessguide.<subdomain>.workers.dev`, with an hourly cron that auto-confirms drafts; serves the PWA (`app/web/dist`) at `/` and the OAuth MCP at `/mcp` | first deployed 5 Oct 2026 |
| OAuth KV | `OAUTH_KV`, id `<oauth-kv-namespace-id>` | `wrangler.jsonc`; grants for the MCP |
| Google OIDC client | redirect URI `https://myfitnessguide.<subdomain>.workers.dev/callback` | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` secrets |
| Access application | `myfitnessguide`, self-hosted; login method One-time PIN; AUD `<aud-tag>` | `ACCESS_AUD` in `wrangler.jsonc` |
| Service token | `gym-tracker-agent`, client id `<service-token-client-id>.access` | secret in `~/.config/myfitnessguide/access-service-token.json` |

## Order of first-time setup

Access must protect the Worker's domain **before** the first deploy.

1. `npx wrangler d1 create gym-tracker --location apac` *(done)*
2. `npx wrangler d1 migrations apply gym-tracker --remote` creates the schema, empty.
3. Zero Trust: pick a team name and the Free plan *(done: `<team-name>`)*.
4. **Service token:** Zero Trust → Access → Service credentials → Create
   `gym-tracker-agent`. The Client ID and Secret are shown **once**. Save them to
   `~/.config/myfitnessguide/access-service-token.json` (directory `chmod 700`,
   file `chmod 600`) as `{"client_id":"…","client_secret":"…"}`. Never
   commit them.
5. **Access application:** Zero Trust → Access → Applications → Add →
   Self-hosted, login method **One-time PIN** (not the default "Cloudflare" login, which needs a Cloudflare account), with domain `myfitnessguide.<subdomain>.workers.dev`.
   - Policy "Household": Allow, include the three members' emails.
   - Policy "Agent": action **Service Auth** (not Allow: an Allow policy refuses token-only requests with a 403 even though the token is valid), include the service token `gym-tracker-agent`.
   - Copy the application's **AUD tag**. If the dashboard doesn't show it, log in through
     the app and decode the `aud` claim of the `CF_Authorization` cookie.
6. Worker settings, kept as plain `vars` in `wrangler.jsonc` because none of them is a secret:
   `ACCESS_TEAM_DOMAIN` (already set to `<team-name>.cloudflareaccess.com`),
   `ACCESS_AUD` (the AUD tag from step 5), and `SERVICE_TOKENS`, a JSON map of
   each service token's **client id** (not its secret) to its resolver and
   trusted channel, e.g. `{"<interactive id>.access":{"resolver":"claude_code","channel":"local_agent"}}`.
   The legacy value `"claude_code"` or `"hosted_model"` remains valid and
   means `local_agent`. Invalid JSON or an unknown resolver/channel fails
   closed for every service token. While AUD or SERVICE_TOKENS is empty, the
   Worker refuses every service-token request; member sign-in is independent.
   An unattended job must use its own Access service token/client id, mapped
   explicitly as `{"resolver":"hosted_model","channel":"unattended"}`. Do
   not reuse the interactive principal: `origin: "inbox"` does not grant or
   imply the unattended channel.
7. `npm run deploy` (the gated deploy, under Routine operations), then check that a request without a token is refused:
   `curl -s -o /dev/null -w '%{http_code}\n' https://myfitnessguide.<subdomain>.workers.dev/tools`
   should be 302/403, never 200.

## Remote MCP on the app origin

The OAuth MCP and the app are one Worker (worker decision 172). Cloudflare
Access gates `/tools` and the PWA, so the OAuth paths must be **bypassed** in
the `myfitnessguide` Access application, or the client never reaches the
provider:

```text
/mcp
/authorize
/callback
/oauth/*
/register
/.well-known/*
```

Add these as Bypass policies (or a separate self-hosted application with a
Bypass policy) in Zero Trust → Access → Applications. `/tools` and `/tools/*`
stay Access-protected. Google's OAuth client must also allow the callback
`https://myfitnessguide.<subdomain>.workers.dev/callback`.

Deploy order for this change: set the two Google secrets, add the bypasses,
then `npm run deploy`. Check `/authorize` returns the consent page (200, not a
302 to Access) and `/mcp` answers 401 without a token; `/tools` must still be
302. Members re-register their client against the canonical URL; the old
`gym-tracker-mcp` Worker and `wrangler.oauth.jsonc` are gone.

## Routine operations

- **Deploy (the app and the API together):** from the repo root,
  `npm run deploy` (or `npm run deploy` in `app/worker`: both run the deploy
  gate, `app/worker/scripts/deploy-gate.ts`, the Worker's `deploy` script,
  once). The gate runs `wrangler deploy` only if, in order:
  - **1.** no extra arguments were given;
  - **2.** no `.wrangler/deploy/config.json` redirect is in effect, and
     `wrangler.jsonc` (read by wrangler's own reader, every `env.*` block
     too) names a Worker, names none of `LOCAL_DEV_IDENTITY`,
     `LOCAL_IDENTITY_TOKEN` and `LOCAL_FIXED_NOW` in any `vars`, binding
     (`unsafe.bindings` included) or other field, has no `keep_vars: true`,
     keeps `main` at `src/index.ts` and has no `remote: true` binding; and
     no `WRANGLER_*`, `CLOUDFLARE_*` or `CF_*` variable is set, in the shell
     or in an `app/worker/.env*` file, other than the sign-in
     (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CLOUDFLARE_EMAIL`), the
     account (`CLOUDFLARE_ACCOUNT_ID`), their `CF_*` aliases, and logging (`ALLOWED_ENV` in the gate
     says why for each). The Worker's name is read here and passed by
     `--name` to every wrangler call;
  - **Build:** the gate builds the web app (`npm run build -w @myfitnessguide/web`)
    from this tree, so a stale `app/web/dist` never ships;
  - **3.** the dry-run bundle names neither the dev entry's header nor
     `LOCAL_IDENTITY_TOKEN` or `LOCAL_FIXED_NOW`;
  - **4.** no secret has any of those names. Checks 3 and 4 (the dry run,
     and `wrangler secret list --format json`) first run against the account
     on the first gated deploy: a refusal saying wrangler "didn't print a list
     of secrets" means it printed something other than JSON (an expired
     login, say), not that a dev secret exists;
  - **5.** the tree is clean, `node_modules` matches `package-lock.json`, no
     ignored source hides under `app/`, and there is a stamp from
     `npm run test:e2e -w @myfitnessguide/web` for HEAD's `app/`, `package.json`
     and `package-lock.json` (a docs-only commit after a pass keeps the
     stamp). **The tree must be clean:** `git status --porcelain
     --untracked-files=all` must print nothing over the whole checkout, since
     an untracked file blocks both the stamp (the e2e run refuses to stamp
     "the tree was not clean at the start") and check 5. Clean or ignore it
     rather than reaching for `E2E_GATE_OVERRIDE`; then run
     `npm run test:e2e -w @myfitnessguide/web` in that checkout, then
     `npm run deploy`;
  - **7.** just before the deploy, the tree, the config and the environment are
     read again and must be what was built and checked. After the deploy
     the bundle wrangler uploaded is checked again; a hit prints "Roll back
     now" (below). Wrangler re-reads the tree when it deploys, so a change
     in the second between check 7 and that read is caught only that way.

  The Worker serves `app/web/dist` as static assets on
  the same hostname as the API, so the one Access application covers both
  and the household signs in once. Only `/tools` and `/tools/*` run the
  Worker code (`run_worker_first` in `wrangler.jsonc`), which checks the
  Access identity; every other path is the PWA, with unknown app routes
  falling back to `index.html`. Apply any new migration first (below).
  **Order matters: migrations 0028 and 0029 must be on the remote D1
  before the Worker deploys, never after.** A new Worker on the pre-0029
  schema breaks pot reads (Today, Household), `needs_you`,
  `household_overview` and the auto-confirm cron; an old Worker on the new
  schema is safe. **Precondition for 0028:** it moves goal points to their
  week's Sunday and would silently merge two of one member, metric and tier
  that fall in the same Sunday-to-Saturday week. Before applying it, run
  this against the remote D1 and stop if it returns any row (resolve those
  by hand first):
  `SELECT member_id, metric, exercise_id, tier, date(week_of,'-'||strftime('%w',week_of)||' days') AS wk, count(*) FROM goal_point WHERE basis='absolute' GROUP BY 1,2,3,4,5 HAVING count(*) > 1`
  Afterwards check both halves:
  `curl -s -o /dev/null -w '%{http_code}\n' https://myfitnessguide.<subdomain>.workers.dev/tools`
  is 302/403 (Access) and never 200, and the app opens at the root after
  signing in.
- **When the suite can't run (a hotfix):** `E2E_GATE_OVERRIDE="<why>" npm run deploy`
  stands in for check 5 only, never for the checks before it or check 7.
  The gate prints the reason with the commit and appends it to
  `<git common dir>/e2e-pass/overrides.jsonl`, with whether the tree had
  uncommitted changes and the trees that shipped; the next full run lists
  it.
- **Migration 0030 (app input: the one alias store, the Inbox, route
  stats) and its deploy.** Take the backup first (below). **Preconditions,
  against the remote D1; stop if either returns any row** and resolve those
  aliases by hand first, since 0030's `alias` column refuses untrimmed text
  and is unique per household ignoring case:
  `SELECT alias FROM exercise_alias WHERE alias <> trim(alias)`
  must return no rows, and no two aliases may collide once trimmed and
  case-folded:
  `SELECT e.household_id, lower(trim(a.alias)) AS folded, count(*) FROM exercise_alias a JOIN exercise e ON e.id = a.exercise_id GROUP BY 1, 2 HAVING count(*) > 1`
  must return no rows. **Order: the migrations (0030) go on before the
  Worker deploy, never after.** Apply with
  `npx wrangler d1 migrations apply gym-tracker --remote`, then check that
  every exercise alias was copied and kept:
  `npx wrangler d1 execute gym-tracker --remote --command "SELECT (SELECT count(*) FROM alias WHERE kind = 'exercise') AS copied, (SELECT count(*) FROM exercise_alias) AS kept"`
  gives two equal counts. Then `npm run deploy` from the repo root.
  **Rollback:** 0030 is additive (it copies the exercise aliases, keeps
  `exercise_alias`, recreates `v_exercise` with the same columns, and only
  adds tables and a nullable column), so roll the Worker back to the
  previous version, `b4ea0286` (`npx wrangler rollback b4ea0286`, after
  checking it in `npx wrangler deployments list`); the new tables stay and
  the old Worker never reads them. Data goes back only from the backup,
  into a new database, never over the live one. **After the deploy:**
  re-sync the installed plugin so `gym-inbox` (whose tools the new Worker
  serves) is live, with the same install commands the deployment uses:
  `claude plugin uninstall myfitnessguide@<your-marketplace> -y && claude plugin install myfitnessguide@<your-marketplace> -y`
  (after the build is merged into the main checkout). **Post-deploy
  check, latency:** put one real `what_if`, `preview_set`, `preview_meal`
  and `route_text` input in `inputs.json`, then
  `npm run latency -w @myfitnessguide/mcp -- inputs.json 30`
  (reads only; see `app/web/DECISIONS.md` 53). The script measures wall
  time, so read the CPU time in `wrangler tail` or the Workers dashboard.
  Look at `route_text`'s first
  (cold) run against Workers Free's 10 ms CPU limit: its heavy case was
  10-16 ms of CPU cold in Node. If the live cold run fails or is slow,
  that is the limit; note it in that decision and raise it before relying
  on the router.
- **The manual bypass:** `npx wrangler deploy` by hand skips the gate. It is
  acceptable only because the header sign-in can't ship: it lives in
  `src/dev-entry.ts`, which `main` never imports, and the gate's bundle check
  pins that. Use `npm run deploy` (with the override if you must). To roll
  back, `npx wrangler deployments list`, then `npx wrangler rollback <the
  previous version>` (not Migration 0030's fixed version, which would undo
  every later deploy).
- **Weekly backup:** `npx wrangler d1 export gym-tracker --remote --output ~/gym-tracker-backups/$(date +%F).sql`.
  D1 also keeps 7 days of point-in-time recovery, so schedule an export if the
  data matters more than that window. A launchd job or cron that runs
  `wrangler d1 export`, refuses a suspiciously small file, writes it `0600`,
  keeps the newest 12 and logs is enough; keep it outside this repository.
  Take a manual export before any migration that rebuilds a table.
- **New migration:** `npx wrangler d1 migrations apply gym-tracker --remote`
  after the tests pass locally.
- **Migration 0032 (trusted write channel):** apply it before deploying the
  Worker that writes `write_log.channel`. It adds a nullable checked column
  without a default, so the old Worker remains safe during rollout. Historical
  importer and system writes are deterministically backfilled. Older member/app
  and service-agent writes remain `NULL` (`legacy unknown`): before this change,
  one agent principal could run interactively or unattended, so neither channel
  can be reconstructed honestly. New writes are stamped by the server as `web`,
  `remote_mcp`, `local_agent`, `unattended` or `import`.
- **Rotate the service token:** create a new token, add it to the "Agent"
  policy, update `~/.config/myfitnessguide/access-service-token.json`, check
  that the MCP server works, then delete the old token.
- **Household change:** edit the emails in the "Household" policy, and
  add or deactivate the member in the database through the API.
