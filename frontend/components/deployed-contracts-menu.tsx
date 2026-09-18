import { useEffect, useRef, useState } from "react";
import { useChainId } from "wagmi";
import { ExternalLink, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { getContractExplorerUrl, getDeployedContracts } from "@/lib/deployed-contracts";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function DeployedContractsMenu({ className }: { className?: string }) {
  const chainId = useChainId();
  const contracts = getDeployedContracts(chainId);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (contracts.length === 0) return null;

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-secondary-t transition-colors hover:bg-surface-a5 hover:text-primary-t"
        aria-expanded={open}
      >
        <FileText className="size-3.5" />
        Contracts
      </button>

      {open && (
        <div className="absolute bottom-8 left-0 z-50 max-h-80 w-72 overflow-y-auto rounded-2xl border border-a10-b bg-surface-tooltip p-2 shadow-lg">
          <div className="px-2 py-1 text-xs font-semibold text-primary-t">Deployed contracts</div>
          <div className="px-2 pb-2 text-[11px] text-tertiary-t">
            User actions are limited to staking, wrapping, and the inverse bond.
          </div>
          {contracts.map((contract) => (
            <a
              key={contract.address}
              href={getContractExplorerUrl(chainId, contract.address)}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-start justify-between gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-surface-a5"
            >
              <span>
                <span className="block text-xs font-medium text-primary-t">{contract.name}</span>
                <span className="block text-[11px] text-secondary-t">{contract.description}</span>
                <span className="block font-mono text-[10px] text-tertiary-t">
                  {shortAddress(contract.address)}
                </span>
              </span>
              <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-tertiary-t group-hover:text-primary-t" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
