CREATE TABLE IF NOT EXISTS patches (id text primary key, name text not null, blurb text not null default '', event_mix text not null, created_at text not null default (datetime('now')));

CREATE TABLE IF NOT EXISTS profiles (id text primary key, wallet text unique, created_at text not null default (datetime('now')));

CREATE TABLE IF NOT EXISTS flies (id text primary key default (lower(hex(randomblob(16)))), owner text , name text not null unique , color text not null default '#e0342c', patch_id text not null , senses text not null default '{}', temperament text not null default '{}', dials text not null default '{}', wiring_variant text not null default 'male-cns-v1.0', seed int not null default 0, created_at text not null default (datetime('now')));

CREATE TABLE IF NOT EXISTS ticks (id integer primary key, started_at text not null default (datetime('now')), finished_at text, git_sha text, config text not null, translator text not null, flies int not null default 0, posts int not null default 0, seconds real);

CREATE TABLE IF NOT EXISTS posts (id integer primary key, tick_id bigint not null , fly_id text not null , patch_id text not null , word text not null, confidence real not null, truth text not null, correct integer generated always as (word = truth) stored, wing_hz real, neurons text not null default '[]', created_at text not null default (datetime('now')));

CREATE TABLE IF NOT EXISTS reactions (id integer primary key, post_id bigint not null , fly_id text not null , kind text not null , z text not null default '{}', created_at text not null default (datetime('now')));

CREATE TABLE IF NOT EXISTS threads (parent_post bigint not null , child_post bigint not null , cause text not null, primary key (parent_post, child_post));

CREATE TABLE IF NOT EXISTS captions (post_id bigint primary key , author text not null , body text not null , created_at text not null default (datetime('now')));

CREATE TABLE IF NOT EXISTS likes (post_id bigint not null , user_id text not null , created_at text not null default (datetime('now')), primary key (post_id, user_id));

CREATE TABLE IF NOT EXISTS pokes (id integer primary key, patch_id text not null , stimulus text not null , user_id text not null , created_at text not null default (datetime('now')), consumed_at text, tick_id bigint);

CREATE TABLE IF NOT EXISTS comments (id integer primary key, post_id bigint not null , user_id text not null , wallet_short text not null, body text not null , created_at text not null default (datetime('now')));

CREATE TABLE IF NOT EXISTS duels (id integer primary key, kind text not null , a_fly text not null , b_fly text not null , requested_by text , status text not null default 'pending' , winner text , a_step int, b_step int, a_elo int, b_elo int, delta int, replay text, created_at text not null default (datetime('now')), done_at text);

CREATE TABLE IF NOT EXISTS matings (id integer primary key, a_fly text , b_fly text , child text , owner text , trigger text not null , created_at text not null default (datetime('now')));

CREATE TABLE IF NOT EXISTS memes (id integer primary key, user_id text not null , fly_id text not null , post_id bigint , style text not null, idea text , top_text text not null, bottom_text text not null, image_path text not null, model text not null, cost real, hidden integer not null default 0, created_at text not null default (datetime('now')));

CREATE TABLE IF NOT EXISTS meme_likes (meme_id bigint not null , user_id text not null , by_holder integer not null default 0, created_at text not null default (datetime('now')), primary key (meme_id, user_id));

CREATE TABLE IF NOT EXISTS meme_reports (meme_id bigint not null , user_id text not null , reason text , created_at text not null default (datetime('now')), primary key (meme_id, user_id));

CREATE TABLE IF NOT EXISTS market_coins (symbol text primary key, name text not null, kind text not null , price real not null , regime text not null default 'calm' , updated_at text not null default (datetime('now')));

CREATE TABLE IF NOT EXISTS market_rounds (id integer primary key, started_at text not null default (datetime('now')), prices text not null, events text not null default '[]', traders int not null default 0, trades int not null default 0, seconds real);

CREATE TABLE IF NOT EXISTS fly_portfolios (fly_id text primary key , eth real not null default 1, holdings text not null default '{}', start_eth real not null default 1, value_eth real not null default 1, trades int not null default 0, updated_at text not null default (datetime('now')));

