-- Migration number: 0001 	 2026-10-05
-- Household and members.
--
-- Conventions for every migration in this directory:
--   * Every table is STRICT, so a text "35" never lands in a REAL column.
--   * Dates are ISO 'YYYY-MM-DD', checked with date(x) IS x (rejects 2026-02-30).
--   * Timestamps are UTC 'YYYY-MM-DDTHH:MM:SSZ', checked with strftime.
--   * Booleans are INTEGER 0/1.
--   * Enums, units and states are CHECKed here; rules that span rows or
--     tables live in the domain package, not in SQL.
--   * Derived values (totals, volume, e1RM, pace, averages) are never stored.

CREATE TABLE household (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  created_at  TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at)
) STRICT;

CREATE TABLE member (
  id                INTEGER PRIMARY KEY,
  household_id      INTEGER NOT NULL REFERENCES household (id),
  name              TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  -- Access identity: each member signs in with their own email.
  email             TEXT    NOT NULL UNIQUE COLLATE NOCASE CHECK (email LIKE '%_@_%'),
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  programming_mode  TEXT    NOT NULL CHECK (programming_mode IN ('prescribed', 'record_only')),
  sex               TEXT    CHECK (sex IN ('female', 'male')),
  birth_date        TEXT    CHECK (date(birth_date) IS birth_date),
  -- Training week is derived from this per-member anchor, never typed on rows.
  week_anchor_date  TEXT    CHECK (date(week_anchor_date) IS week_anchor_date),
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
                            CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at),
  UNIQUE (household_id, name)
) STRICT;
