-- Migration number: 0013 	 2026-10-06
-- Inferred reps.
--
-- A set reported in bulk ("done", "as prescribed") has the prescription's
-- reps, not reps anyone counted. The set says so, and the progression check
-- asks for one confirmation before a load moves on it (gymcalc's
-- needs_confirmation). Every existing set was reported, so the default is 0.

ALTER TABLE session_set ADD COLUMN reps_inferred INTEGER NOT NULL DEFAULT 0
  CHECK (reps_inferred IN (0, 1) AND (reps_inferred = 0 OR reps IS NOT NULL));
