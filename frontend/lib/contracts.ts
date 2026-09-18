import type { Address } from "viem";
import { robinhood, robinhoodTestnet } from "@/lib/chains";

export type ChainId = number;

/** Registry of FLYAI protocol contracts on Robinhood Chain. */
export enum ContractName {
  FLYAI = "FLYAI",
  STFLYAI = "STFLYAI",
  WSTFLYAI = "WSTFLYAI",
  STAKING = "STAKING",
  STAKING_ADAPTER = "STAKING_ADAPTER",
  PRICE = "PRICE",
  TREASURY_VALUATION = "TREASURY_VALUATION",
  INVERSE_BOND = "INVERSE_BOND",
  CIRCUIT_BREAKER = "CIRCUIT_BREAKER",
  GOVERNOR = "GOVERNOR",
  GOVERNOR_POLICY = "GOVERNOR_POLICY",
  KERNEL = "KERNEL",
  OLYMPUS_TREASURY = "OLYMPUS_TREASURY",
  TOKEN_REGISTRY = "TOKEN_REGISTRY",
  FLY_ENGINE = "FLY_ENGINE",
  TREASURY_ALLOCATOR = "TREASURY_ALLOCATOR",
  LAUNCHPAD_ADAPTER = "LAUNCHPAD_ADAPTER",
  DECISION_LEDGER = "DECISION_LEDGER",
  SOCIAL_POST_LOG = "SOCIAL_POST_LOG",
}

type ContractAddresses = {
  [K in ContractName]: Partial<Record<number, Address>>;
};

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** Canonical Robinhood mainnet deployment from DeploySimplified.s.sol. */
export const CONTRACTS: ContractAddresses = {
  [ContractName.FLYAI]: {
    [robinhood.id]: "0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C",
    [robinhoodTestnet.id]: ZERO,
  },
  [ContractName.STFLYAI]: {
    [robinhood.id]: "0x60c11f1182b0313d17b96ff8f20a12611ab769c5",
    [robinhoodTestnet.id]: ZERO,
  },
  [ContractName.WSTFLYAI]: {
    [robinhood.id]: "0xc5fdf1d701cd8395564451cd89d940b5fd0c3600",
    [robinhoodTestnet.id]: ZERO,
  },
  [ContractName.STAKING]: {
    [robinhood.id]: "0x60c11f1182b0313d17b96ff8f20a12611ab769c5",
    [robinhoodTestnet.id]: ZERO,
  },
  [ContractName.STAKING_ADAPTER]: {
    [robinhood.id]: "0x02dcb803a61315d27eebfa89c71f86e451847448",
    [robinhoodTestnet.id]: ZERO,
  },
  [ContractName.PRICE]: {
    [robinhood.id]: "0xaf95908a0311e470997c6ef39153576fa05157ac",
    [robinhoodTestnet.id]: ZERO,
  },
  [ContractName.TREASURY_VALUATION]: {
    [robinhood.id]: "0x5be9ab574c7c9e3cf4367d610c682e6174633e24",
    [robinhoodTestnet.id]: ZERO,
  },
  [ContractName.INVERSE_BOND]: {
    [robinhood.id]: "0x73fcf57ea4bb78b103e9323fad27b54fd7aeccf2",
    [robinhoodTestnet.id]: ZERO,
  },
  [ContractName.CIRCUIT_BREAKER]: {
    [robinhood.id]: "0x739076194179fcd0d8ebaa729c09e59dbf3d64a4",
    [robinhoodTestnet.id]: ZERO,
  },
  [ContractName.GOVERNOR]: {
    [robinhood.id]: "0x6a7a1df72301e6a09dd43adf2fdd4487994e72a8",
    [robinhoodTestnet.id]: ZERO,
  },
  [ContractName.GOVERNOR_POLICY]: {
    [robinhood.id]: "0x2257c925e5d6156cca11f0d7f9a69859d383099f",
    [robinhoodTestnet.id]: ZERO,
  },
  [ContractName.KERNEL]: {
    [robinhood.id]: "0x381c76f91fb16ce539f5488cb5baacdd047ab1b6",
    [robinhoodTestnet.id]: ZERO,
  },
  [ContractName.OLYMPUS_TREASURY]: {
    [robinhood.id]: "0x056518a55e60328ddeb8b7a1de844c8d390989e1",
    [robinhoodTestnet.id]: ZERO,
  },
  [ContractName.TOKEN_REGISTRY]: {
    [robinhood.id]: "0x4934ca5b217383c96ab5145b8ee5ca65f1eacd42",
    [robinhoodTestnet.id]: ZERO,
  },
  [ContractName.FLY_ENGINE]: {
    [robinhood.id]: "0x07732db25b67fd0cee4625b062ee6e710921c132",
    [robinhoodTestnet.id]: ZERO,
  },
  [ContractName.TREASURY_ALLOCATOR]: {
    [robinhood.id]: "0x6429b17f42c3f188595f24d0bd721079ba4329a3",
    [robinhoodTestnet.id]: ZERO,
  },
  [ContractName.LAUNCHPAD_ADAPTER]: {
    [robinhood.id]: "0x40bafc320916de21dc0681363839e35d7c633f07",
    [robinhoodTestnet.id]: ZERO,
  },
  [ContractName.DECISION_LEDGER]: {
    [robinhood.id]: "0x9552e44a2ba380b4ddd62b6ca4359661cee6a864",
    [robinhoodTestnet.id]: ZERO,
  },
  [ContractName.SOCIAL_POST_LOG]: {
    [robinhood.id]: "0xf56f81d2a205279548021255a7b1f8d5097ffc66",
    [robinhoodTestnet.id]: ZERO,
  },
};

/** Look up a contract address on a specific chain. */
export function getContractAddress(
  contractName: ContractName,
  chainId: number,
): Address | undefined {
  return CONTRACTS[contractName][chainId];
}

/** Look up a contract address, throwing if not found or disabled. */
export function requireContractAddress(contractName: ContractName, chainId: number): Address {
  const address = getContractAddress(contractName, chainId);
  if (!address || address === ZERO) {
    throw new Error(`Contract ${contractName} not deployed on chain ${chainId}`);
  }
  return address;
}
