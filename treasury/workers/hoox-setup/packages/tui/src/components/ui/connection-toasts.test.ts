/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from "bun:test";
import {
  messageAuthMissing,
  messageAuthRequired,
  messageConnected,
  messageConnectionLost,
  messageOfflineStartup,
  messageReconnected,
  toastReconnected,
  toastReconnectedMode,
  toastRateLimited,
  toastConfigSaved,
  toastDeployStarted,
  toastDeployCompleted,
  toastDeployFailed,
  toastConnectionLost,
  toastConnectionLostMode,
  toastConnectedMode,
  toastAuthRequiredMode,
  toastAuthMissingRemote,
  toastOfflineStartup,
} from "./connection-toasts";

describe("connection-toasts messages", () => {
  it("connected includes mode and host", () => {
    expect(messageConnected("local", "localhost:8787")).toBe(
      "Connected · LOCAL · localhost:8787"
    );
    expect(messageConnected("remote", "hoox.example.workers.dev")).toBe(
      "Connected · REMOTE · hoox.example.workers.dev"
    );
  });

  it("lost includes mode and host", () => {
    expect(messageConnectionLost("remote", "gw.test")).toContain("REMOTE");
    expect(messageConnectionLost("local", "localhost:8787")).toContain("LOCAL");
  });

  it("reconnected includes downtime", () => {
    const msg = messageReconnected("remote", "gw.test", 1_000, 61_000);
    expect(msg).toContain("Reconnected");
    expect(msg).toContain("REMOTE");
    expect(msg).toContain("gw.test");
    expect(msg).toContain("downtime");
  });

  it("reconnected clamps negative downtime to zero", () => {
    const msg = messageReconnected("local", "h", 10_000, 1_000);
    expect(msg).toContain("downtime");
  });

  it("auth messages are explicit", () => {
    expect(messageAuthRequired("remote", "gw")).toContain("Auth failed");
    expect(messageAuthRequired("local", "localhost")).toContain("LOCAL");
    expect(messageAuthMissing("gw")).toContain("No API credentials");
  });

  it("offline startup distinguishes kinds", () => {
    expect(messageOfflineStartup("remote", "gw", "auth")).toContain("(auth)");
    expect(
      messageOfflineStartup("local", "localhost:8787", "network")
    ).not.toContain("(auth)");
    expect(messageOfflineStartup("remote", "gw", "rate-limit")).toContain(
      "(rate limited)"
    );
    expect(messageOfflineStartup("local", "h", "unknown")).toBe(
      "Could not connect · LOCAL · h"
    );
  });
});

describe("connection-toasts factory functions", () => {
  // Toast singleton may no-op without a mounted Toaster; factories must not throw.
  it("toast factories are callable without a mounted toaster", () => {
    expect(() => toastReconnected(Date.now() - 5_000)).not.toThrow();
    expect(() =>
      toastReconnectedMode("remote", "gw.test", Date.now() - 2_000)
    ).not.toThrow();
    expect(() => toastRateLimited()).not.toThrow();
    expect(() => toastConfigSaved()).not.toThrow();
    expect(() => toastDeployStarted("trade-worker")).not.toThrow();
    expect(() => toastDeployCompleted("trade-worker")).not.toThrow();
    expect(() => toastDeployFailed("trade-worker", "timeout")).not.toThrow();
    expect(() => toastConnectionLost()).not.toThrow();
    expect(() =>
      toastConnectionLostMode("local", "localhost:8787")
    ).not.toThrow();
    expect(() => toastConnectionLostMode("remote", "gw")).not.toThrow();
    expect(() => toastConnectedMode("local", "localhost:8787")).not.toThrow();
    expect(() => toastAuthRequiredMode("remote", "gw")).not.toThrow();
    expect(() => toastAuthRequiredMode("local", "localhost")).not.toThrow();
    expect(() => toastAuthMissingRemote("gw")).not.toThrow();
    expect(() => toastOfflineStartup("remote", "gw", "auth")).not.toThrow();
    expect(() => toastOfflineStartup("remote", "gw", "network")).not.toThrow();
    expect(() =>
      toastOfflineStartup("local", "localhost", "rate-limit")
    ).not.toThrow();
    expect(() =>
      toastOfflineStartup("local", "localhost", "unknown")
    ).not.toThrow();
  });
});
