import type { Address } from "viem";

export type ChainId = number;

import {
  base,
  baseSepolia,
} from "@/lib/chains";

/**
 * Registry of deployed contract names (single-token SYM system on Arc).
 */
export enum ContractName {
  SYM = "SYM",
  STSYM = "STSYM",
  WSTSYM = "WSTSYM",
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
  [ContractName.SYM]: {
    [base.id]: "0x0000000000000000000000000000000000000000",
    [baseSepolia.id]: "0x823d5d44F9E647402c949376E54f709Ab3a9015b",
  },
  [ContractName.STSYM]: {
    [base.id]: "0x0000000000000000000000000000000000000000",
    [baseSepolia.id]: "0xdb3D61dEE55eF664412BcEBEd144981B2Fc11a34",
  },
  [ContractName.WSTSYM]: {
    [base.id]: "0x0000000000000000000000000000000000000000",
    [baseSepolia.id]: "0x933E4B8e744733FAaFD67aC99eD8987C9Aa5E533",
  },
  [ContractName.STAKING]: {
    [base.id]: "0x0000000000000000000000000000000000000000",
    [baseSepolia.id]: "0x0000000000000000000000000000000000000000",
  },
  [ContractName.PRICE]: {
    [base.id]: "0x0000000000000000000000000000000000000000",
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
