ALTER TABLE recipe ADD COLUMN archived_at TEXT CHECK (archived_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%SZ', archived_at) IS archived_at);
ALTER TABLE recipe ADD COLUMN archived_reason TEXT CHECK (archived_reason IS NULL OR length(trim(archived_reason)) > 0);

ALTER TABLE workout ADD COLUMN archived_at TEXT CHECK (archived_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%SZ', archived_at) IS archived_at);
ALTER TABLE workout ADD COLUMN archived_reason TEXT CHECK (archived_reason IS NULL OR length(trim(archived_reason)) > 0);
