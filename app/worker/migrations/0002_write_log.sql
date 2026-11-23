-- Migration number: 0002 	 2026-10-05
-- The write log (replaces the Agent Audit tabs), idempotency keys, record
-- versions for amendments, member notes, and the imported Agent Audit rows.
--
-- Draft / confirmed state lives on each record table as
--   state TEXT CHECK (state IN ('draft', 'confirmed')) plus confirmed_at.
-- A rejected draft is deleted; its last content survives as a
-- record_version with action 'reject'.

-- One row per API write call. A call may touch many records (household_meal
-- writes cooks and every member's portions); each touched record gets a
-- record_version pointing back here.
CREATE TABLE write_log (
  id                      INTEGER PRIMARY KEY,
  at                      TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', at) IS at),
  -- Who resolved the write: Hritvik's Claude Code session, a later hosted
  -- model, a member through the app, the one-time importer, or the system
  -- (the 48 h auto-confirm).
  resolver                TEXT    NOT NULL CHECK (resolver IN ('claude_code', 'hosted_model', 'member', 'importer', 'system')),
  resolver_detail         TEXT,
  actor_member_id         INTEGER REFERENCES member (id),
  -- The member the write concerns. NULL for household-level writes
  -- (catalogue, recipes).
  on_behalf_of_member_id  INTEGER REFERENCES member (id),
  origin                  TEXT    NOT NULL CHECK (origin IN ('live', 'coach', 'inbox', 'app', 'import', 'auto_confirm')),
  tool                    TEXT,
  reason                  TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  CHECK ((resolver = 'member') = (actor_member_id IS NOT NULL))
) STRICT;

CREATE INDEX write_log_on_behalf_of ON write_log (on_behalf_of_member_id, at);

-- Every write carries an idempotency key; a retry with the same key returns
-- the stored response instead of writing twice.
CREATE TABLE idempotency_key (
  key           TEXT    PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 200),
  tool          TEXT    NOT NULL CHECK (length(trim(tool)) > 0),
  request_hash  TEXT    NOT NULL CHECK (length(request_hash) > 0),
  write_id      INTEGER NOT NULL UNIQUE REFERENCES write_log (id),
  response      TEXT    NOT NULL CHECK (json_valid(response) AND json_type(response) = 'object'),
  created_at    TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at)
) STRICT;

-- amend(record, changes, reason) keeps every version. data is the full row
-- after the change (for 'reject' and 'delete', the row as it was).
CREATE TABLE record_version (
  id          INTEGER PRIMARY KEY,
  write_id    INTEGER NOT NULL REFERENCES write_log (id),
  table_name  TEXT    NOT NULL CHECK (table_name GLOB '[a-z]*' AND table_name NOT GLOB '*[^a-z_]*'),
  record_id   INTEGER NOT NULL,
  version     INTEGER NOT NULL CHECK (version >= 1),
  action      TEXT    NOT NULL CHECK (action IN ('create', 'amend', 'confirm', 'reject', 'delete')),
  data        TEXT    NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
  created_at  TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at),
  UNIQUE (table_name, record_id, version)
) STRICT;

-- Versioned prose about one member, or about one of their records (a target,
-- a prescription, a gym). member_id NULL makes it a household document, such
-- as Meal Prep.
CREATE TABLE member_note (
  id             INTEGER PRIMARY KEY,
  household_id   INTEGER NOT NULL REFERENCES household (id),
  member_id      INTEGER REFERENCES member (id),
  topic          TEXT    NOT NULL CHECK (length(trim(topic)) > 0),
  subject_table  TEXT    CHECK (subject_table IN (
                   'gym', 'implement', 'exercise', 'programme', 'session_template', 'prescription',
                   'phase', 'session', 'food_source', 'recipe', 'target', 'goal_point', 'flag',
                   'reading', 'blood_draw')),
  subject_id     INTEGER,
  created_at     TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at),
  CHECK ((subject_table IS NULL) = (subject_id IS NULL))
) STRICT;

CREATE INDEX member_note_member ON member_note (member_id);
CREATE INDEX member_note_subject ON member_note (subject_table, subject_id);

CREATE TABLE member_note_version (
  id          INTEGER PRIMARY KEY,
  note_id     INTEGER NOT NULL REFERENCES member_note (id),
  version     INTEGER NOT NULL CHECK (version >= 1),
  body        TEXT    NOT NULL CHECK (length(trim(body)) > 0),
  write_id    INTEGER NOT NULL REFERENCES write_log (id),
  created_at  TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at),
  UNIQUE (note_id, version)
) STRICT;

-- The 124 Agent Audit rows from Sheets, imported as history. Kept apart
-- from write_log because their time is often missing (not recorded) and
-- their fields are free text.
CREATE TABLE legacy_audit_entry (
  id           INTEGER PRIMARY KEY,
  source_file  TEXT    NOT NULL CHECK (source_file IN ('base', 'hritvik', 'asha', 'kabir')),
  member_id    INTEGER REFERENCES member (id),
  logged_on    TEXT    NOT NULL CHECK (date(logged_on) IS logged_on),
  -- NULL = not recorded in the sheet.
  logged_time  TEXT    CHECK (time(logged_time) IS logged_time),
  agent        TEXT,
  action       TEXT    NOT NULL,
  target       TEXT,
  reason       TEXT,
  prior_value  TEXT,
  result       TEXT
) STRICT;
