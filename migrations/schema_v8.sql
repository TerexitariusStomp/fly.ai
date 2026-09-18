-- schema_v8: CF git remote is canonical — commit sha instead of PR
ALTER TABLE code_tasks ADD COLUMN commit_sha TEXT;
