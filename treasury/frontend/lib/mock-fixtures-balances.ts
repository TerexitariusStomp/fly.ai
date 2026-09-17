import { parseUnits } from "viem";
import { baseSepolia } from "@/lib/chains";
import type { MultiChainBalanceResult, ChainBalance } from "@/hooks/use-multi-chain-balance";

function bal(chainId: number, chainName: string, amount: string, decimals: number): ChainBalance {
  const balance = parseUnits(amount, decimals);
  return { chainId, chainName, balance, formattedBalance: amount };
}

function result(balances: ChainBalance[]): MultiChainBalanceResult {
  const totalBalance = balances.reduce((sum, b) => sum + b.balance, 0n);
  const totalFormatted = balances.reduce((sum, b) => sum + parseFloat(b.formattedBalance), 0);
  return {
    balances,
    totalBalance,
    formattedTotalBalance: totalFormatted.toString(),
    isLoading: false,
    error: null,
  };
}

const EMPTY: MultiChainBalanceResult = {
  balances: [],
  totalBalance: 0n,
  formattedTotalBalance: "0",
  isLoading: false,
  error: null,
};

// Whale: big balances on Arc testnet
export const WHALE_BALANCES: Record<string, MultiChainBalanceResult> = {
  FLYAI: result([bal(baseSepolia.id, "Arc Testnet", "14245", 18)]),
  stFLYAI: result([bal(baseSepolia.id, "Arc Testnet", "2125", 18)]),
  wstFLYAI: result([bal(baseSepolia.id, "Arc Testnet", "1424.5", 18)]),
};

// Empty: connected but no balances
export const EMPTY_BALANCES: Record<string, MultiChainBalanceResult> = {
  FLYAI: EMPTY,
  stFLYAI: EMPTY,
  wstFLYAI: EMPTY,
};

// Staker: mostly staked/wrapped positions
export const STAKER_BALANCES: Record<string, MultiChainBalanceResult> = {
  FLYAI: result([bal(baseSepolia.id, "Arc Testnet", "500", 18)]),
  stFLYAI: result([bal(baseSepolia.id, "Arc Testnet", "1200", 18)]),
  wstFLYAI: result([bal(baseSepolia.id, "Arc Testnet", "340", 18)]),
};
