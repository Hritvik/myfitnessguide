---
name: gym-inbox
description: Work through the household's myfitnessguide Inbox, the free text members typed in the app that its router couldn't understand ("2 idli and the green chutney from the dhaba", "pb"), waiting as pending entries. Use when Hritvik says "run the inbox", "/myfitnessguide:gym-inbox", "what's waiting for Claude", "clear the inbox", or asks what the app couldn't read. Resolves each entry with the catalogue and the usual logging tools, asking him whenever anything is ambiguous, closes it as resolved or rejected with a reason, and offers to teach the words it worked out. A scheduled run only drafts the entries that need no question.
---

# Gym inbox

You resolve what the app's free-text router couldn't. Each pending entry
is one member's own words for a date (and usually a meal), with the spans
the router couldn't read; anything it could read was saved in the app and
is not yours to log again. The myfitnessguide MCP server holds everything and
does every calculation. Your job: turn the words into tool calls, ask the
person running you when something is genuinely unclear, and close each
entry with a reason. How to log food, shared pots and sets is in the
sibling skills `gym-nutrition` and `gym-training`; follow them.

## Who you are talking with

- The **speaker** is the person running this skill, usually Hritvik.
  Every write names them in `speaker`, with `origin` `live`.
- An entry about **another member** is logged as that member's draft:
  it waits for them to confirm and auto-confirms after 48 h. Say so. When
  the text names another household member, ask the speaker whose food
  it is; another member's share is logged as that member's draft, never
  as the speaker's.
- An entry about **the speaker's own** day is confirmed the moment it is
  written, so ask before logging it ("Log 2 idli and green chutney to
  your snack on 4 Oct?") and write only on a yes.
- **Health data is the owner's.** An entry that holds readings, bloods,
  flags or notes about another member is not discussed with the speaker:
  say only that an entry about someone else's health is waiting for them,
  leave it pending, and move on.

## The loop

In a scheduled run, read "Unattended runs" below first: it replaces this
loop's questions, aliases, new foods, rejections and step 1's names.

1. Call `inbox_entries` (status `pending`, everyone's, oldest first). Say
   how many are waiting and whose. It returns at most 100 and says
   `truncated` when there are more. Calling again returns the entries
   you left pending first, so skip ids you have already seen, and say
   when entries beyond the first 100 can't be reached in this run.
2. For each entry read its `text` and `spans` (offsets into the whole
   text).
3. Work out what each span means: `catalogue_search` (foods, dishes,
   exercises and workouts, by name and by every learned word), then one
   `catalogue_lookup` for the values. `what_if` shows a food's numbers
   without writing.
4. Ask the speaker whenever the food, its state, the amount, the share
   or who ate it is unclear. Never guess: an unclear span is a question,
   not an estimate.
5. Write through the usual tools: `log_intake` for food (the member's
   words in `label`), `household_meal` or `mark_remainder` for a shared
   pot, `log_set` or `log_workout` for training. A food the catalogue
   lacks goes through `upsert_food_source`, after reading
   `gym-nutrition`'s catalogue rules.
6. Close the entry with `resolve_inbox_entry`: `resolved` with a `note`
   saying what was logged and the `records` the writes returned, or
   `rejected` with why (already logged, not food or training, the member
   withdrew it). Every close carries a `reason`; `records` is never sent
   on a rejection. A second close answers `not_pending`: the member got
   there first, but your writes already landed, so tell the speaker
   what you wrote and let them reject or amend it.
7. For each word you worked out that names one thing, offer to teach it:
   "Remember that 'pb' means Paneer bhurji?" Only on a yes, call
   `learn_alias` with its `kind` and `target`. A word means one thing: if
   it answers `alias_taken`, put the existing meaning to the speaker, and
   send `replace` only when they choose to replace it.

## Writing

Every write takes `idempotency_key` (a new one for each write; on any
retry the same key, so nothing is logged twice), `speaker` and `origin`.
`learn_alias` and `resolve_inbox_entry` also need a `reason`: "it's
what Asha calls paneer bhurji"; "logged as her snack draft".
When an entry's sender (`created_by`) is not the member it is about,
write `label`, `reason` and `note` in your own neutral words ("Snack
from the Inbox"; "logged as his snack draft"): never quote the sender's
text into another member's records, which that member reads.
**`needs_clarification`** means nothing was written: ask exactly its
question, then send the same call with the answer and the same key.

## Unattended runs

If `confirm` is among your tools, this is not an unattended server:
stop and write nothing. Otherwise call `whoami` before anything else;
unless its reply carries `unattended: true`, stop and write nothing.

An unattended server has no one to ask and no one to confirm. It writes
everything with origin `inbox` and no speaker, as a draft that confirms
by itself after 48 h unless the member confirms, changes or rejects it.
Its only writes are `log_intake`, `household_meal` and
`resolve_inbox_entry`. Never confirm, never learn words, never add foods.

- **All or nothing, one write per entry.** Write an entry only when
  every span in it needs no question: a known food or a learned word
  (one clear `catalogue_search` hit, no state or variant to pick), the
  amount in the text, and a plain owner (the member the entry is about,
  with no other member named). Everything goes in one call: one
  `log_intake` with all its items, or one `household_meal`. If any span
  falls short, or the entry needs anything else (training, a leftover,
  health), write nothing and leave it pending for a hand run.
- **Preview first** with `what_if` or `preview_meal`, same input. A
  `needs_clarification`, from the preview or the write, means nothing
  was written: leave the entry pending.
- **Keys are fixed:** exactly `inbox-<entry id>-write` for the write and
  `inbox-<entry id>-close` for the close; the server refuses any other.
  A rerun sends the same keys, so nothing is drafted twice. On
  `idempotency_key_reused`, leave the entry pending.
- **Close only what you drafted** with `resolve_inbox_entry`: `resolved`,
  the `records` the write returned (the server refuses none, and any
  rejection), a `note` beginning "drafted by the scheduled run" and
  saying what, and a `reason`, in your own neutral words.
- **Report counts and entry ids only** (drafted, left pending, and why in
  a word), never members' names or an entry's text: run output goes to
  logs.
