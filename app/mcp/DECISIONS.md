# MCP server decisions

Built for ticket 22 (*MCP server*) against the Worker contract in
`app/worker/src/app.ts`, `app/worker/src/tool.ts` and
`app/worker/src/DECISIONS.md`.

## Surface

1. **Generated from `GET /tools`, not hand-written.** Each listing entry
   (`name`, `group`, `description`, `write`, `endpoint`, `input_schema`)
   becomes one MCP tool with the same name. `input_schema` is passed through
   as the MCP `inputSchema`, so the Worker's zod schemas stay the one source
   of truth. `group` and `endpoint` are not used; calls always go to
   `POST /tools/<name>`.
2. **Low-level `Server`, not `McpServer`.** `McpServer.registerTool` wants
   zod shapes; the API already serves JSON Schema, so the low-level
   `tools/list` and `tools/call` handlers pass it through untouched.
3. **SDK pinned at `@modelcontextprotocol/sdk` 1.32.1** (latest on
   6 Oct 2026), stdio transport.
4. **No build step.** Node 26 runs the `.ts` sources directly (type
   stripping), so `claude mcp add` points `node` at `src/main.ts`, with no
   `tsx` and no `dist/`. The code uses only erasable syntax
   (`erasableSyntaxOnly` in `tsconfig.json`).

## Write tools

5. **Idempotency keys: the model names each logical write, and the server
   scopes the key to its process.** The model supplies `idempotency_key`
   (required, at most 160 characters) and is told to reuse it verbatim on
   every retry of the same write, and to use a new one for every new write.
   The server sends `cc:<session>:<model key>`, where `<session>` is
   `YYYYMMDD-<8 random hex>`, fixed for the life of the server process.
   - *Why not a fresh random key per call:* a retry would get a new key and
     write twice.
   - *Why not a hash of the arguments:* two identical writes are often both
     real. `log_set` takes `set_number` as optional, so two sets of 8 × 60 kg
     would hash the same and the second would be silently replayed, not
     written.
   - *Why the session prefix:* models pick short keys such as `set-1`. Without
     the prefix, `set-1` from Tuesday's session would collide with `set-1`
     today: a 409 at best (different arguments), or a silent replay of the
     old write at worst (identical arguments).
   - *Cost:* a retry that spans a restart of the MCP server (Claude Code
     restarted it mid-write) gets a new prefix, so it can write twice. This
     is rare, and the write result carries the ids for the model to amend.
   - After `needs_clarification`, nothing was written and the key isn't used
     up (Worker decision 2), so the model re-sends the same key with the
     answer filled in. The clarification text says so.
6. **A replay is labelled.** When the API answers with
   `idempotent-replay: true`, the result starts with "This write was already
   applied under this idempotency_key; nothing new was written", then the
   original JSON.
7. **`speaker` and `origin` are required on every write, and `origin` is
   only `live` or `coach`.** The API allows both to be omitted (origin
   defaults to `live`, and a missing speaker asks `speaker_required`).
   Requiring them in the MCP schema makes the model choose on every call.
   `inbox` is removed from the enum because the model never chooses it: in
   an interactive session it would let the model turn the speaker's own
   writes into drafts at will. The description explains each one: speaker
   is the member being talked with, and coach is for Coach-mode sessions
   between sets, live for everything else.
   *Amended for ticket 78 (9 Oct 2026):* this holds in interactive mode
   only. The earlier plan, an unattended resolver calling the API directly,
   is replaced by this server's unattended mode (decision 21), where the
   server, not the model, stamps every write `inbox`.
8. **`resolver_detail` and `reason` are passed through as the model sends
   them.** The server doesn't fill in `resolver_detail`, because the Worker
   already defaults it to the service token's client id.
9. **Read tools are untouched**: same schema and description as the API,
   and no key is added.
