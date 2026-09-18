import { useEffect, useState } from "react";

/** fly.ai protocol dashboard — treasury, connectomes, governance, colony health.
 *  Data from api-worker (the Olympus-fork dashboard's backend), rendered inside the fly.ai shell. */

const API = (import.meta.env.VITE_PROTOCOL_API as string | undefined) ?? "https://api-worker.symbient.workers.dev";

type ColonyStatus = {
  ok: boolean; stale_connectomes: number;
  connectomes: Record<string, { last_signal: number | null; total_signals: number; stale: boolean }>;
  last_social_post: string | null; last_governance_vote: number | null;
  executor: string; executor_balance_eth: number | null; executor_low: boolean;
};

type Treasury = { rfv?: number; floor_price?: number; nav?: number; mode?: string };
type Connectome = { id: string; species: string; n_neurons: number; total_pnl?: number; n_trades?: number; sharpe?: number };
type Governance = { proposals?: { id: string; status: string; for_votes: number; against_votes: number }[]; quorum?: number };

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${API}${path}`);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}

const fmt = (n?: number | null, d = 4) => (n == null ? "—" : n.toFixed(d));
const usd = (n?: number | null) => (n == null ? "—" : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);

export default function Protocol() {
  const [colony, setColony] = useState<ColonyStatus | null>(null);
  const [treasury, setTreasury] = useState<Treasury | null>(null);
  const [connectomes, setConnectomes] = useState<Connectome[]>([]);
  const [gov, setGov] = useState<Governance | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      const [c, t, conn, g] = await Promise.all([
        fetchJson<ColonyStatus>("/api/status/colony"),
        fetchJson<Treasury>("/api/treasury/onchain"),
        fetchJson<Connectome[]>("/api/connectomes"),
        fetchJson<Governance>("/api/governance"),
      ]);
      if (!live) return;
      setColony(c); setTreasury(t); setConnectomes(Array.isArray(conn) ? conn : []); setGov(g);
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { live = false; clearInterval(t); };
  }, []);

  return (
    <div className="protocol">
      <h2>Protocol</h2>
      <p className="fine">
        The treasury behind $FLYAI — governed and traded by 7 biological connectomes.
        Quorum: 3 of 7 (≥1/3) for any protocol action.
      </p>

      <div className="proto-grid">
        <section className="proto-card">
          <h3>Treasury</h3>
          {treasury ? (
            <>
              <div className="proto-row"><span>RFV</span><b>{usd(treasury.rfv)}</b></div>
              <div className="proto-row"><span>Floor price</span><b>{fmt(treasury.floor_price, 6)}</b></div>
              <div className="proto-row"><span>NAV</span><b>{usd(treasury.nav)}</b></div>
              <div className="proto-row"><span>Mode</span><b>{treasury.mode ?? "—"}</b></div>
            </>
          ) : <p className="fine">Treasury data unavailable.</p>}
        </section>

        <section className="proto-card">
          <h3>Colony health</h3>
          {colony ? (
            <>
              <div className="proto-row">
                <span>Connectomes ticking</span>
                <b className={colony.ok ? "good" : "bad"}>{7 - colony.stale_connectomes}/7</b>
              </div>
              <div className="proto-row">
                <span>Executor gas</span>
                <b className={colony.executor_low ? "bad" : "good"}>
                  {fmt(colony.executor_balance_eth, 5)} ETH{colony.executor_low ? " (low)" : ""}
                </b>
              </div>
              <div className="proto-row"><span>Last gov vote</span><b>{colony.last_governance_vote ? new Date(colony.last_governance_vote * 1000).toLocaleString() : "—"}</b></div>
              <div className="proto-row"><span>Last social post</span><b>{colony.last_social_post ?? "—"}</b></div>
            </>
          ) : <p className="fine">Colony status unavailable.</p>}
        </section>

        <section className="proto-card wide">
          <h3>Connectomes</h3>
          <table className="proto-table">
            <thead><tr><th>Connectome</th><th>Neurons</th><th>Signals</th><th>Trades</th><th>P&amp;L</th><th>Status</th></tr></thead>
            <tbody>
              {connectomes.map((c) => {
                const st = colony?.connectomes[c.id];
                return (
                  <tr key={c.id}>
                    <td>{c.id} <span className="fine">({c.species})</span></td>
                    <td>{c.n_neurons}</td>
                    <td>{st?.total_signals ?? "—"}</td>
                    <td>{c.n_trades ?? "—"}</td>
                    <td className={(c.total_pnl ?? 0) >= 0 ? "good" : "bad"}>{usd(c.total_pnl)}</td>
                    <td><span className={`dot ${st?.stale === false ? "on" : "off"}`} />{st?.stale === false ? "live" : "stale"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="proto-card wide">
          <h3>Governance</h3>
          {gov?.proposals?.length ? (
            <table className="proto-table">
              <thead><tr><th>Proposal</th><th>For</th><th>Against</th><th>Status</th></tr></thead>
              <tbody>
                {gov.proposals.slice(0, 10).map((p) => (
                  <tr key={p.id}>
                    <td className="fine mono">{p.id.slice(0, 12)}…</td>
                    <td className="good">{p.for_votes}</td>
                    <td className="bad">{p.against_votes}</td>
                    <td>{p.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="fine">No proposals yet.</p>}
        </section>
      </div>
    </div>
  );
}
