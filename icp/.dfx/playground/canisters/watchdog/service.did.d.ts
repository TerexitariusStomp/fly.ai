import type { Principal } from '@icp-sdk/core/principal';
import type { ActorMethod } from '@icp-sdk/core/agent';
import type { IDL } from '@icp-sdk/core/candid';

export interface SnapshotRecord {
  'signature' : Uint8Array | number[],
  'version' : bigint,
  'payload' : string,
}
export interface _SERVICE {
  'hours_since_heartbeat' : ActorMethod<[string], [] | [bigint]>,
  'last_heartbeat' : ActorMethod<[string], [] | [bigint]>,
  'latest_snapshot' : ActorMethod<[string], [] | [SnapshotRecord]>,
  'store_snapshot' : ActorMethod<[string, SnapshotRecord], undefined>,
  'watchdog_heartbeat' : ActorMethod<
    [string, bigint, Uint8Array | number[]],
    undefined
  >,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
