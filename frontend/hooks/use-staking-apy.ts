import { useReadContract, useChainId } from "wagmi";
import { ContractName, getContractAddress } from "@/lib/contracts";
import SymbientStakingAbi from "@/abis/SymbientStaking";
import stSymbientAbi from "@/abis/stFLYAI";
import { EPOCHS_PER_WEEK } from "@/lib/constants";

const EPOCHS_PER_YEAR = (EPOCHS_PER_WEEK / 7) * 365;

export function useStakingAPY() {
  const chainId = useChainId();
  const stakingAddress = getContractAddress(ContractName.STAKING, chainId);
  const stSymbientAddress = getContractAddress(ContractName.STFLYAI, chainId);

  const { data: epochData, isLoading: epochLoading } = useReadContract({
    address: stakingAddress,
    abi: SymbientStakingAbi,
    functionName: "epoch",
    query: { enabled: !!stakingAddress },
  });

  const { data: circulatingSupply, isLoading: supplyLoading } = useReadContract({
    address: stSymbientAddress,
    abi: stSymbientAbi,
    functionName: "totalSupply",
    query: { enabled: !!stSymbientAddress },
  });

  const isLoading = epochLoading || supplyLoading;

  let apy: number | undefined;

  if (epochData && circulatingSupply) {
    const distribute = epochData[3];
    const supply = circulatingSupply as bigint;
    if (supply > 0n) {
      // APY = (distribute / supply) * epochs_per_year * 100
      // Use Number for the ratio since values are in the same decimals
      const ratio = Number(distribute) / Number(supply);
      apy = ratio * EPOCHS_PER_YEAR * 100;
    }
  }

  return { apy, isLoading };
}
