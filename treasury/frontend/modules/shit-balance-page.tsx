import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useConnectedAddress } from "@/hooks/use-connected-address";
import { ConnectButton } from "@/components/connect-button";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
} from "@tanstack/react-table";
import { ChevronDown } from "lucide-react";
import { RiArrowRightUpLine, RiWalletLine } from "@remixicon/react";
import { useAllTokenBalances } from "@/hooks/use-all-token-balances";
import { TokenName, TOKENS } from "@/lib/tokens";
import { useIsMobile } from "@/hooks/use-mobile";
import { useMockData } from "@/lib/mock-provider";
import { useMigrationClaim } from "@/hooks/use-migration-claim";
import { useV1MigrationInfo, useV1MigratorMerkleRoot } from "@/hooks/use-v1-migration-info";
import { MigrateSymbientModal } from "@/components/migrate-symbient-modal";
import { UnstakeStSymbientModal } from "@/components/unstake-stsym-modal";
import { UnwrapWstSymbientModal } from "@/components/unwrap-wstsym-modal";
import { Icon, type IconName } from "@/components/icon";
import { ChainIcon } from "@/components/chain-icon";
import { useToken } from "@/hooks/use-token";
import { Card } from "@/components/ui-card";
import { Button } from "@/components/ui-button";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui-collapsible";
import { Skeleton } from "@/components/ui-skeleton";
import { NumberFlow } from "@/components/ui-number-flow.tsx";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui-table.tsx";
import { Tooltip } from "@/components/ui-tooltip.tsx";
import type { MultiChainBalanceResult, ChainBalance } from "@/hooks/use-multi-chain-balance.tsx";
import { isTestnetMode } from "@/lib/chains";

// ─── Migration action types & helpers ───

type MigrationStatus =
  | "loading"
  | "error"
  | "ineligible"
  | "not-live"
  | "fully-migrated"
  | "ready";

type MigrationAction = {
  status: MigrationStatus;
  onMigrate: () => void;
};

const LEGACY_ACTION_TOOLTIP = "Available on Ethereum only.";

const MIGRATION_TOOLTIP: Partial<Record<MigrationStatus, string>> = {
  error: "Couldn't check your migration eligibility. Refresh to try again.",
  ineligible: "This address isn't in the migration snapshot.",
  "not-live": "Migration isn't live yet.",
  "fully-migrated": "You've migrated your full allocation.",
};

type TokenAction = {
  label: string;
  to?: string;
  disabled?: boolean;
  onClick?: () => void;
  tooltip?: string;
};

function getTokenAction(
  symbol: string,
  chainName: string,
  migration?: MigrationAction,
  onUnstakeV1?: () => void,
  onUnwrapWstSymbient?: () => void,
): TokenAction {
  const isHomeChain = chainName === "Ethereum" || chainName === "Sepolia";
  switch (symbol) {
    case "SYM":
      return isHomeChain
        ? { label: "Wrap", to: "/symbient/wrap" }
        : { label: "Bridge", to: "/symbient/bridge" };
    case "stSYM":
      return { label: "Wrap", to: `/symbient/wrap?token=${symbol}` };
    case "wstSYM":
      return isHomeChain
        ? { label: "Unwrap", to: "/symbient/wrap?mode=unwrap" }
        : { label: "Bridge", to: "/symbient/bridge" };
    case "SYM v1":
      return getMigrateAction(migration);
    case "stSYM v1":
      return isHomeChain && onUnstakeV1
        ? { label: "Unstake", onClick: onUnstakeV1 }
        : {
            label: "Unstake",
            disabled: true,
            tooltip: isHomeChain ? undefined : LEGACY_ACTION_TOOLTIP,
          };
    case "wsSHIT":
      return isHomeChain && onUnwrapWstSymbient
        ? { label: "Unwrap", onClick: onUnwrapWstSymbient }
        : {
            label: "Unwrap",
            disabled: true,
            tooltip: isHomeChain ? undefined : LEGACY_ACTION_TOOLTIP,
          };
    default:
      return { label: "View", disabled: true };
  }
}

