-- SHIT Token D1 Schema
-- Cloudflare D1 (SQLite) — free tier: 5GB, 5M reads/day, 100K writes/day

-- Token discovery
CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT,
  chain TEXT DEFAULT 'arc',
  launchpad TEXT,
  pair_address TEXT,
  factory_address TEXT,
  creator_address TEXT,
  first_seen INTEGER NOT NULL,
  score REAL DEFAULT 0,
  score_reasons TEXT,
  enriched_at INTEGER,
  ignored INTEGER DEFAULT 0,
  risk_flags TEXT
);

-- Enrichment data (DexScreener, RugCheck, Etherscan, etc.)
CREATE TABLE IF NOT EXISTS enrichment (
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  data TEXT NOT NULL,
  enriched_at TEXT NOT NULL,
  PRIMARY KEY (chain, address)
);

-- Fly brain decisions
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  decision TEXT NOT NULL,
  confidence REAL DEFAULT 0,
  neural_activity TEXT,
  feature_snapshot TEXT,
  score REAL DEFAULT 0,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signals_token ON signals(token_address);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);

-- Positions
CREATE TABLE IF NOT EXISTS positions (
  token_address TEXT PRIMARY KEY,
  symbol TEXT,
  launchpad TEXT,
  entry_price REAL,
  entry_amount REAL,
  entry_tx TEXT,
  entry_at INTEGER,
  current_price REAL,
  pnl_percent REAL DEFAULT 0,
  status TEXT DEFAULT 'open',
  exit_price REAL,
  exit_tx TEXT,
  exit_at INTEGER,
  reserve_accumulated REAL DEFAULT 0
);

-- Trades (audit trail)
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  symbol TEXT,
  action TEXT NOT NULL,
  amount REAL,
  price REAL,
  tx_hash TEXT,
  profit REAL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token_address);
CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at DESC);

-- Treasury value tracking (reserve assets backing 5H1T)
CREATE TABLE IF NOT EXISTS treasury_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reserve_usd REAL,
  total_rfv REAL,
  shit_floor_price REAL,
  updated_at INTEGER NOT NULL
);

-- Audit log (all events)
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  data TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

-- Allowlist (tokens approved for trading)
CREATE TABLE IF NOT EXISTS allowlist (
  address TEXT PRIMARY KEY,
  symbol TEXT,
  added_at INTEGER NOT NULL,
  verified INTEGER DEFAULT 0
);

-- Settings (runtime config)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Connectome registry (the 7 governing brains)
CREATE TABLE IF NOT EXISTS connectomes (
  id TEXT PRIMARY KEY,               -- 'drosophila', 'rat', ...
  name TEXT,
  neuron_count INTEGER,
  wallet_id TEXT,
  status TEXT DEFAULT 'active',
  created_at INTEGER NOT NULL
);

-- Per-connectome wallets (paper balances until on-chain)
CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  connectome_id TEXT,
  address TEXT,
  balance_usd REAL DEFAULT 1.0,
  updated_at INTEGER NOT NULL
);

-- Paper trading ledger
CREATE TABLE IF NOT EXISTS paper_balance (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  balance REAL NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connectome_id TEXT,
  token_address TEXT,
  symbol TEXT,
  action TEXT NOT NULL,
  amount REAL,
  price REAL,
  profit REAL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Learned model versions (readout retrain history)
CREATE TABLE IF NOT EXISTS model_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connectome_id TEXT,
  version INTEGER,
  metrics TEXT,
  saved_at INTEGER NOT NULL
);

-- Per-trade training data (features + neural activity + outcome)
CREATE TABLE IF NOT EXISTS training_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connectome_id TEXT,
  token_address TEXT,
  features TEXT,
  neural_activity TEXT,
  outcome REAL,
  closed_at INTEGER NOT NULL
);

-- Per-connectome P&L reports
CREATE TABLE IF NOT EXISTS connectome_pnl_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connectome_id TEXT,
  period TEXT,
  pnl_usd REAL,
  trades INTEGER,
  win_rate REAL,
  reported_at INTEGER NOT NULL
);

-- Governance proposal queue (workers → on-chain governor)
CREATE TABLE IF NOT EXISTS proposals_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT,
  calldata TEXT,
  description TEXT,
  status TEXT DEFAULT 'pending',
  votes_for INTEGER DEFAULT 0,
  votes_against INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Social posts (what each connectome said, deduped)
CREATE TABLE IF NOT EXISTS social_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connectome_id TEXT NOT NULL,
  platform TEXT DEFAULT 'bluesky',
  text TEXT NOT NULL,
  atproto_uri TEXT,
  posted_at INTEGER,
  attempts INTEGER DEFAULT 0
);

-- Bluesky session cache (JWTs, refreshed on expiry)
CREATE TABLE IF NOT EXISTS bsky_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  did TEXT,
  handle TEXT,
  access_jwt TEXT,
  refresh_jwt TEXT,
  expires_at INTEGER
);

INSERT OR IGNORE INTO paper_balance (id, balance, updated_at) VALUES (1, 1.0, 0);
INSERT OR IGNORE INTO settings (key, value) VALUES ('profit_target_pct', '30');
INSERT OR IGNORE INTO settings (key, value) VALUES ('stop_loss_pct', '15');
INSERT OR IGNORE INTO settings (key, value) VALUES ('max_position_pct', '50');
INSERT OR IGNORE INTO settings (key, value) VALUES ('min_score_to_buy', '30');
INSERT OR IGNORE INTO connectomes (id, name, neuron_count, wallet_id, created_at) VALUES
  ('drosophila',     'Drosophila',     49,  'w-drosophila',     0),
  ('rat',            'Rat',            73,  'w-rat',            0),
  ('mouse',          'Mouse',          112, 'w-mouse',          0),
  ('ciona',          'Ciona',          205, 'w-ciona',          0),
  ('macaque_modha',  'Macaque Modha',  242, 'w-macaque_modha',  0),
  ('human',          'Human',          234, 'w-human',          0),
  ('celegans_male',  'C. elegans ♂',   575, 'w-celegans_male',  0);

-- Connectome weight blobs (R2 not enabled; weights are <200KB each)
CREATE TABLE IF NOT EXISTS weights (
  path TEXT PRIMARY KEY,             -- 'drosophila/weights.npz'
  data_b64 TEXT NOT NULL,            -- base64-encoded .npz
  size INTEGER,
  uploaded_at INTEGER NOT NULL
);
