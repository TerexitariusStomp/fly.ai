export const idlFactory = ({ IDL }) => {
  const SnapshotRecord = IDL.Record({
    'signature' : IDL.Vec(IDL.Nat8),
    'version' : IDL.Nat64,
    'payload' : IDL.Text,
  });
  return IDL.Service({
    'hours_since_heartbeat' : IDL.Func(
        [IDL.Text],
        [IDL.Opt(IDL.Nat64)],
        ['query'],
      ),
    'last_heartbeat' : IDL.Func([IDL.Text], [IDL.Opt(IDL.Nat64)], ['query']),
    'latest_snapshot' : IDL.Func(
        [IDL.Text],
        [IDL.Opt(SnapshotRecord)],
        ['query'],
      ),
    'store_snapshot' : IDL.Func([IDL.Text, SnapshotRecord], [], []),
    'watchdog_heartbeat' : IDL.Func(
        [IDL.Text, IDL.Nat64, IDL.Vec(IDL.Nat8)],
        [],
        [],
      ),
  });
};
export const init = ({ IDL }) => { return []; };
