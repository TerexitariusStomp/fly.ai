import { defineChain } from "viem";
import { http, type Transport } from "viem";

// Robinhood Chain — mainnet (chain ID 4663)
export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Robinhood Explorer", url: "https://robinhoodchain.blockscout.com" },
  },
  testnet: false,
});

// Robinhood Chain — testnet (chain ID 46630)
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Robinhood Explorer", url: "https://explorer.testnet.chain.robinhood.com" },
  },
  testnet: true,
});

const withIcon = <T extends { id: number }>(chain: T, iconUrl: string) => ({
  ...chain,
  iconUrl,
  iconBackground: "transparent",
});

const robinhoodWithIcon = withIcon(robinhood, "/app/fly.svg");
const robinhoodTestnetWithIcon = withIcon(robinhoodTestnet, "/app/fly.svg");

/**
 * Chains available in the wallet network selector.
 */
export const PRODUCTION_CHAINS = [robinhoodWithIcon] as const;

/**
 * Whether testnet mode is enabled via environment variable.
 */
export const isTestnetMode = Boolean(import.meta.env.VITE_TESTNET_MODE);

/**
 * Active chains based on testnet mode.
 * In testnet mode, Robinhood Testnet is used. In production, Robinhood mainnet is used.
 */
export const activeChains = isTestnetMode
  ? ([robinhoodTestnetWithIcon] as const)
  : PRODUCTION_CHAINS;

/**
 * All chains for the wagmi config.
 */
export const allChains = isTestnetMode
  ? ([robinhoodTestnetWithIcon] as const)
  : PRODUCTION_CHAINS;

/**
 * Custom RPC transports per chain.
 */
export const transports: Record<number, Transport> = {
  [robinhood.id]: http("https://rpc.mainnet.chain.robinhood.com"),
  [robinhoodTestnet.id]: http("https://rpc.testnet.chain.robinhood.com"),
};
