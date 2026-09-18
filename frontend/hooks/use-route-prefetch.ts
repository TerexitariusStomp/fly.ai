import { useEffect } from "react";

const PREFETCHED = new Set<string>();

const PREFETCH_ROUTES = [
  () => import("@/modules/flyai-overview-page"),
  () => import("@/modules/flyai-traders-page"),
  () => import("@/modules/flyai-treasury-page"),
  () => import("@/modules/flyai-wrap-page"),
];

export function useRoutePrefetch() {
  useEffect(() => {
    const prefetch = () => {
      for (const loader of PREFETCH_ROUTES) {
        const key = loader.toString();
        if (PREFETCHED.has(key)) continue;
        PREFETCHED.add(key);
        loader().catch(() => {
          PREFETCHED.delete(key);
        });
      }
    };

    if ("requestIdleCallback" in window) {
      const id = (window as Window).requestIdleCallback(prefetch, { timeout: 3000 });
      return () => (window as Window).cancelIdleCallback(id);
    }
    const id = setTimeout(prefetch, 2000);
    return () => clearTimeout(id);
  }, []);
}
