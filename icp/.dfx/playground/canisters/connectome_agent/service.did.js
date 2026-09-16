export const idlFactory = ({ IDL }) => {
  const AutonomyLevel = IDL.Variant({
    'sovereign' : IDL.Null,
    'earning' : IDL.Null,
    'new_' : IDL.Null,
    'established' : IDL.Null,
  });
  const EvolutionLogEntry = IDL.Record({
    'old_value' : IDL.Text,
    'connectome_id' : IDL.Text,
    'change_type' : IDL.Text,
    'timestamp' : IDL.Nat64,
    'new_value' : IDL.Text,
    'reason' : IDL.Text,
  });
  const PersonalityProfile = IDL.Record({
    'system_prompt' : IDL.Text,
    'name' : IDL.Text,
    'emoji' : IDL.Text,
    'style' : IDL.Text,
    'neuron_count' : IDL.Nat64,
    'catchphrases' : IDL.Vec(IDL.Text),
    'species' : IDL.Text,
  });
  const PostRecord = IDL.Record({
    'id' : IDL.Nat64,
    'connectome_id' : IDL.Text,
    'content' : IDL.Text,
    'post_type' : IDL.Nat8,
    'atproto_uri' : IDL.Opt(IDL.Text),
    'posted_at' : IDL.Opt(IDL.Nat64),
  });
  const StrategyParams = IDL.Record({
    'burn_pct' : IDL.Nat8,
    'max_tx_per_hour' : IDL.Nat32,
    'lp_enabled' : IDL.Bool,
    'treasury_gas_reserve' : IDL.Nat64,
    'risk_tolerance' : IDL.Nat8,
    'treasury_enabled' : IDL.Bool,
    'confidence_threshold' : IDL.Nat8,
    'airdrop_amount' : IDL.Nat64,
    'evolution_enabled' : IDL.Bool,
    'treasury_idle_threshold' : IDL.Nat64,
    'trade_size_pct' : IDL.Nat8,
    'tokenomics_enabled' : IDL.Bool,
    'lp_allocation' : IDL.Nat64,
    'trade_enabled' : IDL.Bool,
    'replication_burn_amount' : IDL.Nat,
    'max_drawdown_bps' : IDL.Nat64,
    'post_frequency_minutes' : IDL.Nat32,
  });
  const AtprotoCreds = IDL.Record({
    'handle' : IDL.Text,
    'app_password' : IDL.Text,
  });
  return IDL.Service({
    'cycle_runway_hours' : IDL.Func([], [IDL.Nat64], ['query']),
    'get_autonomy' : IDL.Func([IDL.Text], [AutonomyLevel], ['query']),
    'get_connectome_ids' : IDL.Func([], [IDL.Vec(IDL.Text)], ['query']),
    'get_evm_address' : IDL.Func(
        [IDL.Text],
        [IDL.Variant({ 'ok' : IDL.Text, 'err' : IDL.Text })],
        [],
      ),
    'get_evolution_log' : IDL.Func(
        [IDL.Nat64],
        [IDL.Vec(EvolutionLogEntry)],
        ['query'],
      ),
    'get_personality' : IDL.Func(
        [IDL.Text],
        [IDL.Opt(PersonalityProfile)],
        ['query'],
      ),
    'get_post_history' : IDL.Func(
        [IDL.Nat64],
        [IDL.Vec(PostRecord)],
        ['query'],
      ),
    'get_strategy_params' : IDL.Func(
        [IDL.Text],
        [IDL.Opt(StrategyParams)],
        ['query'],
      ),
    'http_request' : IDL.Func(
        [
          IDL.Record({
            'url' : IDL.Text,
            'method' : IDL.Text,
            'body' : IDL.Vec(IDL.Nat8),
            'headers' : IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
          }),
        ],
        [
          IDL.Record({
            'body' : IDL.Vec(IDL.Nat8),
            'headers' : IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
            'status_code' : IDL.Nat16,
          }),
        ],
        ['query'],
      ),
    'init_git_repo' : IDL.Func([IDL.Text], [], []),
    'register_connectome' : IDL.Func([IDL.Text], [], []),
    'register_personality' : IDL.Func([IDL.Text, PersonalityProfile], [], []),
    'set_admin' : IDL.Func([IDL.Principal], [], []),
    'set_atproto_credentials' : IDL.Func([IDL.Text, AtprotoCreds], [], []),
    'set_autonomy' : IDL.Func([IDL.Text, AutonomyLevel], [], []),
    'set_backup_canister' : IDL.Func([IDL.Text], [], []),
    'set_contracts' : IDL.Func(
        [
          IDL.Text,
          IDL.Text,
          IDL.Text,
          IDL.Text,
          IDL.Text,
          IDL.Text,
          IDL.Text,
          IDL.Text,
          IDL.Text,
          IDL.Text,
        ],
        [],
        [],
      ),
    'set_governor_address' : IDL.Func([IDL.Text], [], []),
    'set_llm_model' : IDL.Func([IDL.Text], [], []),
    'set_rpc_url' : IDL.Func([IDL.Text], [], []),
    'set_strategy_params' : IDL.Func([IDL.Text, StrategyParams], [], []),
    'trigger_full_cycle' : IDL.Func([], [], []),
  });
};
export const init = ({ IDL }) => { return []; };
