import { useMemo, useState } from "react";
import { useChainId, usePublicClient, useReadContract } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { erc20Abi, formatUnits, type Address } from "viem";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui-button";
import { ConnectButton } from "@/components/connect-button";
import { Card } from "@/components/ui-card";
import { Skeleton } from "@/components/ui-skeleton";
import { TokenBigInput } from "@/components/ui-token-big-input";
import { useConnectedAddress } from "@/hooks/use-connected-address";
import { useConnectedWalletClient } from "@/hooks/use-connected-wallet-client";
import { useToken } from "@/hooks/use-token";
import { ContractName, getContractAddress } from "@/lib/contracts";
import { getBlockExplorerTxUrl } from "@/lib/helpers";
import { TokenName } from "@/lib/tokens";
import { parseTokenAmount } from "@/lib/utils-token-amount";
import InverseBondAbi from "@/abis/InverseBond";

type TxState =
  | { status: "idle" }
  | { status: "approve-wallet" | "approve-confirming" | "sell-wallet" | "sell-confirming"; hash?: `0x${string}` }
  | { status: "success"; hash: `0x${string}` }
  | { status: "error"; message: string; hash?: `0x${string}` };

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export function InverseBondCard() {
  const { address } = useConnectedAddress();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();
  const { walletClient } = useConnectedWalletClient();
  const flyai = useToken(TokenName.FLYAI, address);
  const [amount, setAmount] = useState("");
  const [tx, setTx] = useState<TxState>({ status: "idle" });

  const bondAddress = getContractAddress(ContractName.INVERSE_BOND, chainId);
  const flyaiAddress = flyai.address;
  const amountWei = parseTokenAmount(amount, flyai.decimals);
  const enabled = !!bondAddress && bondAddress !== ZERO;

  const { data: bondPrice, isLoading: priceLoading } = useReadContract({
    address: bondAddress,
    abi: InverseBondAbi,
    functionName: "bondPrice",
    query: { enabled },
  });
  const { data: epochCapacity, isLoading: capacityLoading } = useReadContract({
    address: bondAddress,
    abi: InverseBondAbi,
    functionName: "epochCapacity",
    query: { enabled },
  });
  const { data: epochUsedCapacity } = useReadContract({
    address: bondAddress,
    abi: InverseBondAbi,
    functionName: "epochUsedCapacity",
    query: { enabled },
  });
  const { data: payoutToken } = useReadContract({
    address: bondAddress,
    abi: InverseBondAbi,
    functionName: "payoutToken",
    query: { enabled },
  });
  const { data: payoutSymbol } = useReadContract({
    address: payoutToken,
    abi: erc20Abi,
    functionName: "symbol",
    query: { enabled: !!payoutToken },
  });
  const { data: payoutDecimals } = useReadContract({
    address: payoutToken,
    abi: erc20Abi,
    functionName: "decimals",
    query: { enabled: !!payoutToken },
  });
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: flyaiAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && bondAddress ? [address, bondAddress] : undefined,
    query: { enabled: !!address && !!flyaiAddress && enabled },
  });

  const decimals = payoutDecimals ?? 18;
  const estimatedPayout = bondPrice && amountWei > 0n ? (amountWei * bondPrice) / 10n ** 18n : 0n;
  const capacityRemaining =
    epochCapacity !== undefined && epochUsedCapacity !== undefined
      ? epochCapacity > epochUsedCapacity
        ? epochCapacity - epochUsedCapacity
        : 0n
      : undefined;

  const hasInsufficientBalance = flyai.balance !== undefined && amountWei > flyai.balance;
  const exceedsCapacity = capacityRemaining !== undefined && estimatedPayout > capacityRemaining;
  const busy =
    tx.status === "approve-wallet" ||
    tx.status === "approve-confirming" ||
    tx.status === "sell-wallet" ||
    tx.status === "sell-confirming";

  const buttonLabel = useMemo(() => {
    if (!address) return "Connect Wallet";
    if (!enabled) return "Bond unavailable on this chain";
    if (amountWei === 0n) return "Enter FLYAI amount";
    if (hasInsufficientBalance) return "Insufficient FLYAI";
    if (exceedsCapacity) return "Exceeds epoch capacity";
    if (tx.status === "approve-wallet" || tx.status === "approve-confirming") return "Approving FLYAI…";
    if (tx.status === "sell-wallet" || tx.status === "sell-confirming") return "Selling FLYAI…";
    return "Sell FLYAI to Treasury";
  }, [address, enabled, amountWei, hasInsufficientBalance, exceedsCapacity, tx.status]);

  const submit = async () => {
    if (!address || !publicClient || !walletClient || !bondAddress || !flyaiAddress || amountWei === 0n) return;
    try {
      let currentAllowance = allowance ?? 0n;
      if (currentAllowance < amountWei) {
        setTx({ status: "approve-wallet" });
        const approveHash = await walletClient.writeContract({
          address: flyaiAddress,
          abi: erc20Abi,
          functionName: "approve",
          args: [bondAddress, amountWei],
        } as any);
        setTx({ status: "approve-confirming", hash: approveHash });
        const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
        if (approveReceipt.status !== "success") throw new Error("FLYAI approval reverted");
        currentAllowance = amountWei;
        await refetchAllowance();
      }

      setTx({ status: "sell-wallet" });
      const sellHash = await walletClient.writeContract({
        address: bondAddress,
        abi: InverseBondAbi,
        functionName: "sell",
        args: [amountWei],
      } as any);
      setTx({ status: "sell-confirming", hash: sellHash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: sellHash });
      if (receipt.status !== "success") {
        throw new Error("Inverse bond sell reverted — capacity may be exhausted or the circuit breaker may be active");
      }
      setTx({ status: "success", hash: sellHash });
      setAmount("");
      queryClient.invalidateQueries();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTx((current) => ({
        status: "error",
        message,
        hash: "hash" in current ? current.hash : undefined,
      }));
    }
  };

  return (
    <Card className="p-6">
      <div className="flex flex-col gap-5">
        <div>
          <h2 className="text-lg font-semibold text-primary-t">Inverse Bond</h2>
          <p className="mt-1 text-sm text-secondary-t">
            Sell FLYAI directly to the protocol treasury at the floor defense price. The FLYAI is burned and the treasury pays out reserve tokens.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <div className="text-xs text-secondary-t">Bond price</div>
            {priceLoading ? (
              <Skeleton className="mt-1 h-5 w-20" />
            ) : (
              <div className="mt-1 text-sm font-semibold text-primary-t">
                {bondPrice !== undefined ? formatUnits(bondPrice, decimals) : "—"} {payoutSymbol ?? "reserve"}
              </div>
            )}
          </div>
          <div>
            <div className="text-xs text-secondary-t">Epoch capacity</div>
            {capacityLoading ? (
              <Skeleton className="mt-1 h-5 w-20" />
            ) : (
              <div className="mt-1 text-sm font-semibold text-primary-t">
                {epochCapacity !== undefined ? formatUnits(epochCapacity, decimals) : "—"} {payoutSymbol ?? "reserve"}
              </div>
            )}
          </div>
          <div>
            <div className="text-xs text-secondary-t">Capacity used</div>
            <div className="mt-1 text-sm font-semibold text-primary-t">
              {epochUsedCapacity !== undefined ? formatUnits(epochUsedCapacity, decimals) : "—"} {payoutSymbol ?? "reserve"}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <TokenBigInput
            label="You sell"
            token={flyai}
            value={amount}
            onChange={(value) => setAmount(value as string)}
          />
          <div className="rounded-2xl border border-a3-b bg-surface-a3 p-4">
            <div className="text-xs text-secondary-t">Estimated payout</div>
            <div className="mt-2 text-2xl font-semibold text-primary-t">
              {estimatedPayout > 0n ? formatUnits(estimatedPayout, decimals) : "0"} {payoutSymbol ?? "reserve"}
            </div>
            <div className="mt-2 text-xs text-tertiary-t">
              Capacity remaining: {capacityRemaining !== undefined ? formatUnits(capacityRemaining, decimals) : "—"} {payoutSymbol ?? "reserve"}
            </div>
          </div>
        </div>

        {address ? (
          <Button className="w-full" disabled={!enabled || amountWei === 0n || hasInsufficientBalance || exceedsCapacity || busy} onClick={submit}>
            {buttonLabel}
          </Button>
        ) : (
          <ConnectButton />
        )}

        {tx.status === "error" && <p className="text-sm text-red">{tx.message}</p>}
        {tx.status === "success" && <p className="text-sm text-green">Inverse bond sell confirmed.</p>}
        {"hash" in tx && tx.hash && (
          <a
            href={getBlockExplorerTxUrl(chainId, tx.hash)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-secondary-t hover:text-primary-t"
          >
            View transaction <ExternalLink className="size-3" />
          </a>
        )}
      </div>
    </Card>
  );
}
