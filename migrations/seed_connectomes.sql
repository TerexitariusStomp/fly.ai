-- Seed D1 with the 7 governing connectomes + wallets (quorum: 3 of 7 on-chain)
-- Run: npx wrangler d1 execute shit-token --file=migrations/seed_connectomes.sql

-- === 7 Connectomes (real published data) ===
INSERT INTO connectomes (id, species, n_neurons, n_synapses, resolution, r2_weights_key, r2_meta_key, source, status, created_at) VALUES
  ('drosophila',    'D. melanogaster',   49,   1950, 'region-level',  'drosophila/weights.npz',     'drosophila/brain.npz',     'Chiang et al. 2011',     'active', 1694524800),
  ('rat',           'R. norvegicus',     73,   1923, 'region-level',  'rat/weights.npz',           'rat/brain.npz',           'Bota et al. 2015',       'active', 1694524800),
  ('mouse',         'M. musculus',       112,  6542, 'region-level',  'mouse/weights.npz',         'mouse/brain.npz',         'Rubinov et al. 2015',    'active', 1694524800),
  ('ciona',         'C. intestinalis',   205,  2902, 'single-neuron', 'ciona/weights.npz',         'ciona/brain.npz',         'Ryan et al. 2016',       'active', 1694524800),
  ('macaque_modha', 'M. mulatta',        242,  4090, 'region-level',  'macaque_modha/weights.npz', 'macaque_modha/brain.npz', 'Modha & Singh 2010',     'active', 1694524800),
  ('human',         'H. sapiens',        234,  7076, 'region-level',  'human/weights.npz',         'human/brain.npz',         'Griffa et al. 2019',     'active', 1694524800),
  ('celegans_male', 'C. elegans',        575,  5305, 'single-neuron', 'celegans_male/weights.npz', 'celegans_male/brain.npz', 'Cook et al. 2019 male',  'active', 1694524800);

-- === 7 Individual wallets + global + meta ===
INSERT INTO wallets (id, connectome_id, wallet_type, balance_usd, starting_balance, total_pnl, n_trades, n_wins, created_at) VALUES
  (1,  'drosophila',    'individual', 10.0, 10.0, 0.0, 0, 0, 1694524800),
  (2,  'rat',           'individual', 10.0, 10.0, 0.0, 0, 0, 1694524800),
  (3,  'mouse',         'individual', 10.0, 10.0, 0.0, 0, 0, 1694524800),
  (4,  'ciona',         'individual', 10.0, 10.0, 0.0, 0, 0, 1694524800),
  (5,  'macaque_modha', 'individual', 10.0, 10.0, 0.0, 0, 0, 1694524800),
  (6,  'human',         'individual', 10.0, 10.0, 0.0, 0, 0, 1694524800),
  (7,  'celegans_male', 'individual', 10.0, 10.0, 0.0, 0, 0, 1694524800),
  (8,  NULL,            'global',     50.0, 50.0, 0.0, 0, 0, 1694524800),
  (9,  NULL,            'meta',       50.0, 50.0, 0.0, 0, 0, 1694524800);

UPDATE connectomes SET wallet_id = 1 WHERE id = 'drosophila';
UPDATE connectomes SET wallet_id = 2 WHERE id = 'rat';
UPDATE connectomes SET wallet_id = 3 WHERE id = 'mouse';
UPDATE connectomes SET wallet_id = 4 WHERE id = 'ciona';
UPDATE connectomes SET wallet_id = 5 WHERE id = 'macaque_modha';
UPDATE connectomes SET wallet_id = 6 WHERE id = 'human';
UPDATE connectomes SET wallet_id = 7 WHERE id = 'celegans_male';
