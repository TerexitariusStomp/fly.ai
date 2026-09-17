import type { Address } from "viem";
import { parseUnits } from "viem";
import { useReadContract } from "wagmi";
import PriceAbi from "@/abis/Price";
import gSymbientAbi from "@/abis/wstFLYAI";
import { getTokenAddress, TokenName } from "@/lib/tokens";
import { getContractAddress, ContractName } from "@/lib/contracts";
import { formatTokenAmount } from "@/lib/math";

const ONE_WSTFLYAI = parseUnits("1", 18);
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
  const symbientAddress = getTokenAddress(TokenName.FLYAI, chainId);
  const gSymbientAddress = getTokenAddress(TokenName.WSTFLYAI, chainId);
  const priceAddress = getContractAddress(ContractName.PRICE, chainId);

  const isSymbientToken = sameAddress(tokenAddress, symbientAddress);
  const isWSTFLYAIToken = sameAddress(tokenAddress, gSymbientAddress);

  // PRICE module returns FLYAI price in reserve units with 18 decimals.
  const { data: symbientPriceRaw } = useReadContract({
    address: priceAddress,
    abi: PriceAbi,
    functionName: "getCurrentPrice",
    chainId,
    query: {
      ...PRICE_QUERY_OPTIONS,
      enabled: !!tokenAddress && !!priceAddress && (isSymbientToken || isWSTFLYAIToken),
    },
  });

  // Convert exactly 1 wstFLYAI to FLYAI via token contract helper.
  // wstSymbientToStSymbient returns stFLYAI amount, then stSymbientPerToken gives FLYAI per stFLYAI.
  const { data: stSymbientFromOneWSTFLYAI } = useReadContract({
    address: gSymbientAddress,
    abi: gSymbientAbi,
    functionName: "wstSymbientToStSymbient",
    args: [ONE_WSTFLYAI],
    chainId,
    query: {
      ...PRICE_QUERY_OPTIONS,
      enabled: !!tokenAddress && !!gSymbientAddress && isWSTFLYAIToken,
    },
  });

  const { data: stSymbientPerToken } = useReadContract({
    address: gSymbientAddress,
    abi: gSymbientAbi,
    functionName: "stSymbientPerToken",
    chainId,
    query: {
      ...PRICE_QUERY_OPTIONS,
      enabled: !!tokenAddress && !!gSymbientAddress && isWSTFLYAIToken,
    },
  });

  if (isSymbientToken) {
    return { price: symbientPriceRaw ? formatTokenAmount(symbientPriceRaw) : 0 };
  }

  if (isWSTFLYAIToken) {
    if (!symbientPriceRaw || !stSymbientFromOneWSTFLYAI || !stSymbientPerToken) return { price: 0 };

    const symbientPriceUsd = formatTokenAmount(symbientPriceRaw);
    const stSymbientPerWstSymbient = formatTokenAmount(stSymbientFromOneWSTFLYAI);
    const symbientPerStSymbient = formatTokenAmount(stSymbientPerToken);
    const symbientPerWstSymbient = stSymbientPerWstSymbient * symbientPerStSymbient;

    return { price: symbientPriceUsd * symbientPerWstSymbient };
  }

  return { price: 0 };
};
