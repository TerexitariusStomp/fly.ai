import { useEffect, useRef, useState } from "react";
import { driver, type DriveStep } from "driver.js";
import { useFeatureTour } from "@/hooks/use-feature-tour";
import { useIsMobile } from "@/hooks/use-mobile";
import { FeatureTourWelcomeModal } from "@/components/feature-tour-welcome-modal";
import {
  trackOnboardingModalShown,
  trackOnboardingModalSkipped,
  trackOnboardingTourStarted,
  trackOnboardingStepViewed,
  trackOnboardingStepAdvanced,
  trackOnboardingTourSkipped,
  trackOnboardingTourCompleted,
  trackOnboardingSuppressedMobile,
} from "@/lib/analytics";

const DESKTOP_BREAKPOINT = 1023.5;
const TIGHT_POPOVER_CLASS = "symbient-tour-popover symbient-tour-popover-tight";

type SYMStep = DriveStep & { name: string };

function buildSteps(): SYMStep[] {
  return [
    {
      name: "sidebar_overview",
      element: '[data-tour="sidebar-nav"]',
      popover: {
        title: "Everything starts here",
        description: `
          <ul>
            <li><strong>Overview.</strong> Live treasury NAV, floor price, and connectome brain activity.</li>
            <li><strong>Traders.</strong> The 7 connectomes — performance, signals, and betting markets.</li>
            <li><strong>Treasury.</strong> Reserves, RFV, positions, and every on-chain action.</li>
            <li><strong>Stake & Wrap.</strong> Stake FLYAI to stFLYAI, wrap to wstFLYAI, and back.</li>
          </ul>
        `,
        side: "right",
        align: "center",
      },
    },
    {
      name: "traders",
      element: '[data-tour="nav-traders"]',
      popover: {
        title: "The connectomes",
        description: `
          <p style="margin-bottom:20px">Seven real biological neural networks govern the treasury and trade it autonomously.</p>
          <ul>
            <li><strong>Leaderboard.</strong> Each connectome's track record and conviction scores</li>
            <li><strong>Signals.</strong> Live trade signals and predictions</li>
            <li><strong>Governance.</strong> Protocol actions need at least 3 of 7 connectomes to pass</li>
          </ul>
        `,
        side: "right",
        align: "center",
        popoverClass: TIGHT_POPOVER_CLASS,
      },
    },
    {
      name: "treasury",
      element: '[data-tour="nav-treasury"]',
      popover: {
        title: "The shared treasury",
        description:
          "Every FLYAI is partially backed by real reserves. NAV, RFV, floor price, positions, and every on-chain action — all verifiable.",
        side: "right",
        align: "center",
        popoverClass: TIGHT_POPOVER_CLASS,
      },
    },
  ];
}

// Must match border-width in .driver-popover-arrow (feature-tour.css).
const ARROW_HALF = 8;
const ARROW_HEIGHT = ARROW_HALF * 2;
// Keeps the arrow clear of the popover's rounded corners.
const ARROW_EDGE_PADDING = 16;

function alignArrow(popoverWrapper: HTMLElement, element: Element | undefined) {
  if (!element) return;
  const arrow = popoverWrapper.querySelector<HTMLElement>(".driver-popover-arrow");
  if (!arrow) return;

  const isSideArrow =
    arrow.classList.contains("driver-popover-arrow-side-left") ||
    arrow.classList.contains("driver-popover-arrow-side-right");
  if (!isSideArrow) return;

  const elRect = element.getBoundingClientRect();
  const popRect = popoverWrapper.getBoundingClientRect();
  const elCenterY = elRect.top + elRect.height / 2;

  const rawTop = elCenterY - popRect.top - ARROW_HALF;
  const maxTop = popRect.height - ARROW_EDGE_PADDING - ARROW_HEIGHT;
  const clampedTop = Math.max(ARROW_EDGE_PADDING, Math.min(rawTop, maxTop));

  arrow.style.top = `${clampedTop}px`;
  arrow.style.bottom = "auto";
  arrow.style.marginTop = "0";
}

