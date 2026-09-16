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

// Single-token system: SYM + its staking derivatives only.
export enum TokenName {
  SYM = "SYM",
  STSYM = "STSYM",
  WSTSYM = "WSTSYM",
}

export const TOKENS: Record<TokenName, TokenInfo> = {
  SYM: {
    addresses: {
      [base.id]: "0x0000000000000000000000000000000000000000",
      [baseSepolia.id]: "0x823d5d44F9E647402c949376E54f709Ab3a9015b",
    },
    symbol: "SYM",
    decimals: 18,
    icon: "SHITTokenIcon",
  },
  STSYM: {
    addresses: {
      [base.id]: "0x0000000000000000000000000000000000000000",
      [baseSepolia.id]: "0xdb3D61dEE55eF664412BcEBEd144981B2Fc11a34",
    },
    symbol: "stSYM",
    decimals: 18,
    icon: "STSHITTokenIcon",
  },
  WSTSYM: {
    addresses: {
      [base.id]: "0x0000000000000000000000000000000000000000",
      [baseSepolia.id]: "0x933E4B8e744733FAaFD67aC99eD8987C9Aa5E533",
    },
    symbol: "wstSYM",
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
