-- SHIT Token D1 Schema v5 — YES/NO prediction sides + query indexes
-- Adds side column to user_prediction_bets so users can pick YES or NO
-- on each connectome (not just "which brain wins")

ALTER TABLE user_prediction_bets ADD COLUMN side TEXT DEFAULT 'yes';
CREATE INDEX IF NOT EXISTS idx_pred_side ON user_prediction_bets(round_id, connectome_id, side);

-- Critical for D1 free-tier read limits: the fly-brain DOs run
-- "WHERE ignored = 0 AND score > 30 ORDER BY score DESC LIMIT 3"
-- every minute × 7 connectomes. Without this index each scan reads
-- the whole tokens table (millions of row-reads/day).
CREATE INDEX IF NOT EXISTS idx_tokens_score ON tokens(ignored, score DESC);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
-- trade-worker anti-join + cooldown lookups run every minute
CREATE INDEX IF NOT EXISTS idx_paper_trades_signal ON paper_trades(signal_id);
CREATE INDEX IF NOT EXISTS idx_paper_trades_token ON paper_trades(token_address, connectome_id, created_at DESC);
