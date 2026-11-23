-- Migration number: 0038 	 2026-10-30
-- Equipment leaves: a piece sold, moved or out of service is retired rather
-- than deleted, so its loads, logged sets and prescriptions keep their
-- history. `archived_at` NULL means in service; `archived_reason` is the
-- member's own words, kept in the record's history by the write log too.
ALTER TABLE implement ADD COLUMN archived_at TEXT;
ALTER TABLE implement ADD COLUMN archived_reason TEXT;
