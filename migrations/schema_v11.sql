-- schema_v11: D1 read-quota remediation.
--
-- The account hit the 5M rows-read/day free-tier limit (2026-09-18).
-- Root causes fixed in code: per-minute trade-worker scans of the whole
-- signals table, NOT IN materialization of paper_trades, LOWER() joins,
-- uncached /api/status/colony GROUP BY, enrichment */2 cron + fan-out.
-- These indexes make the rewritten queries index-seek instead of
-- full-scan; signal_counts turns the colony status endpoint into a
-- 7-row read. Apply once — CREATE INDEX reads each table once.

-- Maintained by fly-brain DO _flush_signals upserts.
CREATE TABLE IF NOT EXISTS signal_counts (
  connectome_id TEXT PRIMARY KEY,
  total         INTEGER NOT NULL DEFAULT 0,
  last_signal   INTEGER
);

-- One-time backfill so the counter matches history.
INSERT OR REPLACE INTO signal_counts (connectome_id, total, last_signal)
  SELECT connectome_id, COUNT(*), MAX(created_at)
  FROM signals WHERE connectome_id IS NOT NULL GROUP BY connectome_id;

CREATE INDEX IF NOT EXISTS idx_signals_decision_created ON signals(decision, created_at);
CREATE INDEX IF NOT EXISTS idx_signals_conn_created     ON signals(connectome_id, created_at);
CREATE INDEX IF NOT EXISTS idx_paper_trades_signal      ON paper_trades(signal_id);
CREATE INDEX IF NOT EXISTS idx_paper_trades_created     ON paper_trades(created_at);
CREATE INDEX IF NOT EXISTS idx_positions_status         ON positions(status);
CREATE INDEX IF NOT EXISTS idx_colony_signals_created   ON colony_signals(created_at);
CREATE INDEX IF NOT EXISTS idx_training_data_closed     ON training_data(closed_at);
CREATE INDEX IF NOT EXISTS idx_tokens_score             ON tokens(ignored, score);
CREATE INDEX IF NOT EXISTS idx_governance_votes_decided ON governance_votes(decided_at);
CREATE INDEX IF NOT EXISTS idx_social_posts_posted      ON social_posts(posted_at);
