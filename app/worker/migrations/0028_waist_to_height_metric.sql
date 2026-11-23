-- Migration number: 0028 	 2026-10-06
-- Waist:height as a goal metric (app display spec, option (b)): goal points
-- can be stored against it, so the Progress headline's 0.50 end target is
-- data, never a literal in the app.
--
-- It is a unitless ratio. Additive: a 'ratio' unit and the metric go in
-- under the existing dimensionless 'score' dimension, so neither the unit
-- nor the metric table is rebuilt (0020 rebuilt them before any data was
-- loaded; they now hold the household's readings). No reading is stored
-- against it: log_reading refuses it, because it is computed from the
-- waist and the stored height. Also: every goal point moves to its week's
-- Sunday (below).
INSERT INTO unit (code, dimension) VALUES ('ratio', 'score');
INSERT INTO metric (code, label, dimension) VALUES ('waist_to_height', 'Waist to height', 'score');

-- A goal point's week is its Sunday, the way the verdict reads weeks
-- (weekStart). The import stored goals on the sheet's own date, which can
-- be a Monday; move each back to its week's Sunday (strftime %w: 0 is
-- Sunday). goal_point has no uniqueness to collide with; one goal per
-- week per metric and tier is what the sheets held.
UPDATE goal_point SET week_of = date(week_of, '-' || strftime('%w', week_of) || ' days') WHERE strftime('%w', week_of) <> '0';
