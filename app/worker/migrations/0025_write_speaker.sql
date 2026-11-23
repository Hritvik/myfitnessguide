-- Migration number: 0025 	 2026-10-06
-- The member the agent was talking with when it wrote (the call's
-- `speaker`), so "logged by" can name them instead of "the agent".
--
-- Additive: a nullable column, no rebuild. Filled for agent writes that
-- name a speaker; NULL for Inbox writes without one, member writes through
-- the app (actor_member_id already names them), the importer, the system,
-- and every write made before this migration (the speaker wasn't stored).
ALTER TABLE write_log ADD COLUMN speaker_member_id INTEGER REFERENCES member (id);
