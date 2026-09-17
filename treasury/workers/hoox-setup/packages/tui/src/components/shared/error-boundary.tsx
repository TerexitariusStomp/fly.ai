/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/** @jsxImportSource @opentui/react */
/**
 * React-style error boundary for the TUI.
 * Catches render errors in child views and displays a styled recovery panel
 * with the view name, error message, and a [Retry] button.
 *
 * Colors use Hoox design tokens — no hardcoded hex.
 */
import { Component, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { Colors } from "@hoox-sh/hoox-shared";
import { redactSecretsInText } from "../../services/dev-log";

// ── Types ──────────────────────────────────────────────────────────────────

interface ErrorBoundaryProps {
  /** Name of the view being wrapped (shown in error UI) */
  viewName: string;
  /** Child content to protect */
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** First line of error message, secrets scrubbed, length-capped for chrome. */
export function formatBoundaryErrorMessage(error: Error, maxLen = 160): string {
  const first = (error.message || "Unknown error").split("\n")[0] ?? "";
  const scrubbed = redactSecretsInText(first).trim() || "Unknown error";
  return scrubbed.length > maxLen
    ? `${scrubbed.slice(0, maxLen - 1)}…`
    : scrubbed;
}

/** Keyboard + mouse retry chrome (hooks require a function component). */
function ErrorRecoveryPanel({
  viewName,
  message,
  onRetry,
}: {
  viewName: string;
  message: string;
  onRetry: () => void;
}) {
  useKeyboard((key) => {
    const name = String(key.name ?? "").toLowerCase();
    if (name === "return" || name === "enter" || name === "r") {
      onRetry();
    }
  });

  return (
    <box
      flexDirection="column"
      padding={2}
      gap={1}
      border={true}
      borderStyle="single"
      borderColor={Colors.border}
      backgroundColor={Colors.card}
    >
      <box flexDirection="row" gap={1}>
        <text fg={Colors.error} bold>
          ⚠
        </text>
        <text fg={Colors.error} bold>
          Failed to load {viewName}
        </text>
      </box>

      <text fg={Colors.muted}>{message}</text>

      <box paddingTop={1} flexDirection="row" gap={2}>
        <text fg={Colors.accent} bg={Colors.card} onMouseUp={onRetry}>
          {"  [Retry]  "}
        </text>
        <text fg={Colors.dim} dim>
          Enter / R
        </text>
      </box>
    </box>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  /** Reset error state to retry rendering children */
  private handleRetry = () => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      const message = formatBoundaryErrorMessage(this.state.error);
      return (
        <ErrorRecoveryPanel
          viewName={this.props.viewName}
          message={message}
          onRetry={this.handleRetry}
        />
      );
    }

    return this.props.children;
  }
}
