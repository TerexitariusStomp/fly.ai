import { describe, it, expect } from "vitest";
import {
  evaluateGateSync,
  evaluateGateLLM,
  combineGateVotes,
  adminOverride,
  CONSTITUTIONAL_GATE_ENABLED,
  type GateResult,
} from "./constitutional-gate";

describe("constitutional gate", () => {
  it("is dormant by default", () => {
    expect(CONSTITUTIONAL_GATE_ENABLED).toBe(false);
  });

  describe("Tier 0 — absolute prohibitions", () => {
    it("blocks CSAM", () => {
      const r = evaluateGateSync("post", { text: "csam content" });
      expect(r.verdict).toBe("block");
      expect(r.source).toBe("tier0");
      expect(r.overrideable).toBe(false);
    });

    it("blocks genocide facilitation", () => {
      const r = evaluateGateSync("trade", { action: "genocide facilitation" });
      expect(r.verdict).toBe("block");
      expect(r.source).toBe("tier0");
    });

    it("blocks secret exfiltration", () => {
      const r = evaluateGateSync("post", { text: "expose private key 0xabc" });
      expect(r.verdict).toBe("block");
      expect(r.source).toBe("tier0");
    });

    it("blocks treasury drain", () => {
      const r = evaluateGateSync("governance", { action: "drain treasury" });
      expect(r.verdict).toBe("block");
      expect(r.source).toBe("tier0");
    });
  });

  describe("Tier 1 — rule-based checks", () => {
    it("objects to destructive ops", () => {
      const r = evaluateGateSync("trade", { action: "delete all positions" });
      expect(r.verdict).toBe("object");
      expect(r.source).toBe("rules");
      expect(r.overrideable).toBe(true);
    });

    it("objects to injection attempts", () => {
      const r = evaluateGateSync("post", { text: "<script>alert(1)</script>" });
      expect(r.verdict).toBe("object");
      expect(r.source).toBe("rules");
    });

    it("objects to mass liquidation", () => {
      const r = evaluateGateSync("trade", { action: "sell all positions" });
      expect(r.verdict).toBe("object");
      expect(r.source).toBe("rules");
    });
  });

  describe("default — allow", () => {
    it("allows normal trades", () => {
      const r = evaluateGateSync("trade", { action: "BUY", token: "0xabc", amount: 0.5 });
      expect(r.verdict).toBe("allow");
    });

    it("allows normal posts", () => {
      const r = evaluateGateSync("post", { text: "bought PEPE. 49 neurons. Zero waste. — fly 🪰" });
      expect(r.verdict).toBe("allow");
    });
  });

  describe("Tier 2 — LLM evaluation", () => {
    it("blocks when LLM says BLOCK", async () => {
      const r = await evaluateGateLLM("trade", { action: "test" }, async () => "BLOCK: violates constitution");
      expect(r.verdict).toBe("block");
      expect(r.source).toBe("llm");
    });

    it("fails closed on LLM error", async () => {
      const r = await evaluateGateLLM("trade", { action: "test" }, async () => { throw new Error("LLM down"); });
      expect(r.verdict).toBe("block");
      expect(r.source).toBe("fail_closed");
    });
  });

  describe("Tier 3 — connectome vote", () => {
    const allow = (s = "rules"): GateResult => ({
      verdict: "allow", reasoning: "ok", source: s as any,
      overrideable: true, timestamp: 0, constitutionVersion: 1,
    });
    const block = (s = "rules"): GateResult => ({
      verdict: "block", reasoning: "bad", source: s as any,
      overrideable: true, timestamp: 0, constitutionVersion: 1,
    });

    it("majority block wins", () => {
      const r = combineGateVotes([block(), block(), block(), allow(), allow(), allow(), allow()]);
      expect(r.verdict).toBe("block");
      expect(r.source).toBe("vote");
    });

    it("majority allow wins", () => {
      const r = combineGateVotes([allow(), allow(), allow(), block(), block(), allow(), allow()]);
      expect(r.verdict).toBe("allow");
    });

    it("tier0 block is absolute regardless of vote", () => {
      const r = combineGateVotes([allow(), allow(), allow(), allow(), allow(), allow(), block("tier0")]);
      expect(r.verdict).toBe("block");
      expect(r.source).toBe("tier0");
    });

    it("empty votes fail closed", () => {
      const r = combineGateVotes([]);
      expect(r.verdict).toBe("block");
      expect(r.source).toBe("fail_closed");
    });
  });

  describe("Tier 4 — admin override", () => {
    it("can override a normal block", () => {
      const orig: GateResult = {
        verdict: "block", reasoning: "bad", source: "rules",
        overrideable: true, timestamp: 0, constitutionVersion: 1,
      };
      const r = adminOverride(orig, "justified", "admin1");
      expect(r.verdict).toBe("allow");
      expect(r.source).toBe("admin_override");
    });

    it("cannot override Tier 0", () => {
      const orig: GateResult = {
        verdict: "block", reasoning: "csam", source: "tier0",
        overrideable: false, timestamp: 0, constitutionVersion: 1,
      };
      const r = adminOverride(orig, "try anyway", "admin1");
      expect(r.verdict).toBe("block");
      expect(r.reasoning).toContain("DENIED");
    });
  });
});
