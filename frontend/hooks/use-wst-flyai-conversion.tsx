import { useMemo } from "react";
import { useReadContract, useChainId } from "wagmi";
import { parseUnits, parseEther, formatUnits, formatEther } from "viem";
import { getTokenAddress, TokenName } from "@/lib/tokens";
import wstFlyaiAbi from "@/abis/wstFLYAI";

/** Trim trailing zeros from a decimal string, keeping at least `minDecimals` places. */
function trimDecimals(value: string, maxDecimals: number, minDecimals = 2): string {
  const num = parseFloat(value);
  if (Number.isNaN(num)) return value;
  const fixed = num.toFixed(maxDecimals);
  const [int, dec] = fixed.split(".");
  if (!dec) return fixed;
  const trimmed = dec.replace(/0+$/, "").padEnd(minDecimals, "0");
  return `${int}.${trimmed}`;
}

/** Read the wstFLYAI contract's stFLYAI-per-token index (the source of truth for conversions). */
export function useWstFlyaiIndex({ enabled = true }: { enabled?: boolean } = {}) {
  const chainId = useChainId();
  const wstFlyaiAddress = getTokenAddress(TokenName.WSTFLYAI, chainId);

  const { data: index, isLoading } = useReadContract({
    address: wstFlyaiAddress,
    abi: wstFlyaiAbi,
    functionName: "stSymbientPerToken",
    query: {
      enabled: enabled && !!wstFlyaiAddress,
    },
  });

  return { index: index as bigint | undefined, isLoading };
}

/**
 * Compute the Wrap-page output amount for a given input. "wrap"/"unwrap" use the wstFLYAI
 * index with client-side bigint math (matches wstFLYAI.balanceTo / wstFLYAI.balanceFrom exactly).
 * "identity" is the 1:1 stFLYAI → FLYAI path: no index read, formatting only.
 */
export function useWstFlyaiConversion(mode: "wrap" | "unwrap" | "identity", inputAmount: string) {
  const { index } = useWstFlyaiIndex({ enabled: mode !== "identity" });

  const outputAmount = useMemo(() => {
    if (!inputAmount || parseFloat(inputAmount) === 0) return "";
    if (mode === "identity") return trimDecimals(inputAmount, 4);
    if (!index || index === 0n) return "";

    try {
      if (mode === "wrap") {
        // wstFLYAI.balanceTo: wstFLYAI = stFLYAI * 1e18 / index
        const stFlyaiAmount = parseUnits(inputAmount, 18);
        const wstFlyaiAmount = (stFlyaiAmount * 10n ** 18n) / index;
        return trimDecimals(formatEther(wstFlyaiAmount), 6);
      }
      // wstFLYAI.balanceFrom: stFLYAI = wstFLYAI * index / 1e18
      const wstFlyaiAmount = parseEther(inputAmount);
      const stFlyaiAmount = (wstFlyaiAmount * index) / 10n ** 18n;
      return trimDecimals(formatUnits(stFlyaiAmount, 18), 4);
    } catch {
      return "";
    }
  }, [inputAmount, index, mode]);

  return { outputAmount };
}

/**
 * Conversion rates using the wstFLYAI index.
 */
export function useWstFlyaiConversionRate() {
  const { index, isLoading } = useWstFlyaiIndex();

  const rates = useMemo(() => {
    if (!index || index === 0n) return { flyaiPerWstFlyai: undefined, wstFlyaiPerFlyai: undefined };

    // wstFLYAI index is stFLYAI per 1 wstFLYAI, scaled to 18 decimals.
    const flyaiPerWstFlyai = trimDecimals(formatUnits(index, 18), 3);
    // 1 FLYAI (1e18) -> wstFLYAI: wstFLYAI = 1e18 * 1e18 / index
    const wstFlyaiAmount = (10n ** 18n * 10n ** 18n) / index;
    const wstFlyaiPerFlyai = trimDecimals(formatEther(wstFlyaiAmount), 6);

    return { flyaiPerWstFlyai, wstFlyaiPerFlyai };
  }, [index]);

  return { ...rates, isLoading };
}

/** Read the total supply of wstFLYAI from the contract (returns bigint in 18 decimals). */
export function useWstFlyaiTotalSupply() {
  const chainId = useChainId();
  const wstFlyaiAddress = getTokenAddress(TokenName.WSTFLYAI, chainId);
  const { data } = useReadContract({
    address: wstFlyaiAddress,
    abi: wstFlyaiAbi,
    functionName: "totalSupply",
    query: { enabled: !!wstFlyaiAddress },
  });
  return { totalSupply: data as bigint | undefined };
}
