-- schema_v6: connectome code tasks — colony writes code, votes, opens PRs

CREATE TABLE IF NOT EXISTS code_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  file_path TEXT NOT NULL,
  repo TEXT,                        -- "owner/repo" (defaults to GITHUB_REPO)
  proposer TEXT NOT NULL,           -- connectome that wrote the patch
  new_content TEXT,                 -- full replacement file content
  status TEXT NOT NULL DEFAULT 'open',  -- open | approved | pr_open | gate_blocked | rejected
  pr_url TEXT,
  proposal_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_code_tasks_status ON code_tasks(status);
