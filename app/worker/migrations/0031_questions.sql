-- Migration number: 0031 	 2026-10-09
-- Redesign A (docs/superpowers/specs/2026-10-09-redesign-a-design.md §5):
-- Claude's questions to a member, and the drafts each one holds.
--   * question: asked by the agent (ask_member), answered by its member
--     (answer_question), closed when the answer's Inbox entry is resolved,
--     dropped when none of its drafts is a draft any more.
--   * question_block: the drafts a question holds (also in question.blocks),
--     found from a draft by (table_name, record_id). While a question is
--     open or answered, auto-confirm leaves its drafts alone. A question is
--     live only while one of its drafts is still a draft (decided at read
--     time), so a draft settled by any write settles its question.
-- Additive: two tables, three indexes and a trigger. The Worker before this
-- migration never reads them, so it is the rollback target.

CREATE TABLE question (
  id                     INTEGER PRIMARY KEY,
  -- The member asked: the sender of the Inbox entry it is about, when there is one.
  member_id              INTEGER NOT NULL REFERENCES member (id),
  -- The Inbox entry the question is about (its text is quoted to the member).
  inbox_entry_id         INTEGER REFERENCES inbox_entry (id),
  text                   TEXT    NOT NULL CHECK (length(trim(text)) > 0),
  choices                TEXT    NOT NULL CHECK (json_valid(choices) AND json_type(choices) = 'array' AND json_array_length(choices) BETWEEN 1 AND 4),
  -- The drafts it holds, [{table, id}], written once when asked: every version of the question shows them,
  -- so an answered question's drafts stay readable through its history (question_block is their index).
  blocks                 TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(blocks) AND json_type(blocks) = 'array'),
  status                 TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed', 'dropped')),
  -- A choice, or the member's own words ("Something else…").
  answer                 TEXT    CHECK (answer IS NULL OR length(trim(answer)) > 0),
  -- The Inbox entry the answer was sent as; resolving it closes the question.
  answer_inbox_entry_id  INTEGER REFERENCES inbox_entry (id),
  asked_at               TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', asked_at) IS asked_at),
  answered_at            TEXT    CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', answered_at) IS answered_at),
  closed_at              TEXT    CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', closed_at) IS closed_at),
  CHECK ((answer IS NULL) = (answered_at IS NULL)),
  CHECK ((answer IS NULL) = (answer_inbox_entry_id IS NULL)),
  CHECK (status <> 'open' OR answer IS NULL),
  CHECK (status NOT IN ('answered', 'closed') OR answer IS NOT NULL),
  CHECK ((status IN ('closed', 'dropped')) = (closed_at IS NOT NULL))
) STRICT;

CREATE INDEX question_by_member ON question (member_id, status);
CREATE INDEX question_by_answer ON question (answer_inbox_entry_id);

CREATE TABLE question_block (
  question_id  INTEGER NOT NULL REFERENCES question (id),
  table_name   TEXT    NOT NULL CHECK (table_name IN ('session', 'session_set', 'portion', 'leftover_serving', 'intake_item', 'reading', 'blood_draw')),
  record_id    INTEGER NOT NULL,
  PRIMARY KEY (question_id, table_name, record_id)
) STRICT;

-- A draft's open question is found by this join (spec §5; review #7).
CREATE INDEX question_block_by_record ON question_block (table_name, record_id);

-- A question is answered once: a second answer, even a concurrent one, aborts its batch (app.ts: 409 not_open).
CREATE TRIGGER question_answers_once BEFORE UPDATE OF answer ON question
WHEN OLD.status <> 'open'
BEGIN
  SELECT RAISE(ABORT, 'question_not_open');
END;