function getMigrateAction(migration?: MigrationAction): TokenAction {
  if (!migration || migration.status === "loading") return { label: "Migrate", disabled: true };
  if (migration.status === "ready") return { label: "Migrate", onClick: migration.onMigrate };
  return {
    label: migration.status === "fully-migrated" ? "Migrated" : "Migrate",
    disabled: true,
    tooltip: MIGRATION_TOOLTIP[migration.status],
  };
}

// ─── Shared types ───

type TokenEntry = {
  symbol: string;
  label: string;
  sublabel?: string;
  icon: IconName;
  balances: MultiChainBalanceResult;
  price: number;
};

// ─── Balance info cards ───

type InfoCardContent = {
  title: string;
  body: string;
  href: string;
  ctaLabel: string;
};

const INFO_CARDS: InfoCardContent[] = [];

function InfoCardBody({ body, href, ctaLabel }: Omit<InfoCardContent, "title">) {
  return (
    <>
      <p className="text-secondary-t text-sm/5 mb-6">{body}</p>
      <Button
        variant="secondary"
        className="mt-auto w-full"
        render={<a href={href} target="_blank" rel="noopener noreferrer" />}
      >
        {ctaLabel} <RiArrowRightUpLine size={16} />
      </Button>
    </>
  );
}

function BalanceInfoCards({ isMobile }: { isMobile: boolean }) {
  if (isMobile) {
    return (
      <div className="space-y-3">
        {INFO_CARDS.map(({ title, ...rest }) => (
          <Collapsible key={title}>
            <Card className="p-4">
              <CollapsibleTrigger className="flex w-full items-center justify-between cursor-pointer">
                <span className="font-medium text-primary-t">{title}</span>
                <ChevronDown className="size-4 text-tertiary-t transition-transform [[data-panel-open]_&]:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <InfoCardBody {...rest} />
              </CollapsibleContent>
            </Card>
          </Collapsible>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 max-w-md">
      {INFO_CARDS.map(({ title, ...rest }) => (
        <Card key={title} className="p-6 flex flex-col">
          <h3 className="mb-2 text-sm/5 font-semibold">{title}</h3>
          <InfoCardBody {...rest} />
        </Card>
      ))}
    </div>
  );
}

// ─── Balance wallet value ───

function BalanceWalletValue({ totalUsd, isLoading }: { totalUsd: number; isLoading: boolean }) {
  return (
    <div className="flex items-center gap-x-2 mb-3">
      <RiWalletLine size={24} />
      <span className="text-[20px]/[24px] font-semibold">In Wallet:</span>
      {isLoading ? (
        <Skeleton className="h-7 w-32" />
      ) : (
        <NumberFlow
          className=" text-[20px]/[24px] font-semibold"
          format={{ notation: "standard" }}
          value={totalUsd}
        />
      )}
    </div>
  );
}

// ─── Formatting helpers ───

function formatBalance(value: string): string {
  const num = parseFloat(value);
  if (num === 0) return "0";
  return num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function formatBalanceWithSymbol(value: string, symbol: string): string {
  const num = parseFloat(value);
  if (num === 0) return `0 ${symbol}`;
  return `${num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })} ${symbol}`;
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ─── Balance table (desktop) ───

type BalanceTableProps = {
  tokens: TokenEntry[];
  migration?: MigrationAction;
  onUnstakeV1?: () => void;
  onUnwrapWstSymbient?: () => void;
};

type Row = {
  key: string;
  token: TokenEntry;
  chain: ChainBalance;
  action: TokenAction;
  usdValue: number;
};

const columnHelper = createColumnHelper<Row>();

const columns = [
  columnHelper.accessor("token", {
    header: "Asset",
    cell: ({ getValue }) => {
      const token = getValue();
      return (
        <div className="flex items-center gap-2.5">
          <Icon name={token.icon} className="size-9" />
          <div>
            <div className="text-sm/5 font-medium">{token.label}</div>
            {token.sublabel && (
              <div className="text-xs/4 font-normal text-secondary-t">{token.sublabel}</div>
            )}
          </div>
        </div>
      );
    },
  }),
  columnHelper.accessor("chain", {
    header: "Chain",
    cell: ({ getValue }) => <ChainIcon chainId={getValue().chainId} size={24} />,
  }),
  columnHelper.accessor(
    (row) => ({ balance: row.chain.formattedBalance, usdValue: row.usdValue }),
    {
      id: "balance",
      header: "Balance",
      cell: ({ getValue }) => {
        const { balance, usdValue } = getValue();
        return (
          <>
            <div className="text-sm/5 font-semibold">{formatBalance(balance)}</div>
            <div className="text-xs/4 font-normal text-secondary-t">{formatUsd(usdValue)}</div>
          </>
        );
      },
    },
  ),
  columnHelper.accessor((row) => row.token.price, {
    id: "price",
    header: "Price",
    cell: ({ getValue }) => <div className="text-sm/5 font-semibold">{formatUsd(getValue())}</div>,
  }),
  columnHelper.accessor("action", {
    header: "",
    cell: ({ getValue }) => {
      const action = getValue();
      if (action.to) {
        return <Button render={<Link to={action.to} />}>{action.label}</Button>;
      }
      const button = (
        <Button disabled={action.disabled} onClick={action.onClick}>
          {action.label}
        </Button>
      );
      return action.tooltip ? (
        <Tooltip title={action.tooltip}>
          <span className="inline-flex">{button}</span>
        </Tooltip>
      ) : (
        button
      );
    },
  }),
];

function BalanceTable({ tokens, migration, onUnstakeV1, onUnwrapWstSymbient }: BalanceTableProps) {
  const data = useMemo<Row[]>(() => {
    const rows: Row[] = [];
    for (const token of tokens) {
      for (const chain of token.balances.balances) {
        if (chain.balance > 0n) {
          const usdValue = parseFloat(chain.formattedBalance) * token.price;
          if (token.price > 0 && usdValue < 0.01) continue;
          rows.push({
            key: `${token.symbol}-${chain.chainId}`,
            token,
            chain,
            action: getTokenAction(
              token.symbol,
              chain.chainName,
              migration,
              onUnstakeV1,
              onUnwrapWstSymbient,
            ),
            usdValue,
          });
        }
      }
    }
    return rows;
  }, [tokens, migration, onUnstakeV1, onUnwrapWstSymbient]);

  const table = useReactTable({
    data,
    columns,
    getRowId: (row) => row.key,
    getCoreRowModel: getCoreRowModel(),
  });

  if (data.length === 0) return null;

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <TableHead key={header.id}>
                {flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <TableCell
                key={cell.id}
                className={cell.column.id === "action" ? "text-right" : undefined}
              >
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ─── Balance cards (mobile) ───

type BalanceCardsProps = {
  tokens: TokenEntry[];
  migration?: MigrationAction;
  onUnstakeV1?: () => void;
  onUnwrapWstSymbient?: () => void;
};

function BalanceCards({ tokens, migration, onUnstakeV1, onUnwrapWstSymbient }: BalanceCardsProps) {
  const rows: {
    key: string;
    token: TokenEntry;
    chain: ChainBalance;
  }[] = [];

  for (const token of tokens) {
    for (const chain of token.balances.balances) {
      if (chain.balance > 0n) {
        const usdValue = parseFloat(chain.formattedBalance) * token.price;
        if (token.price > 0 && usdValue < 0.01) continue;
        rows.push({
          key: `${token.symbol}-${chain.chainId}`,
          token,
          chain,
        });
      }
    }
  }

  if (rows.length === 0) return null;

  return (
    <Card className="divide-y divide-surface-a5">
      <div className="px-4 py-2.5 text-xs text-tertiary-t">Asset</div>
      {rows.map((row) => {
        const action = getTokenAction(
          row.token.symbol,
          row.chain.chainName,
          migration,
          onUnstakeV1,
          onUnwrapWstSymbient,
        );
        const usdValue = parseFloat(row.chain.formattedBalance) * row.token.price;

        return (
          <div key={row.key} className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="relative">
                <Icon name={row.token.icon} size={32} />
                <div className="absolute -bottom-1 -right-1">
                  <ChainIcon chainId={row.chain.chainId} size={14} />
                </div>
              </div>
              <div>
                <div className="font-medium text-primary-t">
                  {formatBalanceWithSymbol(row.chain.formattedBalance, row.token.label)}
                </div>
                <div className="text-xs text-tertiary-t">{formatUsd(usdValue)}</div>
              </div>
            </div>
            {action.to ? (
              <Button size="sm" render={<Link to={action.to} />}>
                {action.label}
              </Button>
            ) : action.tooltip ? (
              <Tooltip title={action.tooltip}>
                <span className="inline-flex">
                  <Button size="sm" disabled={action.disabled} onClick={action.onClick}>
                    {action.label}
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Button size="sm" disabled={action.disabled} onClick={action.onClick}>
                {action.label}
              </Button>
            )}
          </div>
        );
      })}
    </Card>
  );
}

// ─── Empty & disconnected states ───

function BalanceEmptyState({ isLoading }: { isLoading: boolean }) {
  if (isLoading) return null;

  return (
    <Card className="flex flex-col items-center justify-center py-16 px-6 text-center min-h-[240px]">
      <Icon name="SHITTokenIcon" size={40} className="text-tertiary-t mb-4" />
      <h3 className="text-sm/5 font-semibold text-secondary-t mb-1">
        No SYM tokens found in your wallet.
      </h3>
      <p className="text-xs/4 font-normal text-secondary-t max-w-sm">
        SYM cannot be minted from the faucet. To get SYM, claim USDC from the faucet, then buy bonds with USDC to receive SYM at a discount.
      </p>
      {isTestnetMode && (
        <a
          href="#/faucet"
          className="mt-4 inline-flex items-center gap-2 font-semibold text-sm text-yellow border border-yellow/40 px-4 py-2 rounded-full hover:bg-yellow/10 transition-colors"
        >
          Get USDC from the faucet →
        </a>
      )}
    </Card>
  );
}

function BalanceDisconnectedState() {
  return (
    <Card className="flex flex-col items-center justify-center py-16 px-6 text-center min-h-[240px]">
      <Icon name="WalletIcon" size={40} className="text-tertiary-t mb-4" />
      <h3 className="text-sm/5 font-semibold text-secondary-t mb-4">
        Sign in to view your balances.
      </h3>
      <ConnectButton />
    </Card>
  );
}

// ─── Balances page ───

export function BalancesPage() {
  const { isConnected, address } = useConnectedAddress();
  const { isMobile } = useIsMobile();
  const mock = useMockData();

  const effectivelyConnected = mock ? mock.scenario.isConnected : (isConnected || !!address);

  const [isMigrateOpen, setIsMigrateOpen] = useState(false);
  const [isUnstakeV1Open, setIsUnstakeV1Open] = useState(false);
  const [isUnwrapWsshitOpen, setIsUnwrapWsshitOpen] = useState(false);
  const {
    migrator,
    merkleRoot,
    hasMerkleRoot,
    isOnChainMerkleRootActive,
    isLoading: merkleRootLoading,
    error: merkleRootError,
  } = useV1MigratorMerkleRoot();
  const {
    claim,
    isEligible,
    isLoading: claimLoading,
    error: claimError,
  } = useMigrationClaim(merkleRoot);
  const {
    isEnabled: migratorEnabled,
    isActive: migratorActive,
    isClaimValid,
    remaining,
    remainingMintApproval,
    isLoading: migrationInfoLoading,
    error: migrationInfoError,
  } = useV1MigrationInfo(claim, isOnChainMerkleRootActive);

  const migrationStatus: MigrationStatus | undefined = useMemo(() => {
    if (mock || !isConnected) return undefined;
    if (merkleRootLoading || claimLoading || migrationInfoLoading) return "loading";
    if (merkleRootError || claimError || migrationInfoError) return "error";
    if (!hasMerkleRoot) return "not-live";
    if (!isOnChainMerkleRootActive) return "not-live";
    if (!isEligible || isClaimValid === false) return "ineligible";
    if (!migrator || migratorEnabled !== true || migratorActive !== true) return "not-live";
    if (remaining !== undefined && remaining === 0n) return "fully-migrated";
    return "ready";
  }, [
    mock,
    isConnected,
    merkleRootLoading,
    claimLoading,
    migrationInfoLoading,
    merkleRootError,
    claimError,
    migrationInfoError,
    hasMerkleRoot,
    isOnChainMerkleRootActive,
    isEligible,
    isClaimValid,
    migrator,
    migratorEnabled,
    migratorActive,
    remaining,
  ]);

  const migration: MigrationAction | undefined = useMemo(
    () =>
      migrationStatus
        ? { status: migrationStatus, onMigrate: () => setIsMigrateOpen(true) }
        : undefined,
    [migrationStatus],
  );

  const WstSymbientToken = useToken(TokenName.Wstsym);
  const SymbientToken = useToken(TokenName.SYM);

  const shitPriceNum = SymbientToken.price;
  const wstsymPriceNum = WstSymbientToken.price;

  const tokenList = useMemo(
    () => [TOKENS.SYM, TOKENS.stsym, TOKENS.Wstsym],
    [],
  );
  const { balances: tokenBalances, isLoading: balancesLoading } = useAllTokenBalances(tokenList);

  const shitBalances = tokenBalances.SYM;
  const stsymBalances = tokenBalances.stSYM;
  const wstsymBalances = tokenBalances.wstSYM;

  const isLoading = balancesLoading;

  const totalUsd =
    parseFloat(shitBalances.formattedTotalBalance) * shitPriceNum +
    parseFloat(stsymBalances.formattedTotalBalance) * shitPriceNum +
    parseFloat(wstsymBalances.formattedTotalBalance) * wstsymPriceNum;

  const hasBalances =
    totalUsd >= 0.01 ||
    [shitBalances, stsymBalances, wstsymBalances].some(
      (b) => b.totalBalance > 0n,
    );

  const tokens = useMemo(
    () => [
      {
        symbol: "SYM",
        label: "SYM",
        icon: "SHITTokenIcon" as IconName,
        balances: shitBalances,
        price: shitPriceNum,
      },
      {
        symbol: "stSYM",
        label: "stSYM",
        sublabel: "Staked SYM",
        icon: "stsymTokenIcon" as IconName,
        balances: stsymBalances,
        price: shitPriceNum,
      },
      {
        symbol: "wstSYM",
        label: "wstSYM",
        sublabel: "Wrapped staked SYM",
        icon: "WstsymTokenIcon" as IconName,
        balances: wstsymBalances,
        price: wstsymPriceNum,
      },
    ],
    [
      shitBalances,
      stsymBalances,
      wstsymBalances,
      shitPriceNum,
      wstsymPriceNum,
    ],
  );

  return (
    <div className="mx-auto max-w-7xl ">
      <BalanceInfoCards isMobile={isMobile} />

      <div className="mt-8">
        {!effectivelyConnected ? (
          <BalanceDisconnectedState />
        ) : (
          <>
            <BalanceWalletValue totalUsd={totalUsd} isLoading={isLoading} />
            {hasBalances ? (
              isMobile ? (
                <BalanceCards
                  tokens={tokens}
                  migration={migration}
                  onUnstakeV1={mock ? undefined : () => setIsUnstakeV1Open(true)}
                  onUnwrapWstSymbient={mock ? undefined : () => setIsUnwrapWsshitOpen(true)}
                />
              ) : (
                <BalanceTable
                  tokens={tokens}
                  migration={migration}
                  onUnstakeV1={mock ? undefined : () => setIsUnstakeV1Open(true)}
                  onUnwrapWstSymbient={mock ? undefined : () => setIsUnwrapWsshitOpen(true)}
                />
              )
            ) : (
              <BalanceEmptyState isLoading={isLoading} />
            )}
          </>
        )}
      </div>

      {claim && remaining !== undefined && (
        <MigrateSymbientModal
          isOpen={isMigrateOpen}
          onClose={() => setIsMigrateOpen(false)}
          claim={claim}
          remaining={remaining}
          remainingMintApproval={remainingMintApproval}
        />
      )}

      <UnstakeStSymbientModal isOpen={isUnstakeV1Open} onClose={() => setIsUnstakeV1Open(false)} />

      <UnwrapWstSymbientModal isOpen={isUnwrapWsshitOpen} onClose={() => setIsUnwrapWsshitOpen(false)} />
    </div>
  );
}
