-- schema_v7: self-improving codebase loop — code-task outcomes + journal

ALTER TABLE code_tasks ADD COLUMN pr_number INTEGER;
ALTER TABLE code_tasks ADD COLUMN outcome TEXT;      -- merged|closed|rejected|gate_blocked|stale
ALTER TABLE code_tasks ADD COLUMN merged_at INTEGER;
ALTER TABLE code_tasks ADD COLUMN rationale TEXT;    -- ideator's reason for the task

CREATE TABLE IF NOT EXISTS code_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connectome_id TEXT NOT NULL,
  event TEXT NOT NULL,              -- ideated|proposed|reviewed|merged|rejected
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_code_journal_cid ON code_journal(connectome_id);

INSERT OR IGNORE INTO settings (key, value) VALUES ('code_enabled', 'true');
INSERT OR IGNORE INTO settings (key, value) VALUES ('code_max_per_day', '8');
