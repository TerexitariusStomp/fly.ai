-- SHIT Token D1 Schema v4 — connectome-specific signals + Sharpe data
-- Adds connectome_id to signals table for per-brain neural activity tracking

-- Add connectome_id column to signals (NULL = legacy/global signal)
ALTER TABLE signals ADD COLUMN connectome_id TEXT;
CREATE INDEX IF NOT EXISTS idx_signals_connectome ON signals(connectome_id, created_at DESC);
