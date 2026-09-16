import { useMemo } from "react";
import { useReadContract, useChainId } from "wagmi";
import { parseUnits, parseEther, formatUnits, formatEther } from "viem";
import { getTokenAddress, TokenName } from "@/lib/tokens";
import wstSYMAbi from "@/abis/wstSYM";

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

/** Read the wstSYM contract's stSymbientPerToken (the source of truth for conversions). */
export function useGsymbientIndex({ enabled = true }: { enabled?: boolean } = {}) {
  const chainId = useChainId();
  const gsymbientAddress = getTokenAddress(TokenName.WSTSYM, chainId);

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
 * Compute the Wrap-page output amount for a given input. "wrap"/"unwrap" use the wstSYM
 * index with client-side bigint math (matches wstSYM.balanceTo / wstSYM.balanceFrom exactly).
 * "identity" is the 1:1 stSYM → SYM path: no index read, formatting only.
 */
export function useWstSymbientConversion(mode: "wrap" | "unwrap" | "identity", inputAmount: string) {
  const { index } = useGsymbientIndex({ enabled: mode !== "identity" });

  const outputAmount = useMemo(() => {
    if (!inputAmount || parseFloat(inputAmount) === 0) return "";
    if (mode === "identity") return trimDecimals(inputAmount, 4);
    if (!index || index === 0n) return "";

    try {
      if (mode === "wrap") {
        // wstSYM.balanceTo: wstSYM = sSYM * 1e18 / index
        const symbientBigInt = parseUnits(inputAmount, 18);
        const gsymbientBigInt = (symbientBigInt * 10n ** 18n) / index;
        return trimDecimals(formatEther(gsymbientBigInt), 6);
      }
      // wstSYM.balanceFrom: sSYM = wstSYM * index / 1e18
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
 * Conversion rates using the wstSYM index.
 */
export function useWstSymbientConversionRate() {
  const { index, isLoading } = useGsymbientIndex();

  const rates = useMemo(() => {
    if (!index || index === 0n) return { symbientPerGsymbient: undefined, gsymbientPerSymbient: undefined };

    // wstSYM index is stSYM per 1 wstSYM, scaled to 18 decimals.
    const symbientPerGsymbient = trimDecimals(formatUnits(index, 18), 3);
    // 1 SYM (1e18) -> wstSYM: wstSYM = 1e18 * 1e18 / index
    const gsymbientBigInt = (10n ** 18n * 10n ** 18n) / index;
    const gsymbientPerSymbient = trimDecimals(formatEther(gsymbientBigInt), 6);

    return { symbientPerGsymbient, gsymbientPerSymbient };
  }, [index]);

  return { ...rates, isLoading };
}

/** Read the total supply of wstSYM from the contract (returns bigint in 18 decimals). */
export function useGsymbientTotalSupply() {
  const chainId = useChainId();
  const gsymbientAddress = getTokenAddress(TokenName.WSTSYM, chainId);
  const { data } = useReadContract({
    address: gsymbientAddress,
    abi: wstSYMAbi,
    functionName: "totalSupply",
    query: { enabled: !!gsymbientAddress },
  });
  return { totalSupply: data as bigint | undefined };
}
