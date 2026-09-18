/**
 * FLYAI Treasury Page — reserve dashboard + treasury ops (RBS, POL, analytics).
 * Single-token system: treasury reserve assets back the FLYAI floor price.
 */
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { useApi, type TreasuryPoint, type Treasury, type OnchainTreasury, type Position, type Connectome } from "@/lib/flyai-api";

export function FlyaiTreasuryPage() {
  const { data: history } = useApi<TreasuryPoint[]>("/api/treasury/history", 15000);
  const { data: treasury } = useApi<Treasury>("/api/treasury", 10000);
  const { data: onchain } = useApi<OnchainTreasury>("/api/treasury/onchain", 15000);
  const { data: positions } = useApi<Position[]>("/api/positions", 5000);
  const { data: connectomes } = useApi<Connectome[]>("/api/connectomes", 5000);

  // Primary series is reserve USD; floor price overlays where available
  const priceHistory = (history ?? []).filter(p => p.reserve_usd > 0 || p.total_rfv > 0).slice().reverse().map(p => ({
    time: new Date(p.updated_at * 1000).toLocaleTimeString(),
    reserve: p.reserve_usd,
    rfv: p.total_rfv > 0 ? p.total_rfv : null,
    floor: (p.flyai_floor_price ?? 0) > 0 ? p.flyai_floor_price : null,
  })) ?? [];
  const hasFloorData = priceHistory.some(p => p.floor != null);

  // Aggregate connectome balances for treasury ops
  const totalConnectomeEquity = connectomes?.reduce((sum, c) => sum + (c.total_equity ?? c.balance_usd), 0) ?? 0;
  const totalConnectomePnl = connectomes?.reduce((sum, c) => sum + c.total_pnl + (c.unrealized_pnl ?? 0), 0) ?? 0;
  const totalTrades = connectomes?.reduce((sum, c) => sum + (c.n_trades || 0), 0) ?? 0;
  const activeConnectomes = connectomes?.filter(c => c.status === "active").length ?? 0;

  // Species distribution for pie chart
  const speciesData = connectomes?.reduce((acc: Record<string, number>, c) => {
    acc[c.species] = (acc[c.species] || 0) + c.balance_usd;
    return acc;
  }, {}) ?? {};
  const pieData = Object.entries(speciesData).map(([name, value]) => ({ name, value }));
  const PIE_COLORS = ["#6cf08a", "#3ed8ff", "#b07cff", "#ff5ad2", "#ffaa00", "#5a9bff", "#ff5a5a", "#9fb4c8"];



  return (
    <div className="min-h-screen bg-[#07090c] text-white">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <h1 className="font-mono text-2xl font-bold mb-2">Treasury</h1>
        <p className="text-gray-400 mb-6">Reserve assets backing the FLYAI token floor price. Treasury ops include range stability, protocol-owned liquidity, and connectome allocations.</p>

        {/* Stats grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <StatCard label="Reserve RFV" value={`$${(onchain?.rfv ?? treasury?.rfv ?? 0).toFixed(4)}`} />
          <StatCard label="FLYAI Floor Price" value={`$${(onchain?.floor_price ?? treasury?.floor_price ?? 0).toFixed(7)}`} />
          <StatCard label="ETH Deployed" value={treasury?.eth_deployed?.toFixed(4) ?? "—"} />
        </div>

        {/* On-chain treasury status */}
        {onchain && onchain.mode === "real" && (
          <div className="rounded-xl border border-emerald-900 bg-emerald-950/20 p-4 mb-8">
            <div className="flex items-center gap-2 mb-2">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="font-mono text-xs uppercase tracking-wider text-emerald-400">REAL TRADING MODE</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard label="On-Chain RFV" value={`$${onchain.rfv.toFixed(4)}`} />
              <StatCard label="On-Chain Floor" value={`$${onchain.floor_price.toFixed(7)}`} />
              <StatCard label="Treasury Contract" value={onchain.treasury_address ? `${onchain.treasury_address.slice(0, 8)}...` : "—"} />
            </div>
            {onchain.treasury_address && (
              <a href={`https://robinhoodchain.blockscout.com/address/${onchain.treasury_address}`} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-emerald-400 hover:text-emerald-300 mt-2 inline-block">
                View on Blockscout →
              </a>
            )}
          </div>
        )}
        {onchain && onchain.error && (
          <div className="rounded-xl border border-gray-800 bg-[#0a0d12] p-4 mb-8">
            <span className="font-mono text-xs text-gray-400">
              {onchain.error === "TREASURY_VALUATION not configured"
                ? "Paper mode — on-chain TreasuryValuation contract not yet deployed. Showing paper-trading treasury."
                : `On-chain treasury: ${onchain.error}`}
            </span>
          </div>
        )}

        {/* Treasury ops stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <StatCard label="Connectome Equity" value={`$${totalConnectomeEquity.toFixed(2)}`} />
          <StatCard label="Total P&L" value={`${totalConnectomePnl >= 0 ? "+" : ""}$${totalConnectomePnl.toFixed(4)}`} color={totalConnectomePnl >= 0 ? "text-emerald-400" : "text-red-400"} />
          <StatCard label="Total Trades" value={totalTrades.toString()} />
          <StatCard label="Active Connectomes" value={`${activeConnectomes}/7`} />
        </div>

        {/* Treasury history — reserve USD primary, RFV + floor overlay */}
        <section className="mb-8">
          <h2 className="font-mono text-sm uppercase tracking-wider text-gray-400 mb-3">Treasury History</h2>
          <div className="rounded-xl border border-gray-800 bg-[#0a0d12] p-4">
            {priceHistory.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={priceHistory}>
                  <defs>
                    <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#6cf08a" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#6cf08a" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="floorGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#ff5ad2" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#ff5ad2" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="time" tick={{ fill: "#8793a0", fontSize: 10 }} fontFamily="monospace" />
                  <YAxis yAxisId="bal" tick={{ fill: "#8793a0", fontSize: 10 }} fontFamily="monospace" domain={["auto", "auto"]} tickFormatter={(v) => `${v.toFixed(2)}`} />
                  {hasFloorData && <YAxis yAxisId="price" orientation="right" tick={{ fill: "#8793a0", fontSize: 10 }} fontFamily="monospace" domain={["dataMin", "dataMax"]} tickFormatter={(v) => `$${v.toFixed(6)}`} />}
                  <Tooltip contentStyle={{ background: "#0a0d12", border: "1px solid #333", borderRadius: "8px" }} labelStyle={{ color: "#8793a0" }} formatter={(v: any, name: any) => name === "Reserve USD" ? `$${Number(v).toFixed(4)}` : `$${Number(v).toFixed(7)}`} />
                  <Area yAxisId="bal" type="monotone" dataKey="reserve" stroke="#6cf08a" strokeWidth={2} fill="url(#priceGrad)" name="Reserve USD" />
                  {hasFloorData && <Area yAxisId="bal" type="monotone" dataKey="rfv" stroke="#3ed8ff" strokeWidth={1} fill="none" name="RFV" connectNulls />}
                  {hasFloorData && <Area yAxisId="price" type="monotone" dataKey="floor" stroke="#ff5ad2" strokeWidth={1} fill="url(#floorGrad)" name="FLYAI Floor" connectNulls />}
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-48 text-gray-500 text-sm font-mono">Loading treasury history...</div>
            )}
          </div>
        </section>

        {/* Two-column: positions + species allocation */}
        <div className="grid lg:grid-cols-2 gap-6 mb-8">
          {/* Open positions */}
          <section>
            <h2 className="font-mono text-sm uppercase tracking-wider text-gray-400 mb-3">Open Positions ({positions?.length ?? 0})</h2>
            <div className="rounded-xl border border-gray-800 bg-[#0a0d12] overflow-hidden">
              {positions && positions.length > 0 ? (
                <table className="w-full text-sm font-mono">
                  <thead>
                    <tr className="border-b border-gray-800 text-left text-gray-500">
                      <th className="px-4 py-3">Connectome</th>
                      <th className="px-4 py-3">Symbol</th>
                      <th className="px-4 py-3">Entry</th>
                      <th className="px-4 py-3">Current</th>
                      <th className="px-4 py-3">P&L %</th>
                      <th className="px-4 py-3">Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p: any, i) => (
                      <tr key={i} className="border-b border-gray-900">
                        <td className="px-4 py-3 text-gray-400">{p.connectome_id ?? "—"}</td>
                        <td className="px-4 py-3 font-bold">{p.symbol}</td>
                        <td className="px-4 py-3 text-gray-400">${p.entry_price.toFixed(6)}</td>
                        <td className="px-4 py-3 text-gray-400">{p.current_price ? `$${p.current_price.toFixed(6)}` : "—"}</td>
                        <td className={`px-4 py-3 ${p.pnl_percent >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {p.pnl_percent >= 0 ? "+" : ""}{p.pnl_percent.toFixed(2)}%
                        </td>
                        <td className="px-4 py-3">
                          {p.entry_tx && p.entry_tx.startsWith("0x") ? (
                            <a href={`https://robinhoodchain.blockscout.com/tx/${p.entry_tx}`} target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:text-emerald-300 text-xs">
                              view ↗
                            </a>
                          ) : (
                            <span className="text-gray-600 text-xs">paper</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex items-center justify-center h-32 text-gray-500 text-sm font-mono">No open positions</div>
              )}
            </div>
          </section>

          {/* Species allocation pie */}
          <section>
            <h2 className="font-mono text-sm uppercase tracking-wider text-gray-400 mb-3">Capital Allocation by Species</h2>
            <div className="rounded-xl border border-gray-800 bg-[#0a0d12] p-4">
              {pieData.length > 0 ? (
                <ResponsiveContainer width="100%" height={250}>
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={(e: any) => e.name}>
                      {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: "#0a0d12", border: "1px solid #333", borderRadius: "8px" }} formatter={(v: any) => `$${Number(v).toFixed(2)}`} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-48 text-gray-500 text-sm font-mono">Loading...</div>
              )}
            </div>
          </section>
        </div>

        {/* Connectome breakdown */}
        <section>
          <h2 className="font-mono text-sm uppercase tracking-wider text-gray-400 mb-3">Connectome Treasury Breakdown</h2>
          <div className="rounded-xl border border-gray-800 bg-[#0a0d12] overflow-hidden">
            <table className="w-full text-sm font-mono">
              <thead>
                <tr className="border-b border-gray-800 text-left text-gray-500">
                  <th className="px-4 py-3">Connectome</th>
                  <th className="px-4 py-3">Species</th>
                  <th className="px-4 py-3">Equity</th>
                  <th className="px-4 py-3">Unrealized</th>
                  <th className="px-4 py-3">P&L</th>
                  <th className="px-4 py-3">Trades</th>
                  <th className="px-4 py-3">Win Rate</th>
                </tr>
              </thead>
              <tbody>
                {connectomes?.map(c => {
                  const totalPnl = c.total_pnl + (c.unrealized_pnl ?? 0);
                  const pnlPct = c.starting_balance > 0 ? (totalPnl / c.starting_balance) * 100 : 0;
                  return (
                  <tr key={c.id} className="border-b border-gray-900">
                    <td className="px-4 py-3 font-bold">{c.id}</td>
                    <td className="px-4 py-3 text-gray-400">{c.species}</td>
                    <td className="px-4 py-3">${(c.total_equity ?? c.balance_usd).toFixed(4)}</td>
                    <td className={`px-4 py-3 ${(c.unrealized_pnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {(c.unrealized_pnl ?? 0) >= 0 ? "+" : ""}${(c.unrealized_pnl ?? 0).toFixed(4)}
                    </td>
                    <td className={`px-4 py-3 ${totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {totalPnl >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
                    </td>
                    <td className="px-4 py-3 text-gray-400">{c.n_trades || 0}</td>
                    <td className="px-4 py-3 text-gray-400">{((c.win_rate || 0) * 100).toFixed(0)}%</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-[#0a0d12] p-4">
      <div className="font-mono text-xs uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`font-mono text-lg mt-1 ${color ?? ""}`}>{value}</div>
    </div>
  );
}
