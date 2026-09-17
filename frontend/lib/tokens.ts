import type { Address } from "viem";
import type { IconName } from "@/components/icon.tsx";
import type { ChainId } from "./contracts";
import { base, baseSepolia } from "@/lib/chains";

export type TokenInfo = {
  addresses: Partial<Record<ChainId, Address>>;
  symbol: string;
  decimals: number;
  icon: IconName;
};

// Single-token system: FLYAI (fly.ai on Robinhood) + its staking derivatives only.
export enum TokenName {
  FLYAI = "FLYAI",
  STFLYAI = "STFLYAI",
  WSTFLYAI = "WSTFLYAI",
}

export const TOKENS: Record<TokenName, TokenInfo> = {
  FLYAI: {
    addresses: {
      [base.id]: "0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C",
      [baseSepolia.id]: "0x0000000000000000000000000000000000000000",
    },
    symbol: "FLYAI",
    decimals: 18,
    icon: "SHITTokenIcon",
  },
  STFLYAI: {
    addresses: {
      [base.id]: "0x0000000000000000000000000000000000000000",
      [baseSepolia.id]: "0x0000000000000000000000000000000000000000",
    },
    symbol: "stFLYAI",
    decimals: 18,
    icon: "STSHITTokenIcon",
  },
  WSTFLYAI: {
    addresses: {
      [base.id]: "0x0000000000000000000000000000000000000000",
      [baseSepolia.id]: "0x0000000000000000000000000000000000000000",
    },
    symbol: "wstFLYAI",
    decimals: 18,
    icon: "WSTSHITTokenIcon",
  },
};

export function getTokenAddress(token: TokenName, chainId: ChainId): Address | undefined {
  return TOKENS[token].addresses[chainId];
}

export function requireTokenAddress(token: TokenName, chainId: ChainId): Address {
  const address = getTokenAddress(token, chainId);
  if (!address) {
    throw new Error(`Token ${token} not found on chain ${chainId}`);
  }
  return address;
}
