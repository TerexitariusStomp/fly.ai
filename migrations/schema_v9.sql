-- schema_v9: D1 git store — colony's canonical repo (dumb-HTTP served)
CREATE TABLE IF NOT EXISTS git_files (
  path TEXT PRIMARY KEY,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_git_files_prefix ON git_files(path);
