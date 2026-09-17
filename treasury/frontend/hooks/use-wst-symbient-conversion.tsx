import { useMemo } from "react";
import { useReadContract, useChainId } from "wagmi";
import { parseUnits, parseEther, formatUnits, formatEther } from "viem";
import { getTokenAddress, TokenName } from "@/lib/tokens";
import wstSYMAbi from "@/abis/wstFLYAI";

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

/** Read the wstFLYAI contract's stSymbientPerToken (the source of truth for conversions). */
export function useGsymbientIndex({ enabled = true }: { enabled?: boolean } = {}) {
  const chainId = useChainId();
  const gsymbientAddress = getTokenAddress(TokenName.WSTFLYAI, chainId);

  const { data: index, isLoading } = useReadContract({
    address: gsymbientAddress,
    abi: wstSYMAbi,
    functionName: "stSymbientPerToken",
    query: {
      enabled: enabled && !!gsymbientAddress,
    },
  });

  return { index: index as bigint | undefined, isLoading };
}

/**
 * Compute the Wrap-page output amount for a given input. "wrap"/"unwrap" use the wstFLYAI
 * index with client-side bigint math (matches wstFLYAI.balanceTo / wstFLYAI.balanceFrom exactly).
 * "identity" is the 1:1 stFLYAI → FLYAI path: no index read, formatting only.
 */
export function useWstSymbientConversion(mode: "wrap" | "unwrap" | "identity", inputAmount: string) {
  const { index } = useGsymbientIndex({ enabled: mode !== "identity" });

  const outputAmount = useMemo(() => {
    if (!inputAmount || parseFloat(inputAmount) === 0) return "";
    if (mode === "identity") return trimDecimals(inputAmount, 4);
    if (!index || index === 0n) return "";

    try {
      if (mode === "wrap") {
        // wstFLYAI.balanceTo: wstFLYAI = sSYM * 1e18 / index
        const symbientBigInt = parseUnits(inputAmount, 18);
        const gsymbientBigInt = (symbientBigInt * 10n ** 18n) / index;
        return trimDecimals(formatEther(gsymbientBigInt), 6);
      }
      // wstFLYAI.balanceFrom: sSYM = wstFLYAI * index / 1e18
      const gsymbientBigInt = parseEther(inputAmount);
      const symbientBigInt = (gsymbientBigInt * index) / 10n ** 18n;
      return trimDecimals(formatUnits(symbientBigInt, 18), 4);
    } catch {
      return "";
    }
  }, [inputAmount, index, mode]);

  return { outputAmount };
}

/**
 * Conversion rates using the wstFLYAI index.
 */
export function useWstSymbientConversionRate() {
  const { index, isLoading } = useGsymbientIndex();

  const rates = useMemo(() => {
    if (!index || index === 0n) return { symbientPerGsymbient: undefined, gsymbientPerSymbient: undefined };

    // wstFLYAI index is stFLYAI per 1 wstFLYAI, scaled to 18 decimals.
    const symbientPerGsymbient = trimDecimals(formatUnits(index, 18), 3);
    // 1 FLYAI (1e18) -> wstFLYAI: wstFLYAI = 1e18 * 1e18 / index
    const gsymbientBigInt = (10n ** 18n * 10n ** 18n) / index;
    const gsymbientPerSymbient = trimDecimals(formatEther(gsymbientBigInt), 6);

    return { symbientPerGsymbient, gsymbientPerSymbient };
  }, [index]);

  return { ...rates, isLoading };
}

/** Read the total supply of wstFLYAI from the contract (returns bigint in 18 decimals). */
export function useGsymbientTotalSupply() {
  const chainId = useChainId();
  const gsymbientAddress = getTokenAddress(TokenName.WSTFLYAI, chainId);
  const { data } = useReadContract({
    address: gsymbientAddress,
    abi: wstSYMAbi,
    functionName: "totalSupply",
    query: { enabled: !!gsymbientAddress },
  });
  return { totalSupply: data as bigint | undefined };
}
