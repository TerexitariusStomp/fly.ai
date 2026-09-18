import { formatUnits } from "viem";

/** Format an 18-decimal on-chain amount as a JS number for display math. */
export function formatTokenAmount(value: bigint, decimals = 18): number {
  return Number(formatUnits(value, decimals));
}
