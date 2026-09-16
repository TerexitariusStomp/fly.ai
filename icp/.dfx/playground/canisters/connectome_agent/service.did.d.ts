import type { Principal } from '@icp-sdk/core/principal';
import type { ActorMethod } from '@icp-sdk/core/agent';
import type { IDL } from '@icp-sdk/core/candid';

export interface AtprotoCreds { 'handle' : string, 'app_password' : string }
export type AutonomyLevel = { 'sovereign' : null } |
  { 'earning' : null } |
  { 'new_' : null } |
  { 'established' : null };
export interface EvolutionLogEntry {
  'old_value' : string,
  'connectome_id' : string,
  'change_type' : string,
  'timestamp' : bigint,
  'new_value' : string,
  'reason' : string,
}
export interface PersonalityProfile {
  'system_prompt' : string,
  'name' : string,
  'emoji' : string,
  'style' : string,
  'neuron_count' : bigint,
  'catchphrases' : Array<string>,
  'species' : string,
}
export interface PostRecord {
  'id' : bigint,
  'connectome_id' : string,
  'content' : string,
  'post_type' : number,
  'atproto_uri' : [] | [string],
  'posted_at' : [] | [bigint],
}
export interface StrategyParams {
  'burn_pct' : number,
  'max_tx_per_hour' : number,
  'lp_enabled' : boolean,
  'treasury_gas_reserve' : bigint,
  'risk_tolerance' : number,
  'treasury_enabled' : boolean,
  'confidence_threshold' : number,
  'airdrop_amount' : bigint,
  'evolution_enabled' : boolean,
  'treasury_idle_threshold' : bigint,
  'trade_size_pct' : number,
  'tokenomics_enabled' : boolean,
  'lp_allocation' : bigint,
  'trade_enabled' : boolean,
  'replication_burn_amount' : bigint,
  'max_drawdown_bps' : bigint,
  'post_frequency_minutes' : number,
}
export interface _SERVICE {
  'cycle_runway_hours' : ActorMethod<[], bigint>,
  'get_autonomy' : ActorMethod<[string], AutonomyLevel>,
  'get_connectome_ids' : ActorMethod<[], Array<string>>,
  'get_evm_address' : ActorMethod<
    [string],
    { 'ok' : string } |
      { 'err' : string }
  >,
  'get_evolution_log' : ActorMethod<[bigint], Array<EvolutionLogEntry>>,
  /**
   * Queries
   */
  'get_personality' : ActorMethod<[string], [] | [PersonalityProfile]>,
  'get_post_history' : ActorMethod<[bigint], Array<PostRecord>>,
  'get_strategy_params' : ActorMethod<[string], [] | [StrategyParams]>,
  'http_request' : ActorMethod<
    [
      {
        'url' : string,
        'method' : string,
        'body' : Uint8Array | number[],
        'headers' : Array<[string, string]>,
      },
    ],
    {
      'body' : Uint8Array | number[],
      'headers' : Array<[string, string]>,
      'status_code' : number,
    }
  >,
  'init_git_repo' : ActorMethod<[string], undefined>,
  'register_connectome' : ActorMethod<[string], undefined>,
  'register_personality' : ActorMethod<[string, PersonalityProfile], undefined>,
  /**
   * Admin
   */
  'set_admin' : ActorMethod<[Principal], undefined>,
  'set_atproto_credentials' : ActorMethod<[string, AtprotoCreds], undefined>,
  'set_autonomy' : ActorMethod<[string, AutonomyLevel], undefined>,
  'set_backup_canister' : ActorMethod<[string], undefined>,
  'set_contracts' : ActorMethod<
    [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ],
    undefined
  >,
  'set_governor_address' : ActorMethod<[string], undefined>,
  'set_llm_model' : ActorMethod<[string], undefined>,
  'set_rpc_url' : ActorMethod<[string], undefined>,
  'set_strategy_params' : ActorMethod<[string, StrategyParams], undefined>,
  /**
   * Ops
   */
  'trigger_full_cycle' : ActorMethod<[], undefined>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
