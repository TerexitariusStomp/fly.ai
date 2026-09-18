-- schema_v10: align live D1 with connectome/wallet API expectations
-- The live DB predates parts of schema_v3 while later columns were added.
-- Keep existing text wallet IDs; only add the missing columns and backfill.

ALTER TABLE connectomes ADD COLUMN source TEXT;
UPDATE connectomes SET source = 'Chiang et al. 2011' WHERE id = 'drosophila';
UPDATE connectomes SET source = 'Bota et al. 2015' WHERE id = 'rat';
UPDATE connectomes SET source = 'Rubinov et al. 2015' WHERE id = 'mouse';
UPDATE connectomes SET source = 'Ryan et al. 2016' WHERE id = 'ciona';
UPDATE connectomes SET source = 'Modha & Singh 2010' WHERE id = 'macaque_modha';
UPDATE connectomes SET source = 'Griffa et al. 2019' WHERE id = 'human';
UPDATE connectomes SET source = 'Cook et al. 2019 male' WHERE id = 'celegans_male';

ALTER TABLE wallets ADD COLUMN wallet_type TEXT;
ALTER TABLE wallets ADD COLUMN starting_balance REAL DEFAULT 1.0;
ALTER TABLE wallets ADD COLUMN status TEXT DEFAULT 'active';
ALTER TABLE wallets ADD COLUMN created_at INTEGER;
UPDATE wallets SET wallet_type = 'individual' WHERE connectome_id IS NOT NULL;
UPDATE wallets SET starting_balance = 1.0 WHERE starting_balance IS NULL;
UPDATE wallets SET status = 'active' WHERE status IS NULL;
UPDATE wallets SET created_at = COALESCE(updated_at, 0) WHERE created_at IS NULL;

ALTER TABLE connectome_pnl_reports ADD COLUMN epoch INTEGER;
ALTER TABLE connectome_pnl_reports ADD COLUMN pnl_percent REAL;
ALTER TABLE connectome_pnl_reports ADD COLUMN cumulative_pnl REAL;
ALTER TABLE connectome_pnl_reports ADD COLUMN n_trades INTEGER;
ALTER TABLE connectome_pnl_reports ADD COLUMN tx_hash TEXT;
UPDATE connectome_pnl_reports
SET epoch = COALESCE(epoch, id),
    pnl_percent = COALESCE(pnl_percent, pnl_usd, 0),
    cumulative_pnl = COALESCE(cumulative_pnl, pnl_usd, 0),
    n_trades = COALESCE(n_trades, trades, 0);

ALTER TABLE training_data ADD COLUMN signal_id INTEGER;
ALTER TABLE training_data ADD COLUMN entry_price REAL;
ALTER TABLE training_data ADD COLUMN exit_price REAL;
ALTER TABLE training_data ADD COLUMN pnl_percent REAL;
ALTER TABLE training_data ADD COLUMN hold_time_seconds INTEGER;
ALTER TABLE training_data ADD COLUMN signal_created_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_training_outcome ON training_data(outcome);
CREATE INDEX IF NOT EXISTS idx_training_signal ON training_data(signal_id);

UPDATE connectomes
SET wallet_id = (SELECT id FROM wallets WHERE wallets.connectome_id = connectomes.id)
WHERE EXISTS (SELECT 1 FROM wallets WHERE wallets.connectome_id = connectomes.id);
