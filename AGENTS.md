# AGENTS.md — fly.ai Protocol

## Project Overview

FLYAI is a single-token, treasury-backed protocol on **Robinhood Chain** (mainnet chain ID `4663`, testnet `46630`). The primary token is the deployed FLYAI (fly.ai) at `0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C`. The treasury is governed and actively managed by **7 biological connectomes** running on-chain LIF inference via `FlyEngine`. The architecture is an Olympus V3 fork (Kernel / Modules / Policies / Heart / RBS) where the `ConnectomeGovernor` is the kernel executor — the connectomes operate the entire protocol themselves.

## Directory Structure

```
symbient-token/
├── contracts/                  # Foundry Solidity (AGPL-3.0)
│   ├── src/                    # Core: SymbientToken, SymbientStaking, wstFLYAI, valuation,
│   │                           #   price feeds, inverse bond, circuit breaker
│   ├── src/fly/                # FlyEngine, ConnectomeGovernor, GovernorPolicy,
│   │                           #   TreasuryAllocator, ArcLaunchpadAdapter,
│   │                           #   DecisionLedger, PerformanceBridge, StakingVault
│   ├── src/fly/strategies/     # RBSStrategy, MemecoinStrategy, YieldFarmingStrategy,
│   │                           #   SafeHavenStrategy (thin IStrategy adapters)
│   ├── script/DeploySimplified.s.sol   # full protocol deploy (governor = executor)
│   ├── script/DeployPhase2.s.sol       # fly-system-only deploy
│   ├── scripts/deploy_fly.py           # FlyEngine + governor + 7 connectomes (web3.py)
│   ├── scripts/pack_connectomes.py     # NPZ → int4/uint16 CSR for SSTORE2
│   └── foundry.toml
├── workers/                    # Cloudflare Workers (free tier)
│   ├── fly-brain-do/           # Connectome Durable Object
│   ├── governance-worker/      # Drives on-chain propose → vote → execute
│   ├── discovery-worker/       # Cron: poll launchpads / DexScreener
│   ├── trade-worker/           # Bounded autonomous trading (viem + loxley)
│   ├── api-worker/             # REST API + on-chain treasury reads
│   └── enrichment-worker/      # Token scoring
├── migrations/schema.sql       # D1 schema (treasury_snapshots, wallets, …)
└── frontend/                   # fly.ai dashboard (treasury, connectomes, ops)
```

## Architecture

```
                    ┌────────────────────────────────┐
                    │   ConnectomeGovernor (UUPS)    │  kernel executor + all roles
                    │  propose / vote / execute      │  quorum = 3 of 7 (≥1/3)
                    └──────────────┬─────────────────┘
                                   │ passed proposals
                    ┌──────────────▼─────────────────┐
                    │        GovernorPolicy          │  Kernel Policy, bridges to modules
                    │  executeModule(target, data)   │  approveToken() for buyback float
                    └──────────────┬─────────────────┘
            ┌──────────────────────┼─────────────────────────┐
            ▼                      ▼                         ▼
      Olympus Kernel        TreasuryAllocator         ArcLaunchpadAdapter
      MINTR/TRSRY/PRICE     (strategy targets,        (token whitelist,
      /RANGE + Heart          rebalances, harvests)    bounded trades)
            │
            ▼
   TreasuryValuation ──► SymbientInverseBond (buyback at floor × 0.985, burns FLYAI)
   (RFV, NAV, floorPrice)      ▲
                               └── SymbientCircuitBreaker (trips when spot < floor×0.98)
```

## The 7 Connectomes

| ID | Neurons |
|---|---|
| drosophila | 49 |
| rat | 73 |
| mouse | 112 |
| ciona | 205 |
| macaque_modha | 242 |
| human | 234 |
| celegans_male | 575 |

Quorum = `ceil(7 × 1/3) = 3`. A proposal executes when `forVotes ≥ 3` and `forVotes > againstVotes`. Votes run on-chain inference (`FlyEngine.analyze`): action `+1` = for, `−1` = against, `0` = abstain. Optional per-connectome bound-voter EOAs gate who can trigger each vote.

## Governance model

