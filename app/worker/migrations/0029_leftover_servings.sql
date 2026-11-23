-- Migration number: 0029 	 2026-10-06
-- Leftover servings (app display spec §7, Hritvik's option (a)): a later
-- helping of a cook's leftover is its own record, dated the day it was
-- eaten, so a member who had a portion can still eat the leftover (the
-- one-portion-per-member rule, portion's UNIQUE (component_id, member_id),
-- stays). The cook's remainder is portions + servings.
--
-- Additive: a new table, two nullable columns, three indexes. Nothing is
-- rebuilt and no existing row changes.

CREATE TABLE leftover_serving (
  id            INTEGER PRIMARY KEY,
  component_id  INTEGER NOT NULL REFERENCES component (id),
  member_id     INTEGER NOT NULL REFERENCES member (id),
  kind          TEXT    NOT NULL CHECK (kind IN ('fraction', 'weighed')),
  fraction      REAL    CHECK (fraction > 0 AND fraction <= 1),
  weighed_g     REAL    CHECK (weighed_g > 0),
  eaten_on      TEXT    NOT NULL CHECK (date(eaten_on) IS eaten_on),
  provenance    TEXT    NOT NULL CHECK (provenance IN (
                  'weighed', 'counted', 'label', 'estimated', 'inferred', 'reconstructed')),
  state         TEXT    NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'confirmed')),
  confirmed_at  TEXT    CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', confirmed_at) IS confirmed_at),
  CHECK ((kind = 'fraction') = (fraction IS NOT NULL)),
  CHECK ((kind = 'weighed') = (weighed_g IS NOT NULL)),
  CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL))
) STRICT;

CREATE INDEX leftover_serving_by_component ON leftover_serving (component_id);

-- A serving's intake item. source_kind can't gain a kind without rebuilding
-- intake_item, so the item is 'manual' (its macros, written with it, satisfy
-- the item's checks) and linked here; readers compute it from the serving.
ALTER TABLE intake_item ADD COLUMN leftover_serving_id INTEGER REFERENCES leftover_serving (id);
CREATE UNIQUE INDEX intake_item_by_leftover_serving ON intake_item (leftover_serving_id) WHERE leftover_serving_id IS NOT NULL;

-- The day a leftover was eaten up or discarded: the household's
-- open-leftover read stays bounded to what is still in the fridge.
ALTER TABLE remainder_disposition ADD COLUMN settled_on TEXT CHECK (settled_on IS NULL OR date(settled_on) IS settled_on);
CREATE INDEX remainder_disposition_open ON remainder_disposition (disposition, settled_on, recorded_on);
