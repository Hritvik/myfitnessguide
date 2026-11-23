-- Programme edits are immutable revisions: the old graph remains linked to
-- historical sessions and the active successor records why it replaced it.
ALTER TABLE programme ADD COLUMN supersedes_programme_id INTEGER REFERENCES programme (id);
ALTER TABLE programme ADD COLUMN superseded_at TEXT CHECK (superseded_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%SZ', superseded_at) IS superseded_at);
ALTER TABLE programme ADD COLUMN superseded_reason TEXT CHECK (
  (superseded_reason IS NULL) = (superseded_at IS NULL)
  AND (superseded_reason IS NULL OR length(trim(superseded_reason)) > 0)
);
ALTER TABLE programme ADD COLUMN archived_at TEXT CHECK (archived_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%SZ', archived_at) IS archived_at);
ALTER TABLE programme ADD COLUMN archived_reason TEXT CHECK (
  (archived_reason IS NULL) = (archived_at IS NULL)
  AND (archived_reason IS NULL OR length(trim(archived_reason)) > 0)
);

CREATE UNIQUE INDEX programme_one_successor ON programme (supersedes_programme_id) WHERE supersedes_programme_id IS NOT NULL;
CREATE INDEX programme_superseded_at ON programme (superseded_at) WHERE superseded_at IS NOT NULL;

CREATE TRIGGER programme_revision_same_member
BEFORE INSERT ON programme
WHEN NEW.supersedes_programme_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM programme predecessor
    WHERE predecessor.id = NEW.supersedes_programme_id
      AND predecessor.member_id = NEW.member_id
  )
BEGIN
  SELECT RAISE(ABORT, 'programme_revision_other_member');
END;

-- Phases are reversible records. Archived rows remain available for audit,
-- but only live rows participate in the member's timeline.
ALTER TABLE phase ADD COLUMN archived_at TEXT CHECK (archived_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%SZ', archived_at) IS archived_at);
ALTER TABLE phase ADD COLUMN archived_reason TEXT CHECK (
  (archived_reason IS NULL) = (archived_at IS NULL)
  AND (archived_reason IS NULL OR length(trim(archived_reason)) > 0)
);

CREATE INDEX phase_archived_at ON phase (archived_at) WHERE archived_at IS NOT NULL;

CREATE TRIGGER phase_live_no_overlap_insert
BEFORE INSERT ON phase
WHEN NEW.archived_at IS NULL
  AND NEW.energy_stance IN ('deficit', 'maintenance', 'surplus')
  AND date(NEW.starts_on) IS NEW.starts_on
  AND (NEW.ends_on IS NULL OR (date(NEW.ends_on) IS NEW.ends_on AND NEW.ends_on >= NEW.starts_on))
  AND EXISTS (
  SELECT 1 FROM phase existing
   WHERE existing.member_id = NEW.member_id
     AND existing.archived_at IS NULL
     AND existing.starts_on <= coalesce(NEW.ends_on, '9999-12-31')
     AND coalesce(existing.ends_on, '9999-12-31') >= NEW.starts_on
)
BEGIN
  SELECT RAISE(ABORT, 'phase_overlap');
END;

CREATE TRIGGER phase_live_no_overlap_update
BEFORE UPDATE OF member_id, starts_on, ends_on, archived_at ON phase
WHEN NEW.archived_at IS NULL
  AND NEW.energy_stance IN ('deficit', 'maintenance', 'surplus')
  AND date(NEW.starts_on) IS NEW.starts_on
  AND (NEW.ends_on IS NULL OR (date(NEW.ends_on) IS NEW.ends_on AND NEW.ends_on >= NEW.starts_on))
  AND EXISTS (
  SELECT 1 FROM phase existing
   WHERE existing.id <> NEW.id
     AND existing.member_id = NEW.member_id
     AND existing.archived_at IS NULL
     AND existing.starts_on <= coalesce(NEW.ends_on, '9999-12-31')
     AND coalesce(existing.ends_on, '9999-12-31') >= NEW.starts_on
)
BEGIN
  SELECT RAISE(ABORT, 'phase_overlap');
END;
