/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  copyToClipboard,
  copyViaSystemClipboard,
  enableAutoCopyOnSelection,
  type ClipboardRenderer,
} from "./clipboard";
import { messageCopiedToClipboard } from "../components/ui/toast";
import { setRendererRef } from "../hooks";

describe("clipboard", () => {
  const originalWhich = Bun.which;
  const originalSpawn = Bun.spawn;

  afterEach(() => {
    (Bun as { which: typeof Bun.which }).which = originalWhich;
    (Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    setRendererRef(null);
  });

  it("treats empty text as success without throwing", async () => {
    const result = await copyToClipboard("   ", null);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.method).toBe("osc52");
  });

  it("treats empty string as success", async () => {
    const result = await copyToClipboard("", null);
    expect(result.ok).toBe(true);
  });

  it("copyViaSystemClipboard returns a tool name or null", async () => {
    const tool = await copyViaSystemClipboard("hoox-clipboard-test");
    // CI may lack clipboard tools; null is acceptable
    expect(tool === null || typeof tool === "string").toBe(true);
  });

  it("copyViaSystemClipboard returns null when no tools exist", async () => {
    (Bun as { which: typeof Bun.which }).which = (() =>
      null) as typeof Bun.which;
    const tool = await copyViaSystemClipboard("x");
    expect(tool).toBeNull();
  });

  it("copyViaSystemClipboard returns tool name on successful spawn", async () => {
    (Bun as { which: typeof Bun.which }).which = ((bin: string) =>
      bin === "wl-copy" ? "/usr/bin/wl-copy" : null) as typeof Bun.which;

    (Bun as { spawn: typeof Bun.spawn }).spawn = (() => {
      const writes: string[] = [];
      return {
        stdin: {
          write: (t: string | Uint8Array) => {
            writes.push(
              typeof t === "string" ? t : new TextDecoder().decode(t)
            );
          },
          end: () => {},
        },
        stdout: null,
        stderr: null,
        killed: false,
        kill: () => {},
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;

    const tool = await copyViaSystemClipboard("secret-text");
    expect(tool).toBe("wl-copy");
  });

  it("copyViaSystemClipboard skips tools that exit non-zero", async () => {
    let whichCalls = 0;
    (Bun as { which: typeof Bun.which }).which = ((bin: string) => {
      whichCalls++;
      if (bin === "wl-copy") return "/usr/bin/wl-copy";
      if (bin === "xclip") return "/usr/bin/xclip";
      return null;
    }) as typeof Bun.which;

    let spawnN = 0;
    (Bun as { spawn: typeof Bun.spawn }).spawn = ((cmd: string[]) => {
      spawnN++;
      const bin = cmd[0];
      return {
        stdin: { write: () => {}, end: () => {} },
        killed: false,
        kill: () => {},
        exited: Promise.resolve(bin === "wl-copy" ? 1 : 0),
      };
    }) as unknown as typeof Bun.spawn;

    const tool = await copyViaSystemClipboard("payload");
    expect(tool).toBe("xclip");
    expect(spawnN).toBe(2);
    expect(whichCalls).toBeGreaterThan(0);
  });

  it("copyViaSystemClipboard continues after spawn throw", async () => {
    (Bun as { which: typeof Bun.which }).which = ((bin: string) =>
      bin === "wl-copy" || bin === "pbcopy"
        ? `/bin/${bin}`
        : null) as typeof Bun.which;

    (Bun as { spawn: typeof Bun.spawn }).spawn = ((cmd: string[]) => {
      if (cmd[0] === "wl-copy") throw new Error("spawn failed");
      return {
        stdin: { write: () => {}, end: () => {} },
        killed: false,
        kill: () => {},
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;

    const tool = await copyViaSystemClipboard("x");
    expect(tool).toBe("pbcopy");
  });

  it("copyToClipboard uses OSC52 when renderer succeeds", async () => {
    (Bun as { which: typeof Bun.which }).which = (() =>
      null) as typeof Bun.which;
    const renderer: ClipboardRenderer = {
      copyToClipboardOSC52: () => true,
      on: () => renderer,
      off: () => renderer,
    };
    const result = await copyToClipboard("hello", renderer);
    expect(result).toEqual({ ok: true, method: "osc52" });
  });

  it("copyToClipboard falls through when OSC52 returns false", async () => {
    (Bun as { which: typeof Bun.which }).which = ((bin: string) =>
      bin === "xsel" ? "/usr/bin/xsel" : null) as typeof Bun.which;
    (Bun as { spawn: typeof Bun.spawn }).spawn = (() => ({
      stdin: { write: () => {}, end: () => {} },
      killed: false,
      kill: () => {},
      exited: Promise.resolve(0),
    })) as unknown as typeof Bun.spawn;

    const renderer: ClipboardRenderer = {
      copyToClipboardOSC52: () => false,
      on: () => renderer,
      off: () => renderer,
    };
    const result = await copyToClipboard("hello", renderer);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.method).toBe("system");
      expect(result.tool).toBe("xsel");
    }
  });

  it("copyToClipboard falls through when OSC52 throws", async () => {
    (Bun as { which: typeof Bun.which }).which = (() =>
      null) as typeof Bun.which;
    const renderer: ClipboardRenderer = {
      copyToClipboardOSC52: () => {
        throw new Error("no osc");
      },
      on: () => renderer,
      off: () => renderer,
    };
    const result = await copyToClipboard("hello", renderer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/clipboard/i);
  });

  it("copyToClipboard falls back when no renderer is available", async () => {
    const result = await copyToClipboard("hello from hoox tui", null);
    if (result.ok) {
      expect(result.method === "osc52" || result.method === "system").toBe(
        true
      );
    } else {
      expect(result.error).toMatch(/clipboard/i);
    }
  });

  it("accepts notify option without throwing", async () => {
    // Toast singleton may no-op without a Toaster in unit tests
    const result = await copyToClipboard("notify me", null, { notify: true });
    expect(typeof result.ok).toBe("boolean");
  });

  it("uses getRendererRef when renderer arg omitted", async () => {
    const renderer: ClipboardRenderer = {
      copyToClipboardOSC52: () => true,
      on: () => renderer,
      off: () => renderer,
    };
    setRendererRef(renderer as unknown as import("@opentui/core").CliRenderer);
    (Bun as { which: typeof Bun.which }).which = (() =>
      null) as typeof Bun.which;
    const result = await copyToClipboard("via-ref");
    expect(result).toEqual({ ok: true, method: "osc52" });
  });
});

describe("enableAutoCopyOnSelection", () => {
  it("registers selection listener and ignores drag/empty/debounced", async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const osc = mock(() => true);
    const renderer: ClipboardRenderer = {
      copyToClipboardOSC52: osc,
      on: (event, listener) => {
        handlers.set(event, listener as (...args: unknown[]) => void);
        return renderer;
      },
      off: (event) => {
        handlers.delete(event);
        return renderer;
      },
    };

    const unsub = enableAutoCopyOnSelection(renderer);
    expect(handlers.has("selection")).toBe(true);
    const onSelection = handlers.get("selection")!;

    // dragging → ignore
    onSelection({ isDragging: true, getSelectedText: () => "nope" });
    expect(osc).not.toHaveBeenCalled();

    // empty → ignore
    onSelection({ isDragging: false, getSelectedText: () => "  " });
    expect(osc).not.toHaveBeenCalled();

    // valid selection
    onSelection({ isDragging: false, getSelectedText: () => "selected" });
    await Promise.resolve();
    expect(osc).toHaveBeenCalled();

    // debounce identical text within 400ms
    const callsBefore = osc.mock.calls.length;
    onSelection({ isDragging: false, getSelectedText: () => "selected" });
    await Promise.resolve();
    expect(osc.mock.calls.length).toBe(callsBefore);

    // missing selection object is safe
    onSelection(undefined);
    unsub();
    expect(handlers.has("selection")).toBe(false);
  });
});

describe("messageCopiedToClipboard", () => {
  it("previews short text", () => {
    expect(messageCopiedToClipboard("hello")).toBe("Copied: “hello”");
  });

  it("truncates long text", () => {
    const long = "x".repeat(80);
    const msg = messageCopiedToClipboard(long);
    expect(msg.startsWith("Copied: “")).toBe(true);
    expect(msg.endsWith("…”")).toBe(true);
    expect(msg.length).toBeLessThan(long.length + 20);
  });

  it("collapses whitespace", () => {
    expect(messageCopiedToClipboard("a\n\nb")).toBe("Copied: “a b”");
  });

  it("handles empty after trim", () => {
    expect(messageCopiedToClipboard("   ")).toBe("Copied to clipboard");
  });
});
