import type { Address } from "viem";
import type { IconName } from "@/components/icon.tsx";
import type { ChainId } from "./contracts";
import { robinhood, robinhoodTestnet } from "@/lib/chains";

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
      [robinhood.id]: "0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C",
      [robinhoodTestnet.id]: "0x0000000000000000000000000000000000000000",
    },
    symbol: "FLYAI",
    decimals: 18,
    icon: "FLYAITokenIcon",
  },
  STFLYAI: {
    addresses: {
      [robinhood.id]: "0x60c11f1182b0313d17b96ff8f20a12611ab769c5",
      [robinhoodTestnet.id]: "0x0000000000000000000000000000000000000000",
    },
    symbol: "stFLYAI",
    decimals: 18,
    icon: "STFLYAITokenIcon",
  },
  WSTFLYAI: {
    addresses: {
      [robinhood.id]: "0xc5fdf1d701cd8395564451cd89d940b5fd0c3600",
      [robinhoodTestnet.id]: "0x0000000000000000000000000000000000000000",
    },
    symbol: "wstFLYAI",
    decimals: 18,
    icon: "WSTFLYAITokenIcon",
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