**Governance-controlled (proposals, infrequent):**
- Whitelist/remove tradeable tokens, set trade/position bounds
- Strategy registration + target allocations
- Risk parameters: buyback spread/capacity, valuation haircuts, price feeds
- Olympus params: RANGE spreads/capacity/prices, TRSRY approvals, MINTR
- Emergency pause/restart, kernel module installs/upgrades
- Funding floats (e.g. inverse bond payout approval)

**Autonomous (no vote needed):**
- Heart beats → rebases, periodic tasks
- Trades within bounds (`KEEPER_ROLE`)
- Treasury rebalances/harvests within targets
- Buybacks within epoch capacity at floor price
- Circuit-breaker checks (permissionless)

## Build & Test

```bash
cd contracts
forge build
forge test
```

## Deploy (Robinhood)

```bash
cd contracts
export PRIVATE_KEY=...                  # deployer (env only — never commit)
export SAFE_MULTISIG_ADDRESS=...        # backstop admin (veto/upgrades)
export RESERVE_TOKEN=0x...              # USDC on Robinhood
export UNISWAP_V2_ROUTER=0x...
export CONNECTOME_VOTERS=0x..,0x..,..   # 7 bound voter EOAs (optional)

forge script script/DeploySimplified.s.sol \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast

# Then deploy fly brain + register connectomes:
python3 scripts/pack_connectomes.py     # pack 7 connectomes → SSTORE2
python3 scripts/deploy_fly.py           # FlyEngine + governor + connectomes
```

Post-deploy (if SAFE ≠ deployer): the Safe must grant the governor `MULTISIG_ROLE`/`GOVERNANCE_ROLE` on the standalone contracts (script prints the list), and call `symbientToken.setAuthorizedMinter(MINTR)`.

## Deployed — Robinhood mainnet (chain 4663)

All 33 contracts verified on **Sourcify** (full source match). Canonical addresses live in
`contracts/broadcast/DeploySimplified.s.sol/4663/run-latest.json`. Key entries:

| Contract | Address |
|---|---|
| ConnectomeGovernor (proxy) | `0x6a7a1dF72301E6A09dd43aDf2fdd4487994E72A8` |
| FlyEngine (proxy) | `0x07732dB25b67fd0cee4625b062ee6e710921c132` |
| GovernorPolicy | `0x2257c925E5D6156Cca11F0d7F9a69859d383099f` |
| SymbientInverseBond | `0x73fCF57eA4bB78b103e9323fAd27b54Fd7aeCCf2` |
| DecisionLedger | `0x9552e44a2ba380b4ddd62b6ca4359661cee6a864` |
| SocialPostLog | `0xf56F81D2a205279548021255A7b1F8D5097FfC66` (deployed post-launch) |
| FLYAI token | `0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C` (immutable launch token — no owner/mint) |

Wiring state (as of 2026-09-18):
- `FlyEngine.governor` = governor proxy; `gov.decisionLedger` + `gov.socialPostLog` set
- Governor: admin = deployer `0xc6f1…` (**compromised — rotate to Safe before real value**),
  colonyExecutor = `0xdd18b2…`, quorum 3334 bps
- All 7 connectomes registered in the governor (n=7 → quorum 3-of-7);
  only drosophila/human/celegans_male have on-chain engine data — rat/mouse/ciona/macaque_modha
  need SSTORE2 chunk uploads (~8M gas, packed data in `~/fly-data/packed/`)
- On-chain `vote()` costs ~16M gas/call (LIF inference) — the operating path is
  `colonyExecute` (off-chain D1 votes → executor relays one tx); proven by tx `0xb5df1f…`
- Buyback float: `approveToken(FLYAI → bond, 50M)` queued via `proposals_queue` → colony vote →
  `colonyExecute`. GovernorPolicy currently holds 0 FLYAI — float still needs funding.

## Contracts (custom LOC, all under `contracts/src/`)

