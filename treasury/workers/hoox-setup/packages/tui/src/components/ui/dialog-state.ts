/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Module-level open count for DialogProvider (avoids React store cycles). */
let openDialogCount = 0;

export function setOpenDialogCount(n: number): void {
  openDialogCount = Math.max(0, n);
}

export function isHooxDialogOpen(): boolean {
  return openDialogCount > 0;
}
