-- Migration number: 0016 	 2026-10-06
-- The label energy check.
--
-- upsert_food_source and amend check that a food source's macros reconcile
-- with its stated energy (Atwater 4/4/9, within max(10%, 15 kcal)) and ask
-- when they don't. A source saved anyway carries the reason it was
-- accepted. NULL = never overridden (it reconciled when last checked, or
-- it predates the check).

ALTER TABLE food_source ADD COLUMN energy_override_reason TEXT
  CHECK (energy_override_reason IS NULL OR length(trim(energy_override_reason)) > 0);
