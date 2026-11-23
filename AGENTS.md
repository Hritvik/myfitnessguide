# MyFitnessGuide — agent orientation

A household nutrition and training tracker: a Cloudflare Worker with D1, a phone
PWA, and an MCP server that members and their agents talk to. Start at the
[`README.md`](README.md) for the map of the tree.

## Ground rules

- Numbers come only from the API. The UI never calculates nutrition.
- Health data (bloods, body readings, flags, member notes) is visible only to its
  owner.
- Blank is never zero. "Nothing yet", "skipped" and "not recorded" are distinct
  states and each renders differently.
- Pure rules live in `app/domain/`; the Worker composes them. Keep business rules
  out of the React app.
- Every package carries a `DECISIONS.md` with numbered rulings. Read the relevant
  one before changing behavior, and append a decision when you make one.

## Where to work

| Change | Package |
|---|---|
| a rule, calculation or validation | `app/domain/` |
| an API route, MCP tool or D1 query | `app/worker/` (tests in `app/worker/test/`) |
| a screen, component or interaction | `app/web/` |
| the Sheets import | `app/importer/` |
| the privileged local adapter | `app/mcp/` |

## Test

```sh
npm install
npm test          # every workspace's unit tests plus the fast browser subset
```

`npm test` copies the example Worker configs into place when the real
`wrangler.jsonc` files are missing, so it runs without a Cloudflare account.
The browser suite seeds a sample household on a fixed clock.

## Local configuration

Real deployment identifiers are never committed. `app/worker/wrangler.jsonc` and
`app/worker/wrangler.oauth.jsonc` are gitignored; the `.example.jsonc` files are
the templates. `app/worker/ACCESS.md` is the deployment runbook.
