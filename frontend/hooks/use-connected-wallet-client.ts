import { useMemo } from "react";
import { useConnectorClient } from "wagmi";
import { type WalletClient, type Address } from "viem";
import { useConnectedAddress } from "@/hooks/use-connected-address";

/**
 * Gets a viem WalletClient from the connected wallet via wagmi.
 */
export function useConnectedWalletClient() {
  const { address: connectedAddress, chainId } = useConnectedAddress();
  const { data: connectorClient } = useConnectorClient();

  const walletClient = useMemo(() => {
    if (!connectorClient || !connectedAddress) return undefined;
    return connectorClient as WalletClient;
  }, [connectorClient, connectedAddress]);

  return {
    walletClient,
    address: connectedAddress as Address | undefined,
    chainId,
  };
}
