import { useQuery } from "@tanstack/react-query";
import { treasurySubgraphClient } from "@/lib/treasury-subgraph-client";
import { parseEnvioNumber } from "@/lib/utils-envio";

export interface FlyaiPriceHistory {
  dataPoints: Array<{ date: string; price: number }>;
}

export function useFlyaiPriceHistory(days = 30) {
  return useQuery<FlyaiPriceHistory>({
    queryKey: ["flyaiPriceHistory", "treasury-subgraph", days],
    queryFn: async () => {
      const start = new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];
      const rows = await treasurySubgraphClient.getDailyMetrics({ start, autoPaginate: true });

      const dataPoints = rows
        .map((r) => ({
          date: r.date,
          price: parseEnvioNumber(r.ohmPrice),
        }))
        .filter((p) => p.price > 0);

      return { dataPoints };
    },
    staleTime: 300_000,
    refetchInterval: 600_000,
  });
}