function injectFooter(
  popover: { wrapper: HTMLElement },
  stepIndex: number,
  totalSteps: number,
  onSkip: () => void,
  onNext: () => void,
  isLast: boolean,
) {
  // Guard: prevent re-entrant calls (driver.js MutationObserver loop)
  if (popover.wrapper.querySelector(".symbient-tour-footer")) return;

  const footer = document.createElement("div");
  footer.className = "symbient-tour-footer";

  const dots = document.createElement("div");
  dots.className = "symbient-tour-dots";
  dots.innerHTML = Array.from({ length: totalSteps })
    .map((_, i) => `<span class="symbient-tour-dot${i === stepIndex ? " active" : ""}"></span>`)
    .join("");

  const buttons = document.createElement("div");
  buttons.className = "symbient-tour-buttons";

  const skipBtn = document.createElement("button");
  skipBtn.className = "symbient-tour-btn symbient-tour-btn-skip";
  skipBtn.textContent = "Skip";
  skipBtn.addEventListener("click", onSkip);

  const nextBtn = document.createElement("button");
  nextBtn.className = "symbient-tour-btn symbient-tour-btn-next";
  nextBtn.textContent = isLast ? "Got It" : "Next";
  nextBtn.addEventListener("click", onNext);

  buttons.appendChild(skipBtn);
  buttons.appendChild(nextBtn);
  footer.appendChild(dots);
  footer.appendChild(buttons);
  popover.wrapper.appendChild(footer);
}

export function FeatureTour() {
  const { shouldShowModal, startTour, skipTour, completeTour, saveStep } = useFeatureTour();
  const { isMobile, isTablet } = useIsMobile();
  // Lazy init: check window width synchronously to avoid flicker on first render
  const [modalOpen, setModalOpen] = useState(
    () => shouldShowModal && window.innerWidth > DESKTOP_BREAKPOINT,
  );
  const driverRef = useRef<ReturnType<typeof driver> | null>(null);
  const tourStartTimeRef = useRef<number | null>(null);
  const trackedStepsRef = useRef<Set<number>>(new Set());
  const onboardingFiredRef = useRef(false);

  const completeTourRef = useRef(completeTour);
  const saveStepRef = useRef(saveStep);
  completeTourRef.current = completeTour;
  saveStepRef.current = saveStep;

  // Fire modal_shown / suppressed_mobile exactly once on first eligible mount.
  useEffect(() => {
    if (!shouldShowModal || onboardingFiredRef.current) return;
    onboardingFiredRef.current = true;
    if (window.innerWidth > DESKTOP_BREAKPOINT) {
      trackOnboardingModalShown(window.innerWidth);
    } else {
      trackOnboardingSuppressedMobile(window.innerWidth);
    }
  }, [shouldShowModal]);

  useEffect(() => {
    const steps = buildSteps();

    const driverInstance = driver({
      animate: true,
      overlayOpacity: 0.5,
      popoverClass: "symbient-tour-popover",
      showButtons: [],
      allowClose: false,
      stagePadding: 0,
      stageRadius: 100,
      popoverOffset: 16,
      steps,
      onPopoverRender: (popover, opts) => {
        const index = opts.state.activeIndex ?? 0;
        const isLast = index === steps.length - 1;

        if (!trackedStepsRef.current.has(index)) {
          trackedStepsRef.current.add(index);
          trackOnboardingStepViewed(index, steps[index].name, steps.length);
        }

        injectFooter(
          popover,
          index,
          steps.length,
          () => {
            trackOnboardingTourSkipped(index, steps[index].name);
            saveStepRef.current(index);
            driverInstance.destroy();
          },
          () => {
            if (isLast) {
              const startedAt = tourStartTimeRef.current ?? Date.now();
              trackOnboardingTourCompleted(Date.now() - startedAt, steps.length);
              completeTourRef.current();
              driverInstance.destroy();
            } else {
              trackOnboardingStepAdvanced(index);
              driverInstance.moveNext();
            }
          },
          isLast,
        );

        // Defer to a microtask so driver.js has finished its own positioning
        // pass before we read the popover's geometry.
        queueMicrotask(() => alignArrow(popover.wrapper, opts.state.activeElement));
      },
    });

    let rafId: number | null = null;
    const handleReposition = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!driverInstance.isActive()) return;
        const el = driverInstance.getActiveElement();
        const wrapper = document.querySelector<HTMLElement>(".symbient-tour-popover.driver-popover");
        if (el && wrapper) alignArrow(wrapper, el);
      });
    };
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);

    driverRef.current = driverInstance;

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
      driverInstance.destroy();
      driverRef.current = null;
    };
  }, []);

  const isDesktop = !isMobile && !isTablet;

  return (
    <FeatureTourWelcomeModal
      open={modalOpen && isDesktop}
      onSkip={(method) => {
        trackOnboardingModalSkipped(method);
        setModalOpen(false);
        skipTour();
      }}
      onStart={() => {
        if (!isDesktop) return;
        setModalOpen(false);
        trackOnboardingTourStarted();
        startTour();
        setTimeout(() => {
          tourStartTimeRef.current = Date.now();
          driverRef.current?.drive();
        }, 150);
      }}
    />
  );
}
