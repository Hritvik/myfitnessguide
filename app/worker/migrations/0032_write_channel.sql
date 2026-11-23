-- The transport/execution channel is server-owned audit data, separate from
-- the model-supplied workflow origin. NULL means legacy/unknown during the
-- rolling deployment; there is deliberately no default.
ALTER TABLE write_log ADD COLUMN channel TEXT
  CHECK (channel IS NULL OR channel IN ('web', 'remote_mcp', 'local_agent', 'unattended', 'import'));

-- Only these historical writers identify their channel deterministically.
-- Member app writes predate the remote MCP, and old service-token agents could
-- run interactively or unattended under the same principal, so both remain
-- honestly unknown.
UPDATE write_log
SET channel = CASE
  WHEN resolver = 'importer' THEN 'import'
  WHEN resolver = 'system' THEN 'unattended'
END
WHERE resolver IN ('importer', 'system');
