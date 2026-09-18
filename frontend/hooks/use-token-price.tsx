import type { Address } from "viem";
import { parseUnits } from "viem";
import { useReadContract } from "wagmi";
import PriceAbi from "@/abis/Price";
import wstFlyaiAbi from "@/abis/wstFLYAI";
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
  const flyaiAddress = getTokenAddress(TokenName.FLYAI, chainId);
  const wstFlyaiAddress = getTokenAddress(TokenName.WSTFLYAI, chainId);
  const priceAddress = getContractAddress(ContractName.PRICE, chainId);

  const isFlyaiToken = sameAddress(tokenAddress, flyaiAddress);
  const isWSTFLYAIToken = sameAddress(tokenAddress, wstFlyaiAddress);

  // PRICE module returns FLYAI price in reserve units with 18 decimals.
  const { data: flyaiPriceRaw } = useReadContract({
    address: priceAddress,
    abi: PriceAbi,
    functionName: "getCurrentPrice",
    chainId,
    query: {
      ...PRICE_QUERY_OPTIONS,
      enabled: !!tokenAddress && !!priceAddress && (isFlyaiToken || isWSTFLYAIToken),
    },
  });

  // Convert exactly 1 wstFLYAI to FLYAI via token contract helper.
  // The wstFLYAI contract returns stFLYAI amount, then its index gives FLYAI per stFLYAI.
  const { data: stFlyaiFromOneWstFlyai } = useReadContract({
    address: wstFlyaiAddress,
    abi: wstFlyaiAbi,
    functionName: "wstSymbientToStSymbient",
    args: [ONE_WSTFLYAI],
    chainId,
    query: {
      ...PRICE_QUERY_OPTIONS,
      enabled: !!tokenAddress && !!wstFlyaiAddress && isWSTFLYAIToken,
    },
  });

  const { data: stFlyaiPerToken } = useReadContract({
    address: wstFlyaiAddress,
    abi: wstFlyaiAbi,
    functionName: "stSymbientPerToken",
    chainId,
    query: {
      ...PRICE_QUERY_OPTIONS,
      enabled: !!tokenAddress && !!wstFlyaiAddress && isWSTFLYAIToken,
    },
  });

  if (isFlyaiToken) {
    return { price: flyaiPriceRaw ? formatTokenAmount(flyaiPriceRaw) : 0 };
  }

  if (isWSTFLYAIToken) {
    if (!flyaiPriceRaw || !stFlyaiFromOneWstFlyai || !stFlyaiPerToken) return { price: 0 };

    const flyaiPriceUsd = formatTokenAmount(flyaiPriceRaw);
    const stFlyaiPerWstFlyai = formatTokenAmount(stFlyaiFromOneWstFlyai);
    const flyaiPerStFlyai = formatTokenAmount(stFlyaiPerToken);
    const flyaiPerWstFlyai = stFlyaiPerWstFlyai * flyaiPerStFlyai;

    return { price: flyaiPriceUsd * flyaiPerWstFlyai };
  }

  return { price: 0 };
};
