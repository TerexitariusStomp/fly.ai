import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChainId, usePublicClient } from "wagmi";
import { useConnectedAddress } from "@/hooks/use-connected-address";
import { usePrivyWalletClient } from "@/hooks/use-privy-wallet-client";
import { useQueryClient } from "@tanstack/react-query";
import { erc20Abi, type Abi, type Address } from "viem";
import { ContractName, getContractAddress } from "@/lib/contracts";
import { TokenName, getTokenAddress } from "@/lib/tokens";
import SymbientStakingAbi from "@/abis/SymbientStaking";
import wstSymbientAbi from "@/abis/wstSYM";
import type { WrapFlow } from "@/modules/symbient-wrap-flows";

export type SeqStepStatus = "pending" | "wallet" | "confirming" | "done" | "error";

export type SeqStep = {
  id: string;
  label: string;
  status: SeqStepStatus;
  hash?: `0x${string}`;
};

type PlanStep =
  | { kind: "approve"; token: TokenName; spender: ContractName; label: string }
  | {
      kind: "call";
      contract: ContractName;
      abi: Abi;
      functionName: string;
      label: string;
      argsBuilder: (address: Address, amount: bigint) => readonly unknown[];
      amount: "input" | "stSymbientDelta" | "wstSymbientDelta";
    };

function buildPlan(flow: WrapFlow): PlanStep[] {
  const stakeArgs = (addr: Address, amt: bigint) => [addr, amt, false, false] as const;
  const stakeArgsRebasing = (addr: Address, amt: bigint) => [addr, amt, true, false] as const;
  const unstakeArgs = (addr: Address, amt: bigint) => [addr, amt, false, false] as const;
  const unstakeArgsRebasing = (addr: Address, amt: bigint) => [addr, amt, false, true] as const;
  const singleArg = (_addr: Address, amt: bigint) => [amt] as const;

  switch (flow) {
    case "wrap-symbient":
      return [
        { kind: "approve", token: TokenName.SYM, spender: ContractName.STAKING, label: "Approve SYM" },
        { kind: "call", contract: ContractName.STAKING, abi: SymbientStakingAbi, functionName: "stake", label: "Stake SYM to stSYM", argsBuilder: stakeArgsRebasing, amount: "input" },
      ];
    case "wrap-symbient-to-wstsymbient":
      return [
        { kind: "approve", token: TokenName.SYM, spender: ContractName.STAKING, label: "Approve SYM" },
        { kind: "call", contract: ContractName.STAKING, abi: SymbientStakingAbi, functionName: "stake", label: "Stake SYM to wstSYM", argsBuilder: stakeArgs, amount: "input" },
      ];
    case "wrap-stsymbient":
      return [
        { kind: "approve", token: TokenName.STSYM, spender: ContractName.WSTSYM, label: "Approve stSYM" },
        { kind: "call", contract: ContractName.WSTSYM, abi: wstSymbientAbi, functionName: "wrap", label: "Wrap stSYM to wstSYM", argsBuilder: singleArg, amount: "input" },
      ];
    case "unwrap-wstsymbient":
      return [
        { kind: "call", contract: ContractName.WSTSYM, abi: wstSymbientAbi, functionName: "unwrap", label: "Unwrap wstSYM to stSYM", argsBuilder: singleArg, amount: "input" },
      ];
    case "unwrap-wstsymbient-to-symbient":
      return [
        { kind: "approve", token: TokenName.WSTSYM, spender: ContractName.STAKING, label: "Approve wstSYM" },
        { kind: "call", contract: ContractName.STAKING, abi: SymbientStakingAbi, functionName: "unstake", label: "Unstake wstSYM to SYM", argsBuilder: unstakeArgs, amount: "input" },
      ];
    case "unstake-stsymbient":
      return [
        { kind: "approve", token: TokenName.STSYM, spender: ContractName.STAKING, label: "Approve stSYM" },
        { kind: "call", contract: ContractName.STAKING, abi: SymbientStakingAbi, functionName: "unstake", label: "Unstake stSYM to SYM", argsBuilder: unstakeArgsRebasing, amount: "input" },
      ];
  }
}