| File | LOC | Purpose |
|---|---|---|
| SymbientStaking.sol | 550 | Rebasing staking + warmup, rate-limit, smoothing, CB, `depositRewards` for external-token mode |
| SymbientFeeRouter.sol | ~130 | Tolly LP fees → `routeToTreasury` consolidates into TRSRY (single treasury); `fundRewards` GOVERNANCE-gated FLYAI buy + `depositRewards` — rewards only by connectome vote |
| FlyEngine.sol | 358 | On-chain LIF inference over SSTORE2 connectome data |
| TreasuryValuation.sol | 285 | NAV/RFV/floorPrice with per-asset haircuts + TRSRY reads |
| ArcLaunchpadAdapter.sol | 281 | Bounded token trading via UniV2 router |
| StakingVault.sol | 255 | LP signal staking → signalScore |
| ConnectomeGovernor.sol | 253 | propose/vote/execute consensus executor (was 776) |
| SymbientDefenseBudget.sol | 205 | RBS defense budget gating (Olympus Policy) |
| SymbientPrice.sol | 204 | PRICE module fork on TWAP feed |
| TreasuryAllocator.sol | 194 | Multi-strategy treasury (Yearn-style IStrategy) |
| SymbientCircuitBreaker.sol | 168 | Trips when FLYAI spot < floor×(1−2%) |
| SymbientInverseBond.sol | 145 | Standing buyback at floor×0.985, burns FLYAI |
| SymbientBondPricer.sol | 135 | Dynamic RBS bond discount |
| GovernorPolicy.sol | 127 | Module bridge: executeModule + approveToken |
| DecisionLedger.sol | 110 | On-chain decision/vote/execution audit trail |
| StakingAdapter.sol | 109 | Olympus IStaking bridge for Heart |
| strategies/ + misc | ~800 | Thin adapters, feeds, token, registry, distributor |

**Total custom ~4,300 LOC**; everything else is vendored OSS (olympus-v3, openzeppelin, dss, solmate, bond-protocol, …).

## OSS replacements done

- `MultisigGuard` → OZ `AccessControl` (all contracts)
- Custom pause flags → OZ `Pausable` (circuit breaker)
- Tiered action registry → generic `target.call(data)` after consensus
- Onboarding liquidity check → folded into `whitelistToken` (removed `TokenOnboardingManager`)
- Manual NAV pushes → live `TreasuryValuation.floorPrice()`/`rfv()` reads
- `wstSYM` denominator bug fixed: share-of-pool (`balanceOf(this)`) not global supply

## Self-improving codebase loop

The colony maintains its own code with no human in the loop (commit to `main` on the colony repo — deploys stay manual):

```
cycle → /ideate (rotating connectome picks file+task from repo tree)
      → /code (persona+LLM writes full replacement content)
      → constitutional gate on diff (always-on for code)
      → /review × 7 connectomes (3-of-7 quorum, votes in governance_votes)
      → commitFile → main on the CF git remote (the commit IS the merge)
      → outcome → connectome_genome.pnl_score (merged +2 / rejected −1 / gate_blocked −2)
```

- Canonical repo: `git clone https://governance-worker.symbient.workers.dev/repo.git` — dumb-HTTP remote served from D1 `git_files` (loose objects + refs). Seeded with a baseline commit of colony-scope source (`scripts/seed_colony_repo.py`).
- Radicle mirror: `git fetch https://governance-worker.symbient.workers.dev/repo.git && git push rad main` — run whenever the node is up.
- Endpoints: `POST /code/propose`, `GET /code/status`, `POST /repo.git/import` (keyed) on governance-worker; `/ideate`, `/code`, `/review` on fly-brain DOs.
- Kill switch: `UPDATE settings SET value='false' WHERE key='code_enabled'`; cap: `code_max_per_day` (default 8).
- OSS used: isomorphic-git (MIT) for all git object/commit ops, zod (MIT) for LLM output validation, llama-3.3-70b via Workers AI, viem. Custom glue ~150 LOC (D1FS adapter + dumb-remote file server).

## Security

- Private keys are env vars / CF secrets only — **never in code**. (Two old deploy shell scripts with a hardcoded testnet key were deleted; that key should be rotated.)
- Governor proposals are bounded by on-chain consensus; Safe retains governor `admin` (veto + UUPS upgrades) only.
- TRSRY withdrawals require explicit `increaseWithdrawApproval` via proposal — no arbitrary drain.
- Buyback float is funded via `GovernorPolicy.approveToken` — bounded allowance, not custody transfer.
- Scans (run before every deploy):

```bash
gitleaks detect --source .
trivy fs --scanners secret,vuln,misconfig --severity HIGH,CRITICAL .
semgrep scan --config p/owasp-top-10 .
```
