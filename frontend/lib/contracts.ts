import type { Address } from "viem";

export type ChainId = number;

import {
  base,
  baseSepolia,
} from "@/lib/chains";

/**
 * Registry of deployed contract names (single-token FLYAI system on Arc).
 */
export enum ContractName {
  FLYAI = "FLYAI",
  STFLYAI = "STFLYAI",
  WSTFLYAI = "WSTFLYAI",
  STAKING = "STAKING",
  PRICE = "PRICE",
}

type ContractAddresses = {
  [K in ContractName]: Partial<Record<number, Address>>;
};

/**
 * Contract addresses by chain (Arc mainnet / Arc testnet via the `base` aliases in chains.ts).
 * Populated post-deployment via DeploySimplified.s.sol.
 */
export const CONTRACTS: ContractAddresses = {
  [ContractName.FLYAI]: {
    [base.id]: "0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C",
    [baseSepolia.id]: "0x0000000000000000000000000000000000000000",
  },
  [ContractName.STFLYAI]: {
    [base.id]: "0x60c11f1182b0313d17b96ff8f20a12611ab769c5",
    [baseSepolia.id]: "0x0000000000000000000000000000000000000000",
  },
  [ContractName.WSTFLYAI]: {
    [base.id]: "0xc5fdf1d701cd8395564451cd89d940b5fd0c3600",
    [baseSepolia.id]: "0x0000000000000000000000000000000000000000",
  },
  [ContractName.STAKING]: {
    [base.id]: "0x60c11f1182b0313d17b96ff8f20a12611ab769c5",
    [baseSepolia.id]: "0x0000000000000000000000000000000000000000",
  },
  [ContractName.PRICE]: {
    [base.id]: "0xaf95908a0311e470997c6ef39153576fa05157ac",
    [baseSepolia.id]: "0x0000000000000000000000000000000000000000",
  },
};

/**
 * Look up a contract address on a specific chain.
 */
export function getContractAddress(
  contractName: ContractName,
  chainId: number,
): Address | undefined {
  return CONTRACTS[contractName][chainId];
}

/**
 * Look up a contract address, throwing if not found.
 */
export function requireContractAddress(contractName: ContractName, chainId: number): Address {
  const address = getContractAddress(contractName, chainId);
  if (!address) {
    throw new Error(`Contract ${contractName} not deployed on chain ${chainId}`);
  }
  return address;
}
