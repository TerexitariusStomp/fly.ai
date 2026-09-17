import type { MockScenario } from "./mock-types";
import { DEFAULT_PRICES } from "./mock-fixtures-prices";
import {
  WHALE_BALANCES,
  EMPTY_BALANCES,
  STAKER_BALANCES,
} from "./mock-fixtures-balances";

export const SCENARIOS: Record<string, MockScenario> = {
  whale: {
    name: "whale",
    description: "Large FLYAI + stFLYAI + wstFLYAI balances",
    isConnected: true,
    prices: DEFAULT_PRICES,
    balances: WHALE_BALANCES,
  },
  empty: {
    name: "empty",
    description: "Connected wallet with zero balances",
    isConnected: true,
    prices: DEFAULT_PRICES,
    balances: EMPTY_BALANCES,
  },
  staker: {
    name: "staker",
    description: "Wallet mostly staked into stFLYAI / wstFLYAI",
    isConnected: true,
    prices: DEFAULT_PRICES,
    balances: STAKER_BALANCES,
  },
  disconnected: {
    name: "disconnected",
    description: "No wallet connected",
    isConnected: false,
    prices: DEFAULT_PRICES,
    balances: EMPTY_BALANCES,
  },
};

export function getScenarioFromUrl(): MockScenario {
  const params = new URLSearchParams(window.location.search);
  // Also check hash params for hash-based routing
  const hashSearch = window.location.hash.split("?")[1];
  const hashParams = hashSearch ? new URLSearchParams(hashSearch) : null;

  const scenarioName = params.get("scenario") ?? hashParams?.get("scenario") ?? "whale";

  return SCENARIOS[scenarioName] ?? SCENARIOS.whale;
}