9a. **The Worker owns `channel`.** It is separate from workflow `origin` and
    is never a model field or request-header convention. The authenticated
    service-token client id maps to `local_agent` or `unattended`; interactive
    and scheduled processes therefore need distinct Access principals. A
    legacy resolver-only mapping means `local_agent`. Imports, cron, member web
    calls and member remote MCP calls are stamped at their server entry points.

## Results

10. **Mapping:**
    - `ok`: the API's JSON as text (compact).
    - `needs_clarification`: *not* an error. The first lines are "NEEDS
      CLARIFICATION — nothing was written…", then "Ask the user: <question>",
      the numbered options, and the field path. It ends with a reminder to keep
      the same `idempotency_key`. Extra fields (`reason`, …) follow as JSON.
    - `invalid`: `isError`, one line per issue, as `path: message`.
    - `error`: `isError`, as "Error <code> (HTTP <status>): <message>". On
      `idempotency_key_reused` (409) it adds a hint: use a new key for a new
      write, or the original arguments for a retry.
    - Non-2xx without the API's JSON: `isError` with the status and the
      first 500 characters of the body.
11. **Access refusal** is a 3xx (the login redirect) or any `text/html`
    reply. Redirects are never followed (`redirect: "manual"`). The model
    sees "Access refused: check the service token or the Agent policy (must
    be Service Auth)." and is told the Worker never saw the request.
12. **An unreachable API or a timeout (30 s)** is `isError`, and says a write
    may or may not have applied, so the model should retry with the same
    arguments and the same `idempotency_key`.

## Startup and secrets

13. **Cache.** Every successful `GET /tools` writes the listing atomically
    (temp file + rename) to `~/.cache/myfitnessguide/tools.json`. If the
    listing fails (unreachable, Access refusal, non-JSON), the server starts
    from the cache and logs why. With no cache it exits 1, so Claude Code
    shows it as failed rather than connected with no tools. The list isn't
    refreshed while the server runs: restart the server to pick up new
    tools (`/mcp` → reconnect).
14. **A bad token file stops startup.** A missing or malformed
    `access-service-token.json` exits with an error that names the file but
    never quotes it. `JSON.parse`'s own message quotes the start of the
    input, which could be the secret, so it is replaced.
15. **stderr only.** All logging is `[myfitnessguide-mcp] …` on stderr; stdout
    belongs to the stdio transport. A stdio test runs the real entry point,
    so any stray stdout write breaks the protocol and fails the test.
16. **User-Agent** is
    `myfitnessguide-mcp/0.1.0 (Claude Code MCP server; node <version>)`, sent
    on every request, because Cloudflare answers error 1010 to default
    library user agents.

## Ambiguities

17. **Env var names** for the overrides weren't specified. They are
    `GYM_TRACKER_API_URL` (given), `GYM_TRACKER_TOKEN_FILE` and
    `GYM_TRACKER_TOOLS_CACHE`.
18. **The registered path** in the README is the main checkout
    (`app/mcp/src/main.ts`). It works once
    this branch is merged and `npm install` has run there.
19. **Live check** was one `GET /tools` through `ApiClient` (`npm run smoke`),
    which answered 41 tools (21 writes, 20 reads). No tool was called against
    the real API.

## Ticket 27 (backend gaps)

20. **No server change.** The four new tools (`staleness`,
    `set_measurement_cadence`, `add_measure`, `remove_implement_load`) and
    the changed inputs (`log_set.reps_inferred`, an optional `ref` on the
    upserts, `energy_override_reason`) reach the model through `GET /tools`
    at startup, so the server needed none; its 23 tests pass unchanged.
    The model sees them only once the Worker is deployed.

## Ticket 78 (scheduled Inbox resolution)

