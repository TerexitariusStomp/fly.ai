import type { Address } from "viem";
import { parseUnits } from "viem";
import { useReadContract } from "wagmi";
import PriceAbi from "@/abis/Price";
import gSymbientAbi from "@/abis/wstSYM";
import { getTokenAddress, TokenName } from "@/lib/tokens";
import { getContractAddress, ContractName } from "@/lib/contracts";
import { formatTokenAmount } from "@/lib/math";

const ONE_WSTSYM = parseUnits("1", 18);
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
  const symbientAddress = getTokenAddress(TokenName.SYM, chainId);
  const gSymbientAddress = getTokenAddress(TokenName.WSTSYM, chainId);
  const priceAddress = getContractAddress(ContractName.PRICE, chainId);

  const isSymbientToken = sameAddress(tokenAddress, symbientAddress);
  const isWSTSYMToken = sameAddress(tokenAddress, gSymbientAddress);

  // PRICE module returns SYM price in reserve units with 18 decimals.
  const { data: symbientPriceRaw } = useReadContract({
    address: priceAddress,
    abi: PriceAbi,
    functionName: "getCurrentPrice",
    chainId,
    query: {
      ...PRICE_QUERY_OPTIONS,
      enabled: !!tokenAddress && !!priceAddress && (isSymbientToken || isWSTSYMToken),
    },
  });

  // Convert exactly 1 wstSYM to SYM via token contract helper.
  // wstSymbientToStSymbient returns stSYM amount, then stSymbientPerToken gives SYM per stSYM.
  const { data: stSymbientFromOneWSTSYM } = useReadContract({
    address: gSymbientAddress,
    abi: gSymbientAbi,
    functionName: "wstSymbientToStSymbient",
    args: [ONE_WSTSYM],
    chainId,
    query: {
      ...PRICE_QUERY_OPTIONS,
      enabled: !!tokenAddress && !!gSymbientAddress && isWSTSYMToken,
    },
  });

  const { data: stSymbientPerToken } = useReadContract({
    address: gSymbientAddress,
    abi: gSymbientAbi,
    functionName: "stSymbientPerToken",
    chainId,
    query: {
      ...PRICE_QUERY_OPTIONS,
      enabled: !!tokenAddress && !!gSymbientAddress && isWSTSYMToken,
    },
  });

  if (isSymbientToken) {
    return { price: symbientPriceRaw ? formatTokenAmount(symbientPriceRaw) : 0 };
  }

  if (isWSTSYMToken) {
    if (!symbientPriceRaw || !stSymbientFromOneWSTSYM || !stSymbientPerToken) return { price: 0 };

    const symbientPriceUsd = formatTokenAmount(symbientPriceRaw);
    const stSymbientPerWstSymbient = formatTokenAmount(stSymbientFromOneWSTSYM);
    const symbientPerStSymbient = formatTokenAmount(stSymbientPerToken);
    const symbientPerWstSymbient = stSymbientPerWstSymbient * symbientPerStSymbient;

    return { price: symbientPriceUsd * symbientPerWstSymbient };
  }

  return { price: 0 };
};
