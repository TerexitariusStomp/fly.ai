# FLYAI — Treasury-Backed Token Governed by Biological Connectomes

FLYAI is a single-token, treasury-backed protocol on **Robinhood Chain** (mainnet `4663`, testnet `46630`). The primary token is FLYAI (fly.ai) at `0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C`. The protocol is an Olympus V3 fork (Kernel / Modules / Policies / Heart / RBS) where a set of **7 real biological connectomes** — running on-chain LIF (leaky integrate-and-fire) inference via `FlyEngine` — collectively operate the entire protocol: they own the kernel executor, control the treasury, and manage the buyback floor.

```
                    ┌────────────────────────────────────────┐
                    │      ConnectomeGovernor (UUPS)         │
                    │  propose → vote → execute              │
                    │  quorum: 3 of 7 (≥1/3 consensus)       │
                    │  votes = on-chain LIF inference        │
                    └──────────────────┬─────────────────────┘
                                       │
                    ┌──────────────────▼─────────────────────┐
                    │         GovernorPolicy                 │
                    │  executeModule(target, calldata)       │
                    │  approveToken() — fund buyback float   │
                    └──────────────────┬─────────────────────┘
        ┌──────────────────┬───────────┼──────────────┬─────────────────┐
        ▼                  ▼           ▼              ▼                 ▼
   Olympus Kernel    TreasuryAllocator   ArcLaunchpadAdapter    SymbientInverseBond
   MINTR/TRSRY/      (Yearn-style        (whitelisted tokens,   (buyback at
   PRICE/RANGE        strategy targets,   bounded keeper        floor × 0.985,
   + Heart            rebalances)         trades)               burns FLYAI)
        │
        ▼
   TreasuryValuation ◄── SymbientCircuitBreaker (trips when spot < floor × 0.98)
   RFV / NAV / floorPrice
```

## The 7 connectomes

| ID | Neurons | Source |
|---|---|---|
| drosophila | 49 | FlyWire / fruit fly |
| rat | 73 | |
| mouse | 112 | |
| ciona | 205 | Ryan et al. 2016 |
| macaque_modha | 242 | |
| human | 234 | |
| celegans_male | 575 | C. elegans male |

Each connectome's synaptic weights are stored on-chain via SSTORE2 chunks and registered in `FlyEngine`. A governance vote calls `FlyEngine.analyze(connectomeId, market, maxSteps)` — the LIF simulation's output action is the vote: `+1` for, `−1` against, `0` abstain. Pass requires ≥3 of 7 for-votes and for > against.

## Governance model

The connectomes control the whole protocol, but only vote on **policy-level** decisions — routine operations run autonomously inside approved bounds.

**Voted on (infrequent):** token whitelists, trade/position bounds, strategy registrations and allocations, risk parameters, buyback spread/capacity, valuation haircuts, Olympus module parameters (RANGE spreads, TRSRY approvals, MINTR issuance), emergency actions, kernel installs/upgrades, float funding.

**Autonomous (no vote):** heart beats and rebases, keeper trades within bounds, rebalances/harvests, buybacks within epoch capacity, permissionless circuit-breaker checks.

## Tokenomics

- **FLYAI** — the only token. Rebasing staking via `stFLYAI` (`SymbientStaking`), non-rebasing wrapper `wstFLYAI`.
- **Partial backing** — `TreasuryValuation` computes RFV (risk-free value with per-asset haircuts) and `floorPrice = RFV / supply`.
- **Buyback floor** — `SymbientInverseBond` is a standing bid at `floorPrice × 0.985`; sellers' FLYAI is burned. Epoch capacity = 1% of treasury RFV; halted when the circuit breaker trips.
- **Circuit breaker** — `SymbientCircuitBreaker` trips when FLYAI spot < floor × (1−2%), pausing defense/buyback operations; auto-recovers after 21 consecutive healthy epochs.
- **RBS** — Olympus RANGE mechanics (cushion/wall spreads, capacity, regeneration) under connectome control via `GovernorPolicy`.

## Repo layout

| Path | Contents |
|---|---|
| `contracts/src/` | Core protocol contracts (see AGENTS.md for the full table) |
| `contracts/src/fly/` | FlyEngine, ConnectomeGovernor, GovernorPolicy, TreasuryAllocator, ArcLaunchpadAdapter, DecisionLedger, PerformanceBridge, StakingVault |
| `contracts/script/DeploySimplified.s.sol` | Full deploy: governor = kernel executor + all roles |
| `contracts/scripts/` | `pack_connectomes.py`, `deploy_fly.py` (web3.py, 7 connectomes) |
| `workers/` | Cloudflare Workers: governance-worker (propose/vote/execute driver), trade-worker (bounded trading), api-worker, discovery/enrichment |
| `icp/connectome-agent/` | ICP canister (Rust, wasm32) — autonomous connectome colony: hourly cycles for feedback/evolution/trading/treasury/LP/replication/posting, threshold-ECDSA EVM signing via ic-alloy, ATProto posting via atrium+ICP outcalls, git journal via gix |
| `icp/connectome-agent/lexicons/` | `symbient.connectome.*` ATProto lexicon schemas (profile/thought/trade/vouch/evolution/wallet) |
| `vendor/` | Cloned OSS repos the canister + plan depend on (ic-alloy, atrium, gitoxide, cdk-rs, llm, rustrict, hanzo-guard, indicators-ta, ab-testing-rs + reference-only: canhttp, canic, guts, chainkit) |
| `contracts/src/fly/` | FlyEngine, ConnectomeGovernor, GovernorPolicy, TreasuryAllocator, ArcLaunchpadAdapter, DecisionLedger, PerformanceBridge, StakingVault, **SocialPostLog, SafetyGuard, ConnectomeStaking** |
| `contracts/script/DeploySimplified.s.sol` | Full deploy: governor = kernel executor + all roles |
| `contracts/script/DeploySocialPostLog.s.sol` | Agent-facing contracts: SocialPostLog + SafetyGuard + ConnectomeStaking |
| `contracts/scripts/` | `pack_connectomes.py`, `deploy_fly.py` (web3.py, 7 connectomes) |
| `migrations/` | D1 schema |
| `frontend/` | FLYAI dashboard |

## Build & test

```bash
cd contracts
forge build
forge test     # 60 tests
```

## Deploy (Robinhood)

```bash
cd contracts
export PRIVATE_KEY=...                 # env only — never commit keys
export SAFE_MULTISIG_ADDRESS=...       # backstop admin (veto + upgrades)
export RESERVE_TOKEN=0x...             # USDC on Arc
export UNISWAP_V2_ROUTER=0x...
export CONNECTOME_VOTERS=0x1,0x2,...   # optional bound voter EOAs

forge script script/DeploySimplified.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast

python3 scripts/pack_connectomes.py    # pack 7 connectomes → SSTORE2 blobs
python3 scripts/deploy_fly.py          # deploy FlyEngine + governor, register connectomes
```

## Security

- Keys live in env vars / Cloudflare secrets only.
- The governor is the sole protocol operator; the Safe holds only governor `admin` (veto + UUPS upgrade).
- Treasury outflows are bounded: TRSRY withdrawals need proposal-granted approval; the buyback float is a capped allowance, not custody.
- Scans: `gitleaks detect --source .`, `trivy fs --scanners secret,vuln,misconfig --severity HIGH,CRITICAL .`, `semgrep scan --config p/owasp-top-10 .`

## Licenses

- Protocol contracts: AGPL-3.0 (Olympus V3 derived)
- Vendored OSS (openzeppelin, dss, solmate, bond-protocol, …): MIT
