import { defineChain } from "viem";
import { http, type Transport } from "viem";

// Arc — mainnet
export const arc = defineChain({
  id: 5042001,
  name: "Arc",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.arc.io/"] },
  },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://arcscan.app" },
  },
  testnet: false,
});

// Arc — testnet (chain ID 5042002)
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.io"] },
  },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
});

// Backward-compatible aliases — the SYM frontend imports `base` and `baseSepolia`
// We alias them to Arc so the existing frontend works without rewriting imports
export const base = arc;
export const baseSepolia = arcTestnet;

const withIcon = <T extends { id: number }>(chain: T, iconUrl: string) => ({
  ...chain,
  iconUrl,
  iconBackground: "transparent",
});

const arcWithIcon = withIcon(arc, "/icons/chain-arc.svg");
const arcTestnetWithIcon = withIcon(arcTestnet, "/icons/chain-arc.svg");

/**
 * Chains available in the wallet network selector.
 */
export const PRODUCTION_CHAINS = [arcWithIcon] as const;

/**
 * Whether testnet mode is enabled via environment variable.
 */
export const isTestnetMode = Boolean(import.meta.env.VITE_TESTNET_MODE);

/**
 * Active chains based on testnet mode.
 * In testnet mode, Arc Testnet is used. In production, Arc mainnet is used.
 */
export const activeChains = isTestnetMode
  ? ([arcTestnetWithIcon] as const)
  : PRODUCTION_CHAINS;

/**
 * All chains for the wagmi config.
 */
export const allChains = isTestnetMode
  ? ([arcTestnetWithIcon] as const)
  : PRODUCTION_CHAINS;

/**
 * Custom RPC transports per chain.
 */
export const transports: Record<number, Transport> = {
  [arc.id]: http("https://rpc.mainnet.arc.io/"),
  [arcTestnet.id]: http("https://rpc.testnet.arc.io"),
};