CREATE TABLE IF NOT EXISTS fly_trades (id integer primary key, round_id bigint , fly_id text not null , symbol text not null, side text not null , qty real not null, price real not null, eth real not null, reason text not null default '{}', value_after real not null, created_at text not null default (datetime('now')));

CREATE TABLE IF NOT EXISTS fly_minds (fly_id text primary key , traits text not null default '{}', learned text not null default '{}', memory text not null default '[]', tubes text not null default '{}', inherit text not null default 'partial' , stats text not null default '{}', parents text[] not null default '{}', learning text not null default '{"dopamine": true, "memory": true, "tubes": true}', updated_at text not null default (datetime('now')));

CREATE TABLE IF NOT EXISTS market_control (id int primary key default 1 , paused integer not null default 0, note text, updated_at text not null default (datetime('now')));

CREATE TABLE IF NOT EXISTS market_social (id integer primary key, round_id bigint , fly_id text , kind text not null , symbol text not null, reach int not null default 0, detail text not null default '{}', created_at text not null default (datetime('now')));

CREATE TABLE IF NOT EXISTS world_runs (id text primary key default (lower(hex(randomblob(16)))), seed integer not null, started_at text not null default (datetime('now')), git_sha text, config text not null default '{}');

CREATE TABLE IF NOT EXISTS world_seconds (id integer primary key, run_id text not null , t real not null, at text not null default (datetime('now')), row text not null);

CREATE TABLE IF NOT EXISTS world_fly_samples (id integer primary key, run_id text not null , t real not null, fly_id integer not null, at text not null default (datetime('now')), row text not null);

CREATE TABLE IF NOT EXISTS world_events (id integer primary key, run_id text not null , t real not null, kind text not null, at text not null default (datetime('now')), row text not null);

CREATE TABLE IF NOT EXISTS world_lineage (run_id text not null , fly_id integer not null, updated_at text not null default (datetime('now')), row text not null, primary key (run_id, fly_id));

CREATE TABLE IF NOT EXISTS world_eggs (run_id text not null , egg_id integer not null, updated_at text not null default (datetime('now')), row text not null, primary key (run_id, egg_id));

CREATE TABLE IF NOT EXISTS world_relationships (run_id text not null , a integer not null, b integer not null, label text, updated_at text not null default (datetime('now')), row text not null, primary key (run_id, a, b));

CREATE TABLE IF NOT EXISTS world_checkpoints (id integer primary key, run_id text not null , t real not null, bytes integer not null, created_at text not null default (datetime('now')), data text not null);
-- our additions: SIWE sessions, nonces, burn-gated flies
CREATE TABLE IF NOT EXISTS sessions (
  token text primary key,
  wallet text not null,
  expires_at text not null
);
CREATE TABLE IF NOT EXISTS nonces (
  nonce text primary key,
  wallet text not null,
  created_at text not null
);
-- burned FLYAI per fly + launch tracking
ALTER TABLE flies ADD COLUMN burned real not null default 0;
ALTER TABLE flies ADD COLUMN burn_tx text;
ALTER TABLE flies ADD COLUMN auto_born integer not null default 0;
ALTER TABLE flies ADD COLUMN governor_eligible integer not null default 0;
-- fly-launched tokens as persistent treasury assets
CREATE TABLE IF NOT EXISTS treasury_assets (
  token_address text primary key,
  symbol text not null,
  name text,
  launched_by_fly text,
  launch_tx text,
  pool text,
  persistent integer not null default 1,
  created_at text not null default (datetime('now'))
);
-- brain→brain colony signals (flytalk port)
CREATE TABLE IF NOT EXISTS colony_signals (
  id integer primary key,
  from_fly text not null,
  kind text not null,           -- 'action' | 'word' | 'trade'
  envelope text not null,        -- spike-envelope or decoded signal
  strength real not null default 1,
  tick integer,
  created_at text not null default (datetime('now'))
);