export function useWrapFlowSequence(flow: WrapFlow, inputAmount: bigint) {
  const { address } = useConnectedAddress();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();
  const { walletClient } = usePrivyWalletClient();

  const [steps, setSteps] = useState<SeqStep[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const cancelledRef = useRef(false);

  const plan = useMemo(() => buildPlan(flow), [flow]);

  useEffect(() => {
    setSteps(plan.map((p, i) => ({ id: `${i}`, label: p.label, status: "pending" })));
    setDone(false);
    setError(null);
  }, [plan]);

  const stSymbientAddress = getTokenAddress(TokenName.STSYM, chainId);
  const wstSymbientAddress = getTokenAddress(TokenName.WSTSYM, chainId);

  const setStep = (i: number, patch: Partial<SeqStep>) =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const readStSymbientBalance = useCallback(async (): Promise<bigint> => {
    if (!publicClient || !address || !stSymbientAddress) return 0n;
    return (await publicClient.readContract({
      address: stSymbientAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    })) as bigint;
  }, [publicClient, address, stSymbientAddress]);

  const readWstSymbientBalance = useCallback(async (): Promise<bigint> => {
    if (!publicClient || !address || !wstSymbientAddress) return 0n;
    return (await publicClient.readContract({
      address: wstSymbientAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    })) as bigint;
  }, [publicClient, address, wstSymbientAddress]);

  const estimateGas = useCallback(
    async (call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }) => {
      try {
        if (publicClient && address) {
          const est = await publicClient.estimateContractGas({ ...call, account: address });
          const buffered = (est * 3n) / 2n;
          return buffered > 5_000_000n ? 5_000_000n : buffered;
        }
      } catch {
        // Estimation failed — return undefined to let wallet estimate
      }
      return undefined;
    },
    [publicClient, address],
  );

  const run = useCallback(async () => {
    console.log("[wrap-seq] run()", { address, hasPublicClient: !!publicClient, flow, inputAmount: inputAmount.toString(), chainId });
    if (!address) {
      setError(new Error("Wallet not connected"));
      return;
    }
    if (!publicClient) {
      setError(new Error("Chain client not ready — is your wallet on Arc testnet?"));
      return;
    }
    if (!walletClient) {
      setError(new Error("Wallet not connected. Please sign in via Privy."));
      return;
    }
    cancelledRef.current = false;
    setError(null);
    setDone(false);
    setRunning(true);

    const initial: SeqStep[] = plan.map((p, i) => ({ id: `${i}`, label: p.label, status: "pending" }));
    setSteps(initial);

    const preStSymbient = await readStSymbientBalance();
    const preWstSymbient = await readWstSymbientBalance();

    try {
      for (let i = 0; i < plan.length; i++) {
        if (cancelledRef.current) throw new Error("Cancelled");
        const step = plan[i];
        setStep(i, { status: "wallet" });

        if (step.kind === "approve") {
          const tokenAddress = getTokenAddress(step.token, chainId);
          const spender = getContractAddress(step.spender, chainId);
          console.log("[wrap-seq] approve step", { tokenAddress, spender });
          if (!tokenAddress || !spender) throw new Error(`Missing token/spender address (token=${tokenAddress}, spender=${spender})`);

          const current = (await publicClient.readContract({
            address: tokenAddress,
            abi: erc20Abi,
            functionName: "allowance",
            args: [address, spender],
          })) as bigint;
          if (current >= inputAmount) {
            setStep(i, { status: "done" });
            continue;
          }

          const hash = await walletClient.writeContract({
            address: tokenAddress,
            abi: erc20Abi,
            functionName: "approve",
            args: [spender, inputAmount],
          } as any);
          setStep(i, { status: "confirming", hash });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new Error(`${step.label} reverted on-chain. Check the transaction on BaseScan for details.`);
          setStep(i, { status: "done", hash });
        } else {
          const target = getContractAddress(step.contract, chainId);
          console.log("[wrap-seq] call step", { contract: step.contract, fn: step.functionName, target });
          if (!target) throw new Error(`Missing contract address for ${step.contract}`);

          const amount =
            step.amount === "stSymbientDelta"
              ? (await readStSymbientBalance()) - preStSymbient
              : step.amount === "wstSymbientDelta"
                ? (await readWstSymbientBalance()) - preWstSymbient
                : inputAmount;
          if (amount <= 0n) throw new Error("Nothing to process for this step");

          const call = { address: target, abi: step.abi, functionName: step.functionName, args: step.argsBuilder(address, amount) };
          const gas = await estimateGas(call);
          const hash = await walletClient.writeContract({ ...call, ...(gas ? { gas } : {}) } as any);
          setStep(i, { status: "confirming", hash });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new Error(`${step.label} reverted on-chain. This may happen if the staking contract is paused, the circuit breaker is tripped, or there is insufficient liquidity. Check the transaction on BaseScan for details.`);
          setStep(i, { status: "done", hash });
        }
      }

      queryClient.invalidateQueries();
      setDone(true);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error("[wrap-seq] failed:", err);
      setError(err);
      setSteps((prev) => prev.map((s) => (s.status === "wallet" || s.status === "confirming" ? { ...s, status: "error" } : s)));
    } finally {
      setRunning(false);
    }
  }, [address, publicClient, walletClient, plan, chainId, inputAmount, readStSymbientBalance, estimateGas, queryClient]);

  const reset = useCallback(() => {
    cancelledRef.current = true;
    setSteps(plan.map((p, i) => ({ id: `${i}`, label: p.label, status: "pending" })));
    setRunning(false);
    setDone(false);
    setError(null);
  }, [plan]);

  return { steps, run, reset, running, done, error };
}
