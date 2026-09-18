import type { Address } from "viem";
import { robinhood, robinhoodTestnet } from "@/lib/chains";

export type DeployedContract = {
  name: string;
  description: string;
  address: Address;
};

const ZERO = "0x0000000000000000000000000000000000000000";

export const DEPLOYED_CONTRACTS: Record<number, DeployedContract[]> = {
  [robinhood.id]: [
    { name: "FLYAI", description: "Protocol token", address: "0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C" },
    { name: "stFLYAI", description: "Rebasing staked FLYAI", address: "0x60c11f1182b0313d17b96ff8f20a12611ab769c5" },
    { name: "wstFLYAI", description: "Wrapped staked FLYAI", address: "0xc5fdf1d701cd8395564451cd89d940b5fd0c3600" },
    { name: "Staking Adapter", description: "Stake, unstake, wrap, unwrap", address: "0x02dcb803a61315d27eebfa89c71f86e451847448" },
    { name: "Inverse Bond", description: "Sell FLYAI to the treasury at floor", address: "0x73fcf57ea4bb78b103e9323fad27b54fd7aeccf2" },
    { name: "Treasury Valuation", description: "RFV, NAV, and floor price", address: "0x5be9ab574c7c9e3cf4367d610c682e6174633e24" },
    { name: "Symbient Price", description: "Olympus PRICE module", address: "0xaf95908a0311e470997c6ef39153576fa05157ac" },
    { name: "Connectome Governor", description: "3-of-7 collective executor", address: "0x6a7a1df72301e6a09dd43adf2fdd4487994e72a8" },
    { name: "Governor Policy", description: "Kernel module bridge", address: "0x2257c925e5d6156cca11f0d7f9a69859d383099f" },
    { name: "Olympus Kernel", description: "Protocol kernel", address: "0x381c76f91fb16ce539f5488cb5baacdd047ab1b6" },
    { name: "Olympus Treasury", description: "Reserve custody", address: "0x056518a55e60328ddeb8b7a1de844c8d390989e1" },
    { name: "Token Registry", description: "Treasury asset registry", address: "0x4934ca5b217383c96ab5145b8ee5ca65f1eacd42" },
    { name: "FlyEngine", description: "On-chain connectome inference", address: "0x07732db25b67fd0cee4625b062ee6e710921c132" },
    { name: "Treasury Allocator", description: "Strategy allocator", address: "0x6429b17f42c3f188595f24d0bd721079ba4329a3" },
    { name: "Decision Ledger", description: "Collective decision audit trail", address: "0x9552e44a2ba380b4ddd62b6ca4359661cee6a864" },
    { name: "Circuit Breaker", description: "Bond safety breaker", address: "0x739076194179fcd0d8ebaa729c09e59dbf3d64a4" },
    { name: "Social Post Log", description: "Connectome social audit log", address: "0xf56f81d2a205279548021255a7b1f8d5097ffc66" },
  ],
  [robinhoodTestnet.id]: [
    { name: "FLYAI", description: "Protocol token", address: ZERO },
  ],
};

export function getDeployedContracts(chainId: number): DeployedContract[] {
  return (DEPLOYED_CONTRACTS[chainId] ?? []).filter(
    (contract) => contract.address.toLowerCase() !== ZERO,
  );
}

export function getExplorerUrl(chainId: number): string {
  return chainId === robinhoodTestnet.id
    ? "https://explorer.testnet.chain.robinhood.com"
    : "https://robinhoodchain.blockscout.com";
}

export function getContractExplorerUrl(chainId: number, address: Address): string {
  return `${getExplorerUrl(chainId)}/address/${address}`;
}