21. **Unattended mode: `GYM_TRACKER_UNATTENDED=1`.** A scheduled gym-inbox
    run has nobody to ask and nobody to confirm, so the server, not the
    model or a `--allowedTools` list, makes it draft-only. Narrowed after
    the review of 9 Oct 2026 (`.superpowers/unattended-inbox-review.md`)
    until every write the mode can make only creates drafts.
    - *Origin and speaker are the server's.* Every write goes as
      `origin: "inbox"`, which the Worker always makes a draft
      (`Ctx.stateFor`), and with no `speaker`. Both fields are removed from
      the write schemas, and anything the model sends in them is
      overwritten.
    - *No speaker (ruled 9 Oct 2026):* the run speaks for no one; its
      writes are attributed to the Inbox. `write_log.speaker_member_id`
      stays null, and the Worker requires a speaker only for
      `live`/`coach`.
    - *Drafts are not held for a person.* An Inbox draft confirms by itself
      after 48 h (the auto-confirm cron) unless the member confirms,
      changes or rejects it first. The mode can't confirm anything, but
      what it drafts becomes confirmed if nobody looks within 48 h; that is
      why the schedule waits for ticket 70's release point 2, when Waiting
      on you gathers these drafts. Holding Inbox drafts until a person acts
      would be a Worker change and a product call.
    - *Three writes (ruled 9 Oct 2026):* `log_intake` and `household_meal`,
      and `resolve_inbox_entry` to close. Both data writes only ever
      create new rows: `log_intake` an `intake_item` per item;
      `household_meal` the meal, its cooks, portions and direct items (all
      drafts under `inbox`), the stateless `component` and `cook_line`
      rows of those new cooks, and the `household_meal_cook` links.
      Neither updates a row that existed before.
      `app/worker/test/unattended-inbox.tools.test.ts` checks this against
      a snapshot of every table, beside confirmed data on the same day and
      slot. Every read stays. A write the Worker adds later is hidden until
      it is added here, so the mode fails closed.
    - *Dropped (ruled 9 Oct 2026, review C1 and C2):* `mark_remainder`
      writes `remainder_disposition` rows, which have no draft state, and
      can rewrite confirmed leftover marks; `log_set` and `log_workout` can
      attach a template to a confirmed session, add stateless cardio blocks
      to it or renumber its sets; `log_cardio` goes with them. Training
      and leftover text stays for a hand run.
    - *Hidden, and why* (41 of the Worker's 44 writes, 9 Oct 2026): the
      four dropped above. `confirm`, `reject`, `retract`, `amend` decide or
      change records a person owns; `start_session` and `end_session` open
      and confirm sessions. `learn_alias`, `forget_alias`,
      `upsert_food_source`, `upsert_recipe`, `add_measure`, `add_yield`,
      `add_recipe_line`, `remove_recipe_line`, `add_cook_line`,
      `remove_cook_line`, `create_workout`, `add_workout_line`,
      `remove_workout_line`, `save_session_as_workout` change shared
      catalogue or vocabulary that no draft protects. `log_reading`,
      `log_blood_draw`, `raise_flag`, `resolve_flag`, `write_member_note`,
      `set_target`, `set_goal_point`, `programme_change`,
      `set_measurement_cadence` are health or programme decisions for the
      member. `record_plates`, `add_implement_load`,
      `remove_implement_load`, `set_day_status`, `commit_route`,
      `submit_to_inbox`, `submit_feedback`, `triage_feedback` are not part
      of resolving an entry (and `submit_to_inbox` could feed the run its
      own output).
    - *Not registered means not callable:* the server never lists them and
      answers a call by name with "No tool named … in this unattended
      server", sending nothing to the API.
    - *One data write and one close per entry, under fixed keys (ruled
      9 Oct 2026; replaces decision 5's session prefix in this mode).* The
      data write's `idempotency_key` must be exactly `inbox-<entry
      id>-write` and the close's exactly `inbox-<entry id>-close`, with the
      close's `id` equal to its key's entry; the server refuses anything
      else before calling the API. The API gets `inbox:<key>`, with no
      session. A rerun after a crash therefore sends the same keys: the
      same request is replayed, and any other data write for that entry
      (a different `log_intake`, or a `household_meal`) is refused as
      `idempotency_key_reused`, so an entry never gets a second data
      write. `log_intake` and `household_meal` take many items, so one
      call covers an entry, and the Worker makes each call all or nothing:
      a question writes nothing and leaves the key unused. *Limit:* the
      server checks the key and the close's entry, not that the data
      write's key names the entry the food came from; the skill holds that.
    - *The data write's entry must be pending (review N1, 9 Oct 2026).*
      The key's form alone let a model, told by the shared 409 hint to
      "call again with a new idempotency_key", draft the same food again
      as `inbox-<another id>-write`. So before forwarding a data write the
      server reads `inbox_entries` `{status: "pending"}` fresh (no cache:
      a member may close an entry mid-run) and refuses unless `<id>` is
      among them; an unreadable list or an unreachable API refuses too.
      Cost: one extra API call per data write, so at most one per entry,
      of 2 D1 statements (the caller lookup and the one `inbox_entries`
      select; measured with the Worker harness's counter). Limit: only the
      oldest 100 pending entries are listed, so an entry beyond them is
      refused until the queue shrinks, which the run can't reach anyway.
      In this mode the hints change too: `idempotency_key_reused` says
      "This entry was already written. Do not retry under another key;
      leave it pending and stop.", and `needs_clarification` says nobody
      can be asked and to leave the entry pending, not "ask the user".
    - *The close only resolves, with records (ruled 9 Oct 2026, review
      I1).* The server refuses `resolve_inbox_entry` unless `status` is
      `resolved` and `records` is a non-empty list; the listed schema says
      the same (`status: {const: "resolved"}`, `records` required,
      `minItems: 1`). Rejecting, or closing with nothing drafted, takes the
      entry out of the pending list, so it stays for a person.
    - *Fail-safe probe (ruled 9 Oct 2026, review I4).* The setting is off
      by default, so a scheduler that forgets it gets the interactive
      server, where the speaker's own food would be confirmed. The server
      adds `unattended: true` to `whoami`'s ok reply in this mode (and says
      so in its description); the skill's unattended path stops and writes
      nothing if `confirm` is among its tools, or if `whoami` lacks
      `unattended: true`. Step 5's scheduler should pass the setting in
      its own MCP config and rely on this check, not on `--allowedTools`
      alone.
    - *The setting fails closed:* `1` is on; unset, empty or `0` is off;
      any other value stops startup, so a typo never starts an interactive
      server under a scheduler.
    - *Name:* the brief suggested `GYM_MCP_UNATTENDED`; it follows the
      existing `GYM_TRACKER_*` variables (decision 17) instead.
    - Tests: `test/unattended.test.ts` (every write sent is `inbox` with no
      speaker and the entry's key; each refused key and close; the hidden
      and dropped tools aren't listed and a call to one fails; the probe;
      interactive mode unchanged), the Worker test above (only new drafts,
      replay, a second data write refused, a question writes nothing), and
      `app/skills/test/tools.test.ts` against the Worker's own registry.
22. **The pending check is `src/pending.ts` (`npm run pending`), with its
    logic in `src/pending-check.ts`.** `pending.ts` runs the check with no
    entry-point guard, like `smoke.ts`, and sets exit code 1 until the
    check answers, so started any way (a symlink, another name, a
    wrapper) it can never fall through to exit 0 (review M1). It sits
    beside `smoke.ts` because it reuses this package's `loadConfig` and
    `ApiClient`: the same URL, token file and User-Agent as the server, no
    second copy of the credentials. One `POST /tools/inbox_entries` with
    `{"status": "pending"}`, as the agent. Exit 0 means nothing pending, 10
    means something is (the count, `+` when the API says `truncated`), and
    any failure (a bad token file, Access refusal, an API error or
    clarification, a reply without an `entries` list, an unreachable API)
    is 1, so a scheduler never reads an error as "nothing to do". It writes
    one `[pending] …` line to stderr with the count or the reason: never an
    entry's text, never the token (errors come from `readToken` and
    `ApiClient`, which never quote it). Tests stub `fetch`, and run the
    script against the in-process fake API; never the Worker.
