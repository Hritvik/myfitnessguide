-- Migration number: 0024 	 2026-10-06
-- record_version.action gains 'retract': a confirmed (or draft) record the
-- member says should not exist (a duplicate, a wrong day) is deleted, and
-- its last content kept as a version, the way 'reject' keeps a draft's.
--
-- SQLite can't change a CHECK in place, so the table is rebuilt with every
-- row copied. Nothing references record_version (it references write_log),
-- so the rebuild needs no foreign-key deferral.
CREATE TABLE record_version_new (
  id          INTEGER PRIMARY KEY,
  write_id    INTEGER NOT NULL REFERENCES write_log (id),
  table_name  TEXT    NOT NULL CHECK (table_name GLOB '[a-z]*' AND table_name NOT GLOB '*[^a-z_]*'),
  record_id   INTEGER NOT NULL,
  version     INTEGER NOT NULL CHECK (version >= 1),
  action      TEXT    NOT NULL CHECK (action IN ('create', 'amend', 'confirm', 'reject', 'delete', 'retract')),
  data        TEXT    NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
  created_at  TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at),
  UNIQUE (table_name, record_id, version)
) STRICT;

INSERT INTO record_version_new (id, write_id, table_name, record_id, version, action, data, created_at)
SELECT id, write_id, table_name, record_id, version, action, data, created_at FROM record_version;

DROP TABLE record_version;
ALTER TABLE record_version_new RENAME TO record_version;
