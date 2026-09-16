import type { Address } from "viem";
import { parseUnits } from "viem";
import { useReadContract } from "wagmi";
import PriceAbi from "@/abis/Price";
import gSymbientAbi from "@/abis/wstSYM";
import { getTokenAddress, TokenName } from "@/lib/tokens";
import { getContractAddress, ContractName } from "@/lib/contracts";
import { formatTokenAmount } from "@/lib/math";

const ONE_Wstsym = parseUnits("1", 18);
const PRICE_QUERY_OPTIONS = {
  staleTime: 60_000,
  gcTime: 5 * 60_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

function sameAddress(a?: Address, b?: Address): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

export const useTokenPrice = (chainId: number, tokenAddress?: Address): { price: number } => {
  const shitAddress = getTokenAddress(TokenName.SYM, chainId);
  const usdsAddress = getTokenAddress(TokenName.USDS, chainId);
  const azusdAddress = getTokenAddress(TokenName.USDC, chainId);
  const gSymbientAddress = getTokenAddress(TokenName.Wstsym, chainId);
  const priceAddress = getContractAddress(ContractName.PRICE, chainId);

  const isSymbientToken = sameAddress(tokenAddress, shitAddress);
  const isUsdsToken = sameAddress(tokenAddress, usdsAddress);
  const isAzusdToken = sameAddress(tokenAddress, azusdAddress);
  const isWstsymToken = sameAddress(tokenAddress, gSymbientAddress);

  // PRICE module returns SYM price in reserve (USDS) with 18 decimals.
  const { data: shitPriceRaw } = useReadContract({
    address: priceAddress,
    abi: PriceAbi,
    functionName: "getCurrentPrice",
    chainId,
    query: {
      ...PRICE_QUERY_OPTIONS,
      enabled: !!tokenAddress && !!priceAddress && (isSymbientToken || isWstsymToken),
    },
  });

  // Convert exactly 1 wstSYM to SYM via token contract helper.
  // wstSymbientToStSymbient returns stSYM amount, then stSymbientPerToken gives SYM per stSYM.
  const { data: stSymbientFromOneWstsym } = useReadContract({
    address: gSymbientAddress,
    abi: gSymbientAbi,
    functionName: "wstSymbientToStSymbient",
    args: [ONE_Wstsym],
    chainId,
    query: {
      ...PRICE_QUERY_OPTIONS,
      enabled: !!tokenAddress && !!gSymbientAddress && isWstsymToken,
    },
  });

  const { data: stSymbientPerToken } = useReadContract({
    address: gSymbientAddress,
    abi: gSymbientAbi,
    functionName: "stSymbientPerToken",
    chainId,
    query: {
      ...PRICE_QUERY_OPTIONS,
      enabled: !!tokenAddress && !!gSymbientAddress && isWstsymToken,
    },
  });

  if (isUsdsToken || isAzusdToken) {
    // todo:Temporary assumption for stablecoin pricing.
    return { price: 1 };
  }

  if (isSymbientToken) {
    return { price: shitPriceRaw ? formatTokenAmount(shitPriceRaw) : 0 };
  }

  if (isWstsymToken) {
    if (!shitPriceRaw || !stSymbientFromOneWstsym || !stSymbientPerToken) return { price: 0 };

    const shitPriceUsd = formatTokenAmount(shitPriceRaw);
    const stSymbientPerWstSymbient = formatTokenAmount(stSymbientFromOneWstsym);
    const shitPerStSymbient = formatTokenAmount(stSymbientPerToken);
    const shitPerWstSymbient = stSymbientPerWstSymbient * shitPerStSymbient;

    return { price: shitPriceUsd * shitPerWstSymbient };
  }

  return { price: 0 };
};
