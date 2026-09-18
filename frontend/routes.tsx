import { lazy, Suspense } from "react";
import { createHashRouter, Navigate } from "react-router";
import AppLayout from "@/layouts/app-layout";
import { RouteErrorElement } from "@/components/route-error-element";
import { RouteLoadingFallback } from "@/components/route-loading-fallback";

function retryLazy<T>(
  factory: () => Promise<T>,
  retries = 2,
): Promise<T> {
  return factory().catch((err) => {
    const msg = err?.message ?? "";
    if (msg.includes("Failed to fetch dynamically imported module") || msg.includes("Importing a module script failed")) {
      window.location.reload();
      return new Promise(() => {});
    }
    if (retries <= 0) throw err;
    return new Promise((resolve) => {
      setTimeout(() => resolve(retryLazy(factory, retries - 1)), 300);
    });
  });
}

const FlyaiOverviewPage = lazy(() =>
  retryLazy(() => import("@/modules/flyai-overview-page")).then((m) => ({ default: m.FlyaiOverviewPage })),
);
const FlyaiTradersPage = lazy(() =>
  retryLazy(() => import("@/modules/flyai-traders-page")).then((m) => ({ default: m.FlyaiTradersPage })),
);
const FlyaiTreasuryPage = lazy(() =>
  retryLazy(() => import("@/modules/flyai-treasury-page")).then((m) => ({ default: m.FlyaiTreasuryPage })),
);
const WrapPage = lazy(() =>
  retryLazy(() => import("@/modules/flyai-wrap-page")).then((m) => ({
    default: m.WrapPage,
  })),
);

const withSuspense = (element: React.ReactNode) => (
  <Suspense fallback={<RouteLoadingFallback />}>{element}</Suspense>
);

export const router = createHashRouter([
  {
    path: "/",
    Component: AppLayout,
    errorElement: <RouteErrorElement />,
    children: [
      { index: true, element: withSuspense(<FlyaiOverviewPage />) },
      { path: "traders", element: withSuspense(<FlyaiTradersPage />) },
      { path: "treasury", element: withSuspense(<FlyaiTreasuryPage />) },
      { path: "stake-wrap", element: withSuspense(<WrapPage />) },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
