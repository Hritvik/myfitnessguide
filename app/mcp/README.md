# MyFitnessGuide privileged MCP adapter

This local stdio adapter is for privileged Claude Code and unattended
automation. It is deliberately retained, but it is not the normal member
product surface.

Members should connect an OAuth-capable MCP client directly to:

```text
https://gym-tracker-mcp.hritvikdinkar.workers.dev/mcp
```

That hosted endpoint authenticates the member in the browser, requires no
local process or service-token file, and exposes the canonical remote-member
tool profile. The endpoint keeps its legacy hostname so existing client
connections continue to work.

The local adapter reads `GET /tools` at startup and registers one MCP tool per
API tool, with the API's own JSON schema and description. Each call is a
`POST /tools/<name>` through Cloudflare Access with a service token. The API
maps that trusted token to an interactive or unattended capability profile
and audit channel.

Design choices and open questions are in [DECISIONS.md](DECISIONS.md).

## Requirements

- Node 26 or later. The server is TypeScript run directly by Node's built-in
  type stripping, so there is no build step and no `tsx`.
- `npm install` at the repository root (the MCP SDK is a workspace dependency).
- The service token at `~/.config/myfitnessguide/access-service-token.json`
  (`{"client_id": "...", "client_secret": "..."}`, mode 600). See
  `app/worker/ACCESS.md`.

## Register privileged access with Claude Code

Only do this for an operator who has been issued the corresponding Access
service token. User scope, stdio; run once from the repository checkout:

```sh
claude mcp add --scope user --transport stdio myfitnessguide -- node "$PWD/app/mcp/src/main.ts"
```

If Claude Code can't find `node` on its `PATH`, use the absolute path that
`command -v node` prints instead of `node`. Check with `claude mcp list`, or
`/mcp` inside a session.

## Configuration

| Env var | Default |
|---|---|
| `MYFITNESSGUIDE_API_URL` | `https://myfitnessguide.hritvikdinkar.workers.dev` |
| `MYFITNESSGUIDE_TOKEN_FILE` | `~/.config/myfitnessguide/access-service-token.json` |
| `MYFITNESSGUIDE_TOOLS_CACHE` | `~/.cache/myfitnessguide/tools.json` |
| `MYFITNESSGUIDE_UNATTENDED` | off; `1` for a scheduled run (DECISIONS.md, decision 21) |

Pass them with `-e KEY=value` on `claude mcp add` (for example, to point at
`wrangler dev`).

`MYFITNESSGUIDE_UNATTENDED=1` is for a scheduled gym-inbox run only: every write
becomes an Inbox draft (origin `inbox`, no speaker; it confirms by itself after
48 h unless the member acts), and only `log_intake`, `household_meal` and
`resolve_inbox_entry` are registered, one data write and one close per entry
under fixed keys. `whoami` then carries `unattended: true`. Never set it on the
server an interactive session uses.

Channel attribution is not supplied by this MCP process or by the model. The
Worker derives it from the authenticated Access principal. Interactive use must
use a service token configured as `local_agent`; unattended mode must use a
different service token configured as `unattended` (normally via a separate
`MYFITNESSGUIDE_TOKEN_FILE`). See `app/worker/ACCESS.md`. Reusing the interactive
token with `MYFITNESSGUIDE_UNATTENDED=1` still records `local_agent`, by design.

The last good tool list is cached. If the API can't be reached at startup,
the server starts from the cache and says so on stderr. With neither, it
exits with an error. Every request sends a `myfitnessguide-mcp/<version>`
User-Agent, because Cloudflare answers error 1010 to default library user
agents. The secret is never logged or echoed.

## Commands

```sh
npm test -w @myfitnessguide/mcp        # vitest, against an in-process fake API
npm run typecheck -w @myfitnessguide/mcp
npm run smoke -w @myfitnessguide/mcp   # ONE read-only GET /tools against the real API
npm run pending -w @myfitnessguide/mcp # ONE read-only inbox_entries call: exit 0 none pending, 10 some, else error
```

The smoke script never calls a tool. Don't point the tests or any write at the
real API.
