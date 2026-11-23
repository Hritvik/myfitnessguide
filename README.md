# MyFitnessGuide

A household nutrition and training tracker. It shows whether your current choices
are moving you in the direction you want, while leaving every decision to you.

It runs as a Cloudflare Worker with D1, reached through an MCP server, with a
phone web app. A household is the unit of tenancy: members share meals and a
kitchen, train at their own gyms, and each member's health data is visible only
to its owner.

| Part | Where | Does |
|---|---|---|
| Remote MCP | `app/worker/src/oauth-entry.ts` | Member access from ChatGPT and other OAuth-capable MCP clients |
| Privileged MCP adapter | `app/mcp/` | Local administration and unattended jobs ([README](app/mcp/README.md)) |
| Coaching skills | `myfitnessguide/skills/` | Optional Claude Code guidance for privileged workflows |
| Worker API and D1 | `app/worker/` | Every rule, check and computation, behind Cloudflare Access ([ACCESS.md](app/worker/ACCESS.md)) |
| Domain rules | `app/domain/` | Pure TypeScript rules: loads, progression, nutrition, body |
| Importer | `app/importer/` | A one-time Sheets → D1 import, with rulings and a parity report |
| Web app | `app/web/` | The phone PWA ([README](app/web/README.md)) |
| Legacy skills | `app/skills/` | The Sheets-era skill package, kept while the archives are frozen |

## Run it locally

```sh
npm install
npx playwright install chromium      # once per machine, for the browser suite

npm test                             # every workspace's unit tests, then the browser suite's fast subset
npm run test:e2e -w @myfitnessguide/web   # the full browser suite (about 30 minutes)
```

The Worker tests run against a local D1. `npm test` copies the example configs
(`app/worker/wrangler.example.jsonc`, `app/worker/wrangler.oauth.example.jsonc`)
into place when the real ones are missing, so a fresh clone needs no Cloudflare
account. The local browser suite seeds a sample household on a fixed clock.

Each browser-suite run leaves its summary (verdict, counts, timings, layout
findings) in `$TMPDIR/myfitnessguide-e2e-last/<mode>.json`; see
[`app/web/README.md`](app/web/README.md).

The layout gate (`npm run test:layout -w @myfitnessguide/web`, about five
minutes) checks every screen at eight widths in light and dark. It is a manual
step here; there are no repository hooks.

## Deploying your own

Deployment identifiers live in local-only files that are gitignored:
`app/worker/wrangler.jsonc` and `app/worker/wrangler.oauth.jsonc`. Copy the
`.example.jsonc` templates and fill in your account, D1 database, Access
application and service tokens. [`app/worker/ACCESS.md`](app/worker/ACCESS.md)
is the runbook: D1 creation, Access policies, service tokens, and the deploy
gate.

## Connect a member

A deployed instance exposes its OAuth MCP endpoint at the Worker's origin plus
`/mcp`:

```text
https://<your-worker>.workers.dev/mcp
```

The browser sign-in identifies the member and the server exposes the tools that
member may use. No repository checkout, Node installation, service token, or
local MCP process is needed.

The privileged adapter is separate: it talks to the Worker with a Cloudflare
Access service token from `~/.config/myfitnessguide/access-service-token.json`
and is documented in [`app/mcp/README.md`](app/mcp/README.md).

## Docs

- [`CONTEXT.md`](CONTEXT.md): the domain glossary
- [`docs/design/PRODUCT.md`](docs/design/PRODUCT.md): product truths and anti-goals
- [`docs/design/DESIGN.md`](docs/design/DESIGN.md): the design system
- [`docs/design/`](docs/design/): screen mockups for the redesign and the food proposals
- `DECISIONS.md` in each package: the numbered rulings behind the code

## A note on names

The project is **MyFitnessGuide** / `myfitnessguide`. A few deployed resource
names still say `gym-tracker` (the D1 database, the OAuth Worker, one service
token, and the local backup job). They are kept because renaming live Cloudflare
resources would break existing clients for no user-visible gain. New code uses
`myfitnessguide`.
