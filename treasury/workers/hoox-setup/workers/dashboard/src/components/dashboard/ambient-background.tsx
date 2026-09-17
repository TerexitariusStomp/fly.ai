"use client";

/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface AmbientBackgroundProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Shared ambient background used across the authenticated dashboard shell.
 * Matches the login page treatment: soft accent glows + fine noise dot overlay
 * (hoox.sh data-texture=dot via `.texture-overlay`).
 */
export function AmbientBackground({
  children,
  className,
}: AmbientBackgroundProps) {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return (
    <div
      className={cn(
        "bg-background text-foreground relative min-h-svh",
        className
      )}
    >
      {/* Ambient glows — same soft accent wash as the login / landing page */}
      {!reduceMotion && (
        <>
          <div
            aria-hidden="true"
            className="pointer-events-none fixed top-1/2 left-1/2 h-[min(600px,90vw)] w-[min(600px,90vw)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/10 blur-[120px]"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none fixed top-0 right-0 h-[400px] w-[400px] rounded-full bg-accent/5 blur-[100px]"
          />
        </>
      )}

      {/* Fine noise dot overlay — matches hoox.sh data-texture=dot */}
      <div className="texture-overlay" aria-hidden="true" />

      <div className="relative z-10 flex min-h-svh flex-col">{children}</div>
    </div>
  );
}
