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

const SymOverviewPage = lazy(() =>
  retryLazy(() => import("@/modules/sym-overview-page")).then((m) => ({ default: m.SymOverviewPage })),
);
const SymTradersPage = lazy(() =>
  retryLazy(() => import("@/modules/sym-traders-page")).then((m) => ({ default: m.SymTradersPage })),
);
const SymTreasuryPage = lazy(() =>
  retryLazy(() => import("@/modules/sym-treasury-page")).then((m) => ({ default: m.SymTreasuryPage })),
);
const WrapPage = lazy(() =>
  retryLazy(() => import("@/modules/symbient-wrap-page")).then((m) => ({
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
      { index: true, element: withSuspense(<SymOverviewPage />) },
      { path: "traders", element: withSuspense(<SymTradersPage />) },
      { path: "treasury", element: withSuspense(<SymTreasuryPage />) },
      { path: "stake-wrap", element: withSuspense(<WrapPage />) },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
