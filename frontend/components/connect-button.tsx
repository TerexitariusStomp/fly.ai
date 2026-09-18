import { useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { useAppKit } from "@reown/appkit/react";
import { useConnectedAddress } from "@/hooks/use-connected-address";
import { Button } from "@/components/ui-button";
import { Icon } from "@/components/icon";
import { ChainIcon } from "@/components/chain-icon";
import { allChains } from "@/lib/chains";

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Connect button using an injected wallet first, with Reown AppKit as fallback.
 * This keeps the app usable without requiring a WalletConnect project ID.
 */
export function ConnectButton() {
  const { open } = useAppKit();
  const { connect, connectors, isPending } = useConnect();
  const { switchChain } = useSwitchChain();
  const { address, isConnected, chainId } = useConnectedAddress();
  const { disconnect } = useDisconnect();

  const activeChain = allChains.find((c) => c.id === chainId);
  const isWrongNetwork = isConnected && !activeChain;
  const connected = address && isConnected;

  const handleConnect = () => {
    const injected = connectors.find((connector) => connector.id === "injected");
    if (injected) {
      connect({ connector: injected, chainId: allChains[0].id });
    } else {
      open();
    }
  };

  const handleSwitchNetwork = () => {
    switchChain({ chainId: allChains[0].id });
  };

  if (!connected) {
    return (
      <Button onClick={handleConnect} size="md" disabled={isPending}>
        <Icon name="WalletIcon" size={16} className="mr-2" />
        {isPending ? "Connecting…" : "Connect Wallet"}
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {isWrongNetwork ? (
        <Button onClick={handleSwitchNetwork} variant="destructive" size="md">
          Switch to Robinhood
        </Button>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-a10 px-3 py-2">
          {activeChain && <ChainIcon chainId={activeChain.id} />}
          <span className="font-mono text-sm text-primary-t">{shortenAddress(address!)}</span>
        </div>
      )}
      <Button onClick={() => disconnect()} variant="secondary" size="md">
        Disconnect
      </Button>
    </div>
  );
}
