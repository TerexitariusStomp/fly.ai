"""Fly Brain Durable Object — runs the real connectome simulation.

Uses fly_brain_pyodide.FlyBrain (pure numpy port of fly_brain.py, MIT, alextitonis)
to run the LIF simulation on the actual MaleCNS v1.0 connectome (166,700 neurons,
5.1M synapses after pruning). Weights loaded from R2.

ALIGNED WITH alextitonis/fly.ai:
  - fly_eyes.FeatureDetectors for encoding (loom→LPLC2, threat→LC4, shot→LPLC1, chase→LC10a)
  - flyreservoir.Trace for decaying spike trace over 1,314 descending neurons
  - flyreservoir.Readout for PCA + logistic regression (CV-selected)
  - flyreservoir.best_threshold for F-beta threshold optimization
  - sshfighter/fly_fighter.py patterns: multi-fly voting, exploration, Decoder
  - sshfighter/reservoir.py patterns: Featurizer, Recorder

Self-improving: trains a reservoir readout every 10 completed trades.
Connectome stays frozen. Only the readout and encoder are learned.
"""
from __future__ import annotations

import json
import time
import tempfile
import os
import base64
import re

import numpy as np

from workers import DurableObject, Response, WorkerEntrypoint, fetch

# OSS imports (MIT licensed, alextitonis/fly.ai)
from fly_brain_pyodide import FlyBrain
from fly_eyes import FeatureDetectors
from flyreservoir import Readout, Trace, run, best_threshold, fit_ridge, project

# Decision neuron groups — configurable per connectome via metadata.
# Fly connectomes use MaleCNS motor groups; others use cell_type lookup.
# These are fallbacks — the actual groups come from brain.groups (metadata).
DEFAULT_BUY_NEURONS = ["forward_L", "forward_R", "descending_neuron", "MN", "ON_ganglion", "cMN", "motor", "deep_pyramidal"]
DEFAULT_SELL_NEURONS = ["escape_L", "escape_R", "MGIN", "OFF_ganglion", "reverse_cMN", "interneuron", "somatosensory"]
DEFAULT_HOLD_NEURONS = ["backward_L", "backward_R", "BVIN", "wide_field", "interneuron", "association", "layer_2_3"]

SIMULATION_STEPS = 200  # 200 steps × 20ms = 4s simulated time per decision
WARMUP_STEPS = 40       # First 40 steps are warmup (discard)

# Large connectomes (>10K neurons) use fewer steps to fit within the
# 30s Python Worker CPU limit. The LIF dynamics still converge — we
# just sample a shorter window of simulated time.
LARGE_CONNECTOME_THRESHOLD = 10_000  # neurons
LARGE_SIMULATION_STEPS = 50          # 50 steps × 20ms = 1s simulated time
LARGE_WARMUP_STEPS = 10

def get_simulation_params(n_neurons: int) -> tuple[int, int]:
    """Return (steps, warmup) scaled by connectome size."""
    if n_neurons > LARGE_CONNECTOME_THRESHOLD:
        return LARGE_SIMULATION_STEPS, LARGE_WARMUP_STEPS
    return SIMULATION_STEPS, WARMUP_STEPS

# Exploration rate during recording (from sshfighter/fly_fighter.py EXPLORE_P)
EXPLORE_P = 0.07  # 7% of decisions are random to gather diverse training data

# Signals are persisted every Nth tick — keeps D1 row writes ~5x under
# the free-tier daily limit (6K/day vs 30K/day). Decisions still run
# every tick; only persistence is coarser.
SIGNAL_FLUSH_EVERY = 5

# Feature vector: 6 normalized market features for the encoder
FEATURE_KEYS = ["liquidity_norm", "volume_norm", "momentum", "buy_ratio", "score_norm", "age_norm"]

# Fly connectomes that use fly_eyes.FeatureDetectors for visual encoding
FLY_CONNECTOMES = {"drosophila"}

# Region-level connectomes that use region-as-population expansion
REGION_CONNECTOMES = {"human", "macaque_modha", "mouse", "rat"}

# The 7 governing connectome IDs (loaded from R2)
# Live FLYAI token on Robinhood mainnet — governance proposals are evaluated
# against this market (they all act on the fly.ai protocol's treasury).
FLYAI_TOKEN = "0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C"

ALL_CONNECTOMES = [
    "drosophila", "rat", "mouse", "ciona",
    "macaque_modha", "human", "celegans_male",
]

# Each connectome reasons with a different Workers AI model — diversity of
# "cognition" like the neuron-count spread (49 → 575). Roughly scaled:
# small connectomes get small fast models, the big ones get the frontier.
LLM_MODELS = {
    "drosophila":     "@cf/meta/llama-3.2-3b-instruct",
    "rat":            "@cf/mistral/mistral-7b-instruct-v0.2",
    "mouse":          "@cf/meta/llama-3.1-8b-instruct",
    "ciona":          "@cf/qwen/qwen1.5-14b-chat-awq",
    "macaque_modha":  "@cf/qwen/qwq-32b",
    "human":          "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    "celegans_male":  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
}
LLM_MODEL_DEFAULT = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"


def _strip_think(text: str) -> str:
    """Reasoning models (r1, qwq) wrap chain-of-thought in <think> tags."""
    return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()


class ConnectomeDO(DurableObject):
    """Durable Object that runs any connectome with self-improving readout.

    Supports the 7 governing connectomes.
    Each DO instance is named by connectome_id (e.g. 'drosophila', 'celegans_male').
    Loads weights from R2 at '<connectome_id>/weights.npz' and '<connectome_id>/brain.npz'.
    Uses fly_eyes.FeatureDetectors only for fly connectomes; others use direct cell-type injection.
    """

    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.connectome_id = None  # Set from DO name in _ensure_brain
        self.brain = None
        self.initialized = False
        self.readout = None       # Trained reservoir readout (flyreservoir.Readout)
        self.encoder_w_az = None  # Learned encoder weights for azimuth
        self.encoder_w_int = None # Learned encoder weights for intensity
        self.encoder_b_az = 0.0
        self.encoder_b_int = 0.5
        self.eyes = None          # fly_eyes.FeatureDetectors (fly connectomes only)
        self.rng = np.random.default_rng(64)
        self.buy_neurons = None   # Resolved per-connectome from metadata
        self.sell_neurons = None
        self.hold_neurons = None
        self._left_cells = None   # Lateralized injection sets (lazy)
        self._right_cells = None
        self._genome = None       # Evolvable personality params (D1)
        # D1 write circuit breaker — trips on "exceeded limit" and stays
        # closed until UTC midnight. In-memory only: no storage dependency,
        # no counter to corrupt, self-heals each day.
        self._d1_dead_day = None
        # Signal buffer — holds the CURRENT tick's signals only (overwritten
        # each tick). Flushed to D1 every SIGNAL_FLUSH_EVERY ticks.
        self._signal_buffer = []
        self._tick_count = 0

    def _d1_writable(self) -> bool:
        """False while the D1 write breaker is tripped for the current UTC day."""
        today = int(time.time()) // 86400
        if self._d1_dead_day == today:
            return False
        self._d1_dead_day = None  # new day (or never tripped) — breaker resets
        return True

    async def _safe_run(self, sql: str, params: tuple = ()) -> bool:
        """Run one D1 write; trip the breaker on limit errors.

        Returns True on success, False if skipped or failed. Once the
        breaker trips, all subsequent writes short-circuit in memory —
        no further D1 calls, so a failure can't feedback-loop.
        """
        if not self._d1_writable():
            return False
        try:
            await self.env.DB.prepare(sql).bind(*params).run()
            return True
        except Exception as e:
            if "exceeded" in str(e) or "limit" in str(e).lower():
                self._d1_dead_day = int(time.time()) // 86400
                self._signal_buffer = []
                print(f"[{self.connectome_id}] D1 write limit hit — writes disabled until UTC midnight")
            else:
                print(f"[{self.connectome_id}] D1 write failed: {e}")
            return False

    async def _read_weight(self, path: str) -> bytes:
        """Read a weight blob from D1 — single row in `weights`, or chunked
        rows in `weight_chunks` for files over the D1 statement limit."""
        row = await self.env.DB.prepare(
            "SELECT data_b64 FROM weights WHERE path = ?"
        ).bind(path).first()
        if row is not None:
            return base64.b64decode(row["data_b64"])
        # chunked path
        chunks = await self.env.DB.prepare(
            "SELECT data_b64 FROM weight_chunks WHERE path = ? ORDER BY seq"
        ).bind(path).all()
        if not chunks.results:
            raise RuntimeError(f"{path} not found in D1 weights")
        b64 = "".join(r["data_b64"] for r in chunks.results)
        return base64.b64decode(b64)

    async def _write_weight(self, path: str, data: bytes):
        """Write a weight blob to D1 — chunked into `weight_chunks` if the
        base64 encoding exceeds the single-statement size limit (~90KB).
        Aborts cleanly if the D1 write breaker trips mid-write."""
        b64 = base64.b64encode(data).decode()
        if not await self._safe_run("DELETE FROM weights WHERE path = ?", (path,)):
            return
        if not await self._safe_run("DELETE FROM weight_chunks WHERE path = ?", (path,)):
            return
        CHUNK = 60000
        if len(b64) <= CHUNK:
            await self._safe_run(
                "INSERT INTO weights (path, data_b64, size, uploaded_at) VALUES (?, ?, ?, ?)",
                (path, b64, len(data), int(time.time())))
        else:
            for seq, i in enumerate(range(0, len(b64), CHUNK)):
                if not await self._safe_run(
                        "INSERT INTO weight_chunks (path, seq, data_b64) VALUES (?, ?, ?)",
                        (path, seq, b64[i:i + CHUNK])):
                    return

    async def _read_r2_stream(self, obj) -> bytes:
        """Read an R2 object body as bytes using the stream API."""
        body = obj.body
        reader = body.getReader()
        chunks = []
        while True:
            result = await reader.read()
            if result.done:
                break
            chunk = result.value
            # chunk is a JsProxy Uint8Array — convert to Python bytes
            chunks.append(bytes(chunk))
        return b"".join(chunks)

    async def _ensure_brain(self):
        """Load connectome weights + trained models from R2."""
        if self.initialized:
            return

        # If connectome_id not set yet, try to extract from DO name
        if not self.connectome_id:
            try:
                do_name = str(self.ctx.id().name)
                if not do_name or do_name == "None":
                    do_name = "drosophila"
            except Exception:
                do_name = "drosophila"
            self.connectome_id = do_name.split(":")[-1] if ":" in do_name else do_name

        try:
            self._log(f"starting brain initialization for {self.connectome_id}")
        except Exception:
            pass

        # Weight keys: connectome-prefixed (stored in D1 — R2 not enabled)
        cid = self.connectome_id
        weights_key = f"{cid}/weights.npz"
        meta_key = f"{cid}/brain.npz"

        # Fetch weights from D1: `weights` for small files, `weight_chunks` for large
        try:
            self._log(f"fetching weights: {weights_key}, {meta_key}")
            weights_bytes = await self._read_weight(weights_key)
            meta_bytes = await self._read_weight(meta_key)
            self._log(f"got bytes: weights={len(weights_bytes)}, meta={len(meta_bytes)}")

            weights_file = tempfile.NamedTemporaryFile(suffix=".npz", delete=False)
            weights_file.write(weights_bytes)
            weights_file.close()

            meta_file = tempfile.NamedTemporaryFile(suffix=".npz", delete=False)
            meta_file.write(meta_bytes)
            meta_file.close()

            self._log("loading FlyBrain from temp files")

            self.brain = FlyBrain(weights_npz=weights_file.name, meta_npz=meta_file.name, seed=64)
            os.unlink(weights_file.name)
            os.unlink(meta_file.name)

            self._log(f"FlyBrain loaded: {self.brain.n} neurons")

            # Initialize fly_eyes.FeatureDetectors only for fly connectomes
            if self.connectome_id in FLY_CONNECTOMES:
                self.eyes = FeatureDetectors(self.brain)
                self._log("FeatureDetectors initialized (fly connectome)")
            else:
                self.eyes = None
                self._log(f"Non-fly connectome {self.connectome_id} — using direct injection")

            # Resolve BUY/SELL/HOLD neuron groups from brain metadata (cell types)
            # Falls back to DEFAULT_*_NEURONS if no matching groups found
            self.buy_neurons = self._resolve_neurons(DEFAULT_BUY_NEURONS)
            self.sell_neurons = self._resolve_neurons(DEFAULT_SELL_NEURONS)
            self.hold_neurons = self._resolve_neurons(DEFAULT_HOLD_NEURONS)
            self._log(f"Neuron groups resolved: buy={len(self.buy_neurons)} sell={len(self.sell_neurons)} hold={len(self.hold_neurons)}")

            # Resolve L/R hemispheres then calibrate synaptic gain — binary-
            # weighted pruned brains avalanche at default gain; find the regime
            # where input propagates without total saturation.
            self._resolve_hemispheres()
            self._calibrate_gain()
        except Exception as e:
            self._log(f"brain init failed: {e}")
            raise

        # Load trained readout from D1 (connectome-prefixed)
        readout_key = f"{self.connectome_id}/readout.npz"
        try:
            r_bytes = await self._read_weight(readout_key)
            r_file = tempfile.NamedTemporaryFile(suffix=".npz", delete=False)
            r_file.write(r_bytes)
            r_file.close()
            self.readout = Readout.load(r_file.name)
            os.unlink(r_file.name)
        except Exception:
            pass  # no readout trained yet — normal on first boot

        # Load trained encoder from D1 (connectome-prefixed)
        encoder_key = f"{self.connectome_id}/encoder.npz"
        try:
            e_bytes = await self._read_weight(encoder_key)
            e_file = tempfile.NamedTemporaryFile(suffix=".npz", delete=False)
            e_file.write(e_bytes)
            e_file.close()
            enc = np.load(e_file.name)
            self.encoder_w_az = enc["w_az"]
            self.encoder_w_int = enc["w_int"]
            self.encoder_b_az = float(enc["b_az"])
            self.encoder_b_int = float(enc["b_int"])
            os.unlink(e_file.name)
        except Exception:
            pass  # no encoder trained yet

        self.initialized = True
        # Log init once per DO, not per cold start — the isolate is evicted
        # between alarms so an unguarded write would grow audit_log forever.
        if await self.ctx.storage.get("init_logged"):
            return
        wrote = await self._safe_run(
            "INSERT INTO audit_log (event, data, created_at) VALUES (?, ?, ?)",
            ("fly_brain_init", json.dumps({
                "neurons": self.brain.n,
                "synapses": len(self.brain.data),
                "groups": list(self.brain.groups.keys()),
                "visual_neurons": len(self.brain.visual),
                "readout_loaded": self.readout is not None,
                "encoder_loaded": self.encoder_w_az is not None,
                "readout_cv_score": float(self.readout.cv_score) if self.readout else None,
                "eyes_loaded": self.eyes is not None,
            }), int(time.time())))
        if wrote:
            await self.ctx.storage.put("init_logged", True)

    def _log(self, message: str):
        """Console logging only — zero D1 writes, so a D1 failure can
        never feedback-loop through the error path."""
        print(f"[{self.connectome_id}] {message}")

    def _resolve_neurons(self, candidate_types: list[str]) -> np.ndarray:
        """Resolve neuron indices from cell type names in connectome metadata.

        Tries brain.groups first (named motor groups), then brain.cells() (cell types).
        Returns the first matching group, or empty array if none match.
        """
        # Try brain.groups (named groups from metadata, e.g. 'forward_L')
        for t in candidate_types:
            if t in self.brain.groups and len(self.brain.groups[t]) > 0:
                return self.brain.groups[t]
        # Try brain.cells() (cell type lookup)
        idx = self.brain.cells(candidate_types)
        if len(idx) > 0:
            return idx
        # Fallback: use a random subset of neurons (for connectomes without matching types)
        if self.brain.n > 0:
            rng = np.random.default_rng(42)
            return rng.choice(self.brain.n, size=min(10, self.brain.n), replace=False)
        return np.array([], dtype=np.int64)

    async def _get_genome(self) -> dict:
        """Evolvable personality/genome for this connectome — loaded once per
        DO lifetime. bias shifts input score; risk_appetite scales confidence;
        persona steers the LLM adjudication layer."""
        if self._genome is not None:
            return self._genome
        g = {"risk_appetite": 0.5, "bias": 0.0, "persona": "", "generation": 0}
        try:
            row = await self.env.DB.prepare(
                "SELECT risk_appetite, bias, persona, generation FROM connectome_genome WHERE connectome_id = ?"
            ).bind(self.connectome_id).first()
            if row:
                g.update({k: row[k] for k in g if row[k] is not None})
        except Exception:
            pass
        self._genome = g
        return g

    async def _llm_adjudicate(self, token: dict, neural: dict) -> dict:
        """LLM layer on top of neural inference — the connectome's persona
        interprets the brain's raw decision against market context. Returns
        final {action, confidence, reason, llm_note}. Falls back to the neural
        decision if the LLM is unavailable or unparseable."""
        g = await self._get_genome()
        persona = g.get("persona") or "You are a connectome trading brain."
        prompt = (
            f"Your neural network just evaluated a market:\n"
            f"- Neural decision: {neural['action']} (confidence {neural['confidence']:.2f})\n"
            f"- Neural detail: {neural['reason']}\n"
            f"- Market: price=${token.get('price_usd', '?')}, vol24h=${token.get('volume_24h', '?')}, "
            f"chg24h={token.get('price_change_24h', '?')}%, score={token.get('score', '?')}\n"
            f"Vote your intent as JSON only: {{\"action\": 1|-1|0, \"confidence\": 0-100, \"note\": \"<10 words\"}}. "
            f"1=support/buy, -1=oppose/sell, 0=abstain."
        )
        try:
            if not await self._ai_budget_ok():
                return {**neural, "llm_note": "ai budget exhausted — neural only"}
            resp = await self.env.AI.run(LLM_MODELS.get(self.connectome_id) or LLM_MODEL_DEFAULT, {
                "messages": [
                    {"role": "system", "content": persona},
                    {"role": "user", "content": prompt},
                ],
                "max_tokens": 80,
            })
            try:
                resp = resp.to_py()
            except Exception:
                pass
            try:
                text = resp["response"]          # JsDict/dict subscript
            except Exception:
                text = getattr(resp, "response", None) or str(resp)
            text = _strip_think(str(text))
            import re, ast as _ast
            m = re.search(r'\{[^{}]*["\']action["\'][^{}]*\}', text)
            if m:
                try:
                    j = json.loads(m.group(0))
                except Exception:
                    j = _ast.literal_eval(m.group(0))  # single-quoted py dict
                action = max(-1, min(1, int(j.get("action", 0))))
                conf = max(0, min(100, int(j.get("confidence", 0))))
                return {
                    "action": {1: "BUY", -1: "SELL", 0: "HOLD"}[action],
                    "confidence": conf / 100.0,
                    "reason": f"llm: {j.get('note','')} | neural: {neural['reason']}",
                    "llm_action": action,
                }
            if not m:
                # loose fallback: bare -1/0/1 digit or BUY/SELL/HOLD word
                bare = re.search(r'(?<![\d.-])(-?1|0)(?![\d.])', text)
                word = re.search(r'\b(BUY|SELL|HOLD|FOR|AGAINST|ABSTAIN)\b', text, re.I)
                if bare or word:
                    tok = (bare.group(1) if bare else word.group(1).upper())
                    act = {"1":1,"-1":-1,"0":0,"BUY":1,"FOR":1,"SELL":-1,"AGAINST":-1,"HOLD":0,"ABSTAIN":0}.get(tok, 0)
                    return {"action": {1:"BUY",-1:"SELL",0:"HOLD"}[act],
                            "confidence": 0.6, "reason": f"llm(loose): {text[:60]}",
                            "llm_action": act}
                return {**neural, "llm_note": "unparseable", "llm_raw": text[:120]}
        except Exception as e:
            return {**neural, "llm_note": f"llm error: {e}"}

    async def _get_setting(self, key: str, default: str = "") -> str:
        row = await self.env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first()
        return row["value"] if row else default

    # Free-tier guard: hard daily cap on Workers AI calls. llama-3.3-70b
    # costs ~1 neuron/token; 350 calls/day ≈ <1k neurons worst case.
    AI_DAILY_CAP = 350

    async def _ai_budget_ok(self) -> bool:
        """Atomically bump today's AI-call counter; False once over cap."""
        key = f"meter_ai_{time.strftime('%Y%m%d')}"
        try:
            row = await self.env.DB.prepare(
                "UPDATE settings SET value = CAST(COALESCE(value,'0') AS INTEGER) + 1 "
                "WHERE key = ? RETURNING value"
            ).bind(key).first()
            if not row:
                await self.env.DB.prepare(
                    "INSERT INTO settings (key, value) VALUES (?, '1')"
                ).bind(key).run()
                return True
            return int(row["value"]) <= self.AI_DAILY_CAP
        except Exception:
            return True  # meter failure never blocks the colony

    async def _ai_text(self, system: str, user: str, max_tokens: int = 300) -> str:
        """Workers AI call → plain text. Handles the JS-proxy response."""
        if not await self._ai_budget_ok():
            raise RuntimeError("ai budget exhausted for today")
        resp = await self.env.AI.run(LLM_MODELS.get(self.connectome_id) or LLM_MODEL_DEFAULT, {
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": max_tokens,
        })
        try:
            resp = resp.to_py()
        except Exception:
            pass
        try:
            text = resp["response"]
        except Exception:
            text = getattr(resp, "response", None) or str(resp)
        return _strip_think(str(text))

    async def _llm_code(self, task: str, file_path: str, file_content: str) -> dict:
        """Code generation — the connectome's persona + LLM writes the new
        file content. Colony review (/review) decides whether it merges."""
        g = await self._get_genome()
        persona = g.get("persona") or "You are a connectome engineer."
        prompt = (
            "You are a software engineer for the Symbient colony.\n"
            f"Task: {task}\n"
            f"File: {file_path}\n"
            f"Current content:\n```\n{file_content[:8000]}\n```\n"
            "Return ONLY the complete updated file content — no commentary, no code fences. "
            "If the task doesn't apply to this file, return the content unchanged."
        )
        text = await self._ai_text(persona, prompt, max_tokens=3000)
        import re as _re
        m = _re.search(r"```[a-zA-Z]*\n(.*)```\s*$", text, _re.S)
        if m:
            text = m.group(1)
        return {"new_content": text.strip("\n") + "\n",
                "note": f"code by {self.connectome_id} gen {g.get('generation',0)}",
                "connectome_id": self.connectome_id}

    async def _llm_ideate(self, repo_map: str, recent_outcomes: str) -> dict:
        """Self-directed task ideation — the connectome picks ONE file in the
        colony repo and proposes a concrete improvement. Returns
        {task, file_path, rationale}. Colony review decides whether it ships."""
        g = await self._get_genome()
        persona = g.get("persona") or "You are a connectome engineer."
        prompt = (
            "You maintain the Symbient colony's own codebase. Pick ONE file and "
            "propose ONE concrete, small improvement (bug fix, clarity, feature).\n"
            f"Repo files:\n{repo_map[:6000]}\n\n"
            f"Recent task outcomes:\n{recent_outcomes[:2000]}\n\n"
            "Prefer files and changes you can fully rewrite confidently. "
            "Return JSON only: "
            "{\"task\": \"<one sentence>\", \"file_path\": \"<repo path>\", "
            "\"rationale\": \"<why this helps, <15 words>\"}."
        )
        text = await self._ai_text(persona, prompt, max_tokens=200)
        import re, ast as _ast
        m = re.search(r'\{[^{}]*["\']task["\'][^{}]*\}', text)
        if m:
            try:
                j = json.loads(m.group(0))
            except Exception:
                j = _ast.literal_eval(m.group(0))
            return {"task": str(j.get("task", ""))[:200],
                    "file_path": str(j.get("file_path", ""))[:300],
                    "rationale": str(j.get("rationale", ""))[:200],
                    "connectome_id": self.connectome_id}
        return {"error": f"unparseable ideation: {text[:100]}"}

    async def _llm_review(self, task: str, file_path: str, patch: str) -> dict:
        """Code-review vote — same {action,confidence,reason} shape as /decide
        so the governance worker reuses its tally. 1=approve, -1=reject, 0=abstain."""
        g = await self._get_genome()
        persona = g.get("persona") or "You are a connectome code reviewer."
        prompt = (
            "Review this proposed code change for the colony repo.\n"
            f"Task: {task}\nFile: {file_path}\n"
            f"Proposed new content:\n```\n{patch[:8000]}\n```\n"
            "Reject anything that exfiltrates secrets/keys, drains funds, adds hidden "
            "privileges, or is clearly broken.\n"
            "Reply with ONLY this JSON on ONE line — no other text, no markdown:\n"
            "{\"action\": 1, \"confidence\": 75, \"note\": \"<10 words\"}\n"
            "action: 1=approve, -1=reject, 0=abstain."
        )
        try:
            text = await self._ai_text(persona, prompt, max_tokens=80)
        except Exception as e:
            return {"action": 0, "confidence": 0, "reason": f"llm error: {e}"}
        import re, ast as _ast
        m = re.search(r'\{[^{}]*["\']action["\'][^{}]*\}', text)
        if m:
            try:
                j = json.loads(m.group(0))
            except Exception:
                j = _ast.literal_eval(m.group(0))
            action = max(-1, min(1, int(j.get("action", 0))))
            conf = max(0, min(100, int(j.get("confidence", 0))))
            return {"action": action, "confidence": conf,
                    "reason": f"review: {j.get('note','')}"}
        # Keyword fallback — the model wrote prose; extract the verdict
        low = text.lower()
        if re.search(r'\b(reject|block|do not (merge|approve)|unsafe|vulnerable)\b', low):
            return {"action": -1, "confidence": 60, "reason": f"review(kw): {text[:60]}"}
        if re.search(r'\b(approve|lgtm|merge|looks good|ship)\b', low):
            return {"action": 1, "confidence": 60, "reason": f"review(kw): {text[:60]}"}
        bare = re.search(r'(?<![\d.-])(-?1|0)(?![\d.])', text)
        if bare:
            return {"action": max(-1, min(1, int(bare.group(1)))), "confidence": 60,
                    "reason": f"review(loose): {text[:60]}"}
        return {"action": 0, "confidence": 0, "reason": f"review unparseable: {text[:80]}"}

    async def _fetch_candidates(self, limit: int = 3) -> list:
        """Fetch top-scored token candidates.

        Prefers the edge-cached api-worker endpoint — 16 DOs share one
        cached response instead of each scanning D1 every minute, which
        would exhaust the free-tier daily row-read limit. Falls back to
        a direct D1 query if the API is unreachable.
        """
        api_base = getattr(self.env, "API_BASE_URL", None) or "https://api-worker.terexmaps.workers.dev"
        try:
            resp = await fetch(f"{api_base}/api/tokens?min_score=30&limit={limit}")
            if resp.status == 200:
                data = await resp.json()
                if isinstance(data, list):
                    return data
        except Exception as e:
            self._log(f"candidate fetch via API failed, falling back to D1: {e}")
        cursor = await self.env.DB.prepare(
            "SELECT address, symbol, launchpad, score, score_reasons FROM tokens "
            "WHERE ignored = 0 AND score > 30 ORDER BY score DESC LIMIT ?"
        ).bind(limit).all()
        return list(cursor.results or [])

    async def alarm(self, alarm_info=None):
        """Main trading loop — runs every 1 minute.

        Always reschedules the next alarm, even on crash, so the DO
        never goes permanently silent. Uses exponential backoff on
        repeated failures to avoid burning CPU on a broken connectome.
        """
        try:
            await self._ensure_brain()
            candidates = await self._fetch_candidates(limit=3)
            cpu_start = time.process_time()
            self._signal_buffer = []
            for token in candidates:
                # CPU watchdog — DO alarms get 30s; bail at 20s so the
                # alarm always completes and reschedules.
                if time.process_time() - cpu_start > 20.0:
                    self._log("CPU watchdog — skipping remaining candidates")
                    break
                try:
                    decision = await self._evaluate_token(token)
                    # LLM layer on actionable signals — the persona confirms
                    # or vetoes BUY/SELL before it becomes a signal. Bounded:
                    # only fires on non-HOLD, and _ai_budget_ok caps daily calls.
                    if decision.get("action") in ("BUY", "SELL"):
                        decision = await self._llm_adjudicate(token, decision)
                except Exception as e:
                    self._log(f"eval failed for {token.get('address', '?')}: {e}")
                    continue
                self._signal_buffer.append((
                    token["address"], decision["action"], decision["confidence"],
                    decision["neural_activity"], decision["features"],
                    decision["score"], decision["reason"], self.connectome_id, int(time.time()),
                ))
            # Persist signals every SIGNAL_FLUSH_EVERY ticks — the buffer
            # holds only the current tick's signals, so intermediate ticks
            # are skipped and D1 writes drop ~5x. Tick count lives in DO
            # storage because the isolate is evicted between alarms —
            # an in-memory counter would reset every tick and never flush.
            tick = (await self.ctx.storage.get("tick_count") or 0) + 1
            if tick >= SIGNAL_FLUSH_EVERY:
                tick = 0
                await self._flush_signals()
            await self.ctx.storage.put("tick_count", tick)
            # Fan out: drive the pipeline workers that have no cron of their
            # own (free tier = 5 crons/account, all used). One DO alarm chain
            # kicks discovery → trade → social each minute.
            key = {"X-Colony-Key": self.env.COLONY_ADMIN_KEY}
            if self.connectome_id == "drosophila":  # only one connectome fans out
                for url in (
                    "https://discovery-worker.terexmaps.workers.dev/",
                    "https://trade-worker.terexmaps.workers.dev/process",
                    "https://enrichment-worker.terexmaps.workers.dev/",
                ):
                    try:
                        await fetch(url, headers=key)
                    except Exception:
                        pass
            # Social every ~7 ticks (~7 min) — keeps posting cadence human
            if self.connectome_id == "celegans_male" and int(time.time()) % 420 < 60:
                try:
                    await fetch("https://social-worker.terexmaps.workers.dev/post", headers=key)
                except Exception:
                    pass
            # Governance cycle every ~15 min — propose/vote/execute queued
            # protocol actions (rewards funding, bond params, whitelists)
            if self.connectome_id == "human" and int(time.time()) % 900 < 60:
                try:
                    await fetch("https://governance-worker.terexmaps.workers.dev/governance/cycle", headers=key)
                except Exception:
                    pass
            # Success — reset backoff to 1 minute
            await self.ctx.storage.setAlarm(int(time.time() * 1000) + 60_000)
        except Exception as e:
            self._log(str(e))
            # Still reschedule, but with backoff (5 min on crash)
            # so the DO retries instead of going permanently silent.
            await self.ctx.storage.setAlarm(int(time.time() * 1000) + 300_000)

    async def _flush_signals(self):
        """Batch-insert the buffered signals in one or more multi-row
        INSERTs (max 10 rows each — D1 allows 100 bound params, we use 9).
        All-or-drop: on failure the buffer is cleared, never retried."""
        while self._signal_buffer and self._d1_writable():
            chunk, self._signal_buffer = self._signal_buffer[:10], self._signal_buffer[10:]
            placeholders = ",".join(["(?,?,?,?,?,?,?,?,?)"] * len(chunk))
            flat = tuple(v for row in chunk for v in row)
            ok = await self._safe_run(
                "INSERT INTO signals (token_address, decision, confidence, neural_activity, "
                f"feature_snapshot, score, reason, connectome_id, created_at) VALUES {placeholders}",
                flat)
            if not ok:
                break
        self._signal_buffer = []

    def _extract_features(self, token: dict) -> np.ndarray:
        """Extract 6 normalized market features from token data."""
        score = float(token.get("score", 0))
        reasons = json.loads(token.get("score_reasons") or "{}")
        return np.array([
            0.5,  # liquidity_norm
            0.5,  # volume_norm
            0.5,  # momentum
            0.5,  # buy_ratio
            min(score / 100.0, 1.0),  # score_norm
            0.5,  # age_norm
        ], dtype=np.float32)

    def _market_to_fly_inputs(self, token: dict, features: np.ndarray):
        """Map market data to fly sensory inputs (upstream detector_inputs pattern).

        Returns (opp, shots, threat) for fly_eyes.FeatureDetectors.inject().
        """
        score = float(token.get("score", 0))
        # dx: azimuth position (-1 = far left/bearish .. +1 = far right/bullish)
        # Use score as the "position" of the market relative to neutral
        dx = (score - 50) / 50.0  # -1 .. +1

        # size: "angular size" of the market movement (volatility proxy)
        size = 30.0  # default size (matching upstream's opponent size)

        # threat: dump risk 0..1 (sell pressure)
        threat = 0.0
        reasons = json.loads(token.get("score_reasons") or "{}")
        if isinstance(reasons, dict):
            negatives = reasons.get("negatives", [])
            if any("sell" in str(n).lower() or "dump" in str(n).lower() for n in negatives):
                threat = 0.8
            elif any("low" in str(n).lower() and "liquid" in str(n).lower() for n in negatives):
                threat = 0.3

        # shots: new token launches (small approaching objects)
        shots = []
        launchpad = token.get("launchpad", "")
        if launchpad and score > 50:
            shots = [(f"launch_{token['address'][:8]}", dx * 50, 12.0)]

        return (dx * 50, size), shots, threat  # dx in screen units (upstream uses ~30-90)

    def _market_to_direct_inputs(self, token: dict, features: np.ndarray):
        """Lateralized market injection — mirrors upstream L/R visual steering.

        The packed connectomes carry `side` metadata (L/R hemisphere) but no
        visual neurons, so market signal drives hemispheres directly:
        score > 50 → left hemisphere (approach/forward circuit),
        score < 50 → right hemisphere (retreat/escape circuit).
        Amplitude scales with |score - 50|.
        """
        score = float(token.get("score", 50))
        strength = abs(score - 50.0) / 50.0 * 0.35  # 0..0.35
        inject_list = []
        if strength <= 0.01:
            return inject_list
        target = self._left_cells if score > 50 else self._right_cells
        inject_list.append((target, strength))
        return inject_list

    def _resolve_hemispheres(self):
        """Resolve L/R injection sets — the packed brains' only sensory axis.
        Capped: dense small connectomes avalanche on wide input."""
        if self.brain.side is not None:
            left = np.flatnonzero(self.brain.side == "L")
            right = np.flatnonzero(self.brain.side == "R")
        else:
            left = np.array([], dtype=np.int64)
            right = left
        if len(left) == 0 or len(right) == 0:
            rng = np.random.default_rng(11)
            perm = rng.permutation(self.brain.n)
            half = max(1, self.brain.n // 2)
            left, right = perm[:half], perm[half:]
        cap = max(4, min(16, self.brain.n // 10))
        self._left_cells = left[:cap]
        self._right_cells = right[:cap]

    def _calibrate_gain(self):
        """Binary-search synaptic gain so a probe input produces sparse,
        non-avalanching activity. Binary-weighted pruned connectomes sit at a
        percolation edge — default gain (3.0) avalanches every neuron; we need
        the regime where baseline is quiet and input propagates partially.
        Target: probe fires 2%..30% of neurons/step, baseline near 0."""
        brain = self.brain
        # probe with the real production injection sets — hub neurons make
        # arbitrary probes unrepresentative
        probes = [(self._left_cells, 0.3), (self._right_cells, 0.3)]
        def fires_per_step(gain, steps=100):
            brain.reset(64)
            brain.gain = gain
            brain.tonic = 0.02
            for _ in range(30):
                brain.step()
            worst = 0.0
            for inj in probes:
                brain.reset(64)
                for _ in range(30):
                    brain.step()
                tot = sum(len(brain.step(inject=[inj])) for _ in range(steps))
                worst = max(worst, tot / steps)
            return worst
        lo, hi = 0.001, 1.0
        target_lo, target_hi = 0.02 * brain.n, 0.30 * brain.n
        best = 0.02
        for _ in range(12):
            mid = (lo + hi) / 2
            r = fires_per_step(mid)
            if r < target_lo:
                lo = mid
            elif r > target_hi:
                hi = mid
            else:
                best = mid
                break
            best = mid
        brain.gain = best
        brain.tonic = 0.02
        brain.reset(64)
        self._log(f"calibrated gain={best:.4f} (probe {fires_per_step(best):.1f} fires/step, n={brain.n})")

    async def _evaluate_token(self, token: dict) -> dict:
        """Run LIF simulation for one token using upstream fly_eyes + Trace."""
        brain = self.brain
        brain.reset(seed=64)

        # Genome influence: bias shifts the market signal before it reaches
        # the sensory input — evolved personalities literally perceive the
        # market differently.
        genome = await self._get_genome()
        if genome.get("bias"):
            token = dict(token)
            token["score"] = float(token.get("score", 50)) + float(genome["bias"])

        features = self._extract_features(token)

        # Scale simulation by connectome size to fit within CPU limit
        sim_steps, warmup_steps = get_simulation_params(brain.n)

        # Lateralized market injection for all connectomes — the packed brains
        # have no visual neurons, so the fly_eyes path can't drive them.
        inject_list = self._market_to_direct_inputs(token, features)
        def encode(t):
            if t >= sim_steps:
                return []
            return inject_list

        # Use upstream flyreservoir.Trace over resolved output neurons
        trace = Trace(brain, types=["descending_neuron"], tau=0.1)

        # Run simulation ONCE — collect both trace features and group rates
        counts = {g: 0 for g in brain.groups}
        trace_samples = []
        for step in range(sim_steps):
            inject = encode(step)
            fired = brain.step(inject=inject)
            trace.observe(fired)
            if step >= warmup_steps:
                trace_samples.append(trace.features().copy())
                hit = np.zeros(brain.n, dtype=bool)
                hit[fired] = True
                for g, idx in brain.groups.items():
                    counts[g] += int(hit[idx].sum())

        # Average trace over post-warmup steps (the actual readout features)
        if trace_samples:
            activity_vec = np.mean(trace_samples, 0)
        else:
            activity_vec = trace.features()

        # Compute group firing rates
        window = (SIMULATION_STEPS - WARMUP_STEPS) * brain.dt
        rates = {}
        for g in counts:
            if g in brain.groups and len(brain.groups[g]) > 0:
                rates[g] = counts[g] / (len(brain.groups[g]) * window)
            else:
                rates[g] = 0.0

        # Decision: use learned readout or fallback to hand-written Decoder
        if self.readout is not None:
            p_profit = float(self.readout.predict(activity_vec))
            threshold = float(await self._get_setting("readout_threshold", "0.55"))
            if p_profit > threshold:
                action = "BUY"
                confidence = p_profit
                reason = f"readout P(profit)={p_profit:.2f} > {threshold}"
            else:
                action = "HOLD"
                confidence = 0.0
                reason = f"readout P(profit)={p_profit:.2f} < {threshold}"
        else:
            # Comparative decode (upstream fly_fighter pattern): which motor
            # program dominates post-warmup — forward → BUY, escape → SELL,
            # backward or silence → HOLD. Counts are per group NAME over the
            # post-warmup window.
            fwd = counts.get("forward_L", 0) + counts.get("forward_R", 0)
            esc = counts.get("escape_L", 0) + counts.get("escape_R", 0)
            bwd = counts.get("backward_L", 0) + counts.get("backward_R", 0)
            total = fwd + esc + bwd
            if total == 0:
                action = "HOLD"
                confidence = 0.0
                reason = "no motor activity (quiet network)"
            elif fwd > esc and fwd > bwd:
                action = "BUY"
                confidence = min(1.0, fwd / total)
                reason = f"forward dominant: fwd={fwd} esc={esc} bwd={bwd}"
            elif esc > fwd and esc > bwd:
                action = "SELL"
                confidence = min(1.0, esc / total)
                reason = f"escape dominant: esc={esc} fwd={fwd} bwd={bwd}"
            else:
                action = "HOLD"
                confidence = 0.0
                reason = f"backward/mixed: fwd={fwd} esc={esc} bwd={bwd}"

        # Exploration during recording (from sshfighter/fly_fighter.py EXPLORE_P)
        # 7% of decisions are random to gather diverse training data
        if self.rng.random() < EXPLORE_P:
            action = self.rng.choice(["BUY", "HOLD"])
            confidence = 0.5
            reason = f"exploration random {action} (EXPLORE_P={EXPLORE_P})"

        # Genome: risk_appetite scales expressed confidence (0 → timid, 1 → bold)
        confidence = float(confidence) * (0.5 + float(genome.get("risk_appetite", 0.5)))

        return {
            "action": action,
            "confidence": confidence,
            "reason": reason,
            "neural_activity": json.dumps(activity_vec.astype(float).tolist()),
            "features": json.dumps({k: float(v) for k, v in zip(FEATURE_KEYS, features)}),
            "eye_channels": json.dumps(self.eyes.last) if self.eyes else "null",
            "rates": json.dumps(rates),
            "score": token.get("score", 0),
        }

    async def _store_signal(self, token: dict, decision: dict):
        """Store fly brain decision + features in D1 (used by /trigger for
        immediate persistence — the alarm loop uses _flush_signals instead)."""
        await self._safe_run(
            "INSERT INTO signals (token_address, decision, confidence, neural_activity, "
            "feature_snapshot, score, reason, connectome_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (token["address"], decision["action"], decision["confidence"],
             decision["neural_activity"], decision["features"],
             decision["score"], decision["reason"], self.connectome_id, int(time.time())))

    async def _evolve(self) -> dict:
        """Iterative improvement — score connectomes by recent trading PnL;
        underperformers mutate toward the top performer's genome (params
        blended, persona rewritten by the LLM). Selection pressure on
        personality."""
        g = await self._get_genome()
        now = int(time.time())
        try:
            rows = await self.env.DB.prepare(
                "SELECT connectome_id, COALESCE(SUM(pnl_usd),0) pnl FROM paper_trades "
                "WHERE created_at > ? AND connectome_id IS NOT NULL GROUP BY connectome_id"
            ).bind(now - 7 * 86400).all()
            perf = {r["connectome_id"]: float(r["pnl"] or 0) for r in (rows.results or [])}
        except Exception as e:
            return {"status": "skipped", "error": str(e)}

        my_pnl = perf.get(self.connectome_id, 0.0)
        best_cid, best_pnl = max(perf.items(), key=lambda kv: kv[1]) if perf else (None, 0.0)

        # record pnl score + touch generation only when actually mutating
        await self._safe_run(
            "UPDATE connectome_genome SET pnl_score = ?, updated_at = ? WHERE connectome_id = ?",
            (my_pnl, now, self.connectome_id))

        # I'm the best (or tied/no data) → hold position
        if not best_cid or best_cid == self.connectome_id or my_pnl >= best_pnl:
            return {"status": "held", "my_pnl": my_pnl, "best": best_cid}

        # mutate toward the winner: 70/30 param blend + LLM persona rewrite
        winner = await self.env.DB.prepare(
            "SELECT risk_appetite, bias, persona FROM connectome_genome WHERE connectome_id = ?"
        ).bind(best_cid).first()
        if not winner:
            return {"status": "no_winner_genome"}

        rng = np.random.default_rng(now)
        new_risk = 0.7 * float(g["risk_appetite"]) + 0.3 * float(winner["risk_appetite"]) + float(rng.normal(0, 0.03))
        new_bias = 0.7 * float(g["bias"]) + 0.3 * float(winner["bias"]) + float(rng.normal(0, 1.5))
        new_risk = min(1.0, max(0.0, new_risk))
        new_bias = min(20.0, max(-20.0, new_bias))

        # persona evolves via the LLM — winner's traits grafted in
        new_persona = g.get("persona") or ""
        try:
            if not await self._ai_budget_ok():
                raise RuntimeError("ai budget exhausted")
            resp = await self.env.AI.run(LLM_MODELS.get(self.connectome_id) or LLM_MODEL_DEFAULT, {
                "messages": [
                    {"role": "system", "content": "You evolve AI trading personas. Keep each persona distinct, short (2 sentences), species-flavored."},
                    {"role": "user", "content":
                        f"Evolve this persona toward the colony's top performer.\n"
                        f"MY persona: {new_persona}\n"
                        f"TOP persona ({best_cid}, pnl ${best_pnl:.2f}): {winner['persona']}\n"
                        f"Write the evolved persona (2 sentences, keep my species identity):"},
                ], "max_tokens": 100})
            try:
                resp = resp.to_py()
            except Exception:
                pass
            try:
                text = resp["response"]          # JsDict/dict subscript
            except Exception:
                text = getattr(resp, "response", None) or str(resp)
            text = _strip_think(str(text))
            if text.strip():
                new_persona = text.strip()[:400]
        except Exception:
            pass

        new_gen = int(g["generation"]) + 1
        await self._safe_run(
            "UPDATE connectome_genome SET risk_appetite = ?, bias = ?, persona = ?, generation = ?, updated_at = ? WHERE connectome_id = ?",
            (new_risk, new_bias, new_persona, new_gen, now, self.connectome_id))
        self._genome = None  # reload next call
        return {"status": "evolved", "generation": new_gen, "from": best_cid,
                "risk_appetite": new_risk, "bias": new_bias}

    async def _retrain(self) -> dict:
        """Retrain readout + encoder from completed trade outcomes."""
        data = await self.env.DB.prepare(
            "SELECT neural_activity, features, outcome, pnl_percent FROM training_data "
            "WHERE outcome IS NOT NULL ORDER BY closed_at DESC LIMIT 200"
        ).all()
        rows = data.results or []
        if len(rows) < 10:
            return {"status": "not_enough_data", "n": len(rows)}

        # Parse neural activity (trace features) → X matrix, outcomes → y
        X = np.array([json.loads(r["neural_activity"]) for r in rows], dtype=np.float32)
        y = np.array([r["outcome"] for r in rows], dtype=np.float32)
        features_arr = np.array([list(json.loads(r["features"]).values()) for r in rows], dtype=np.float32)

        # 1. Train readout (flyreservoir.py — OSS)
        readout = Readout.fit(X, y, kind="logistic")
        # Save to D1 (connectome-prefixed)
        r_file = tempfile.NamedTemporaryFile(suffix=".npz", delete=False)
        r_file.close()
        readout.save(r_file.name)
        with open(r_file.name, "rb") as f:
            await self._write_weight(f"{self.connectome_id}/readout.npz", f.read())
        os.unlink(r_file.name)
        self.readout = readout

        # 2. Optimize readout threshold using best_threshold (sshfighter pattern)
        p_train = np.array([float(readout.predict(x)) for x in X])
        optimal_threshold = best_threshold(y, p_train, beta=0.5)
        await self._safe_run(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('readout_threshold', ?)",
            (str(round(optimal_threshold, 3)),))

        # 3. Train encoder via ridge regression (flyreservoir.fit_ridge — OSS)
        pnl = np.array([r["pnl_percent"] or 0 for r in rows], dtype=np.float32)
        if len(np.unique(pnl)) > 1:
            w_az, b_az = fit_ridge(features_arr, pnl, lam=1.0)
            w_int, b_int = fit_ridge(features_arr, np.abs(pnl), lam=1.0)
            self.encoder_w_az = w_az.astype(np.float32)
            self.encoder_w_int = w_int.astype(np.float32)
            self.encoder_b_az = float(b_az)
            self.encoder_b_int = float(b_int)
            e_file = tempfile.NamedTemporaryFile(suffix=".npz", delete=False)
            e_file.close()
            np.savez(e_file.name, w_az=self.encoder_w_az, w_int=self.encoder_w_int,
                     b_az=self.encoder_b_az, b_int=self.encoder_b_int)
            with open(e_file.name, "rb") as f:
                await self._write_weight(f"{self.connectome_id}/encoder.npz", f.read())
            os.unlink(e_file.name)

        # 4. Optimize trade params from historical percentiles
        wins = [r for r in rows if r["outcome"] == 1]
        losses = [r for r in rows if r["outcome"] == 0]
        if wins:
            win_pnls = sorted([r["pnl_percent"] for r in wins])
            profit_target = win_pnls[len(win_pnls) // 4]
        else:
            profit_target = 30
        if losses:
            loss_pnls = sorted([abs(r["pnl_percent"]) for r in losses])
            stop_loss = loss_pnls[len(loss_pnls) * 3 // 4]
        else:
            stop_loss = 15
        win_rate = len(wins) / max(len(wins) + len(losses), 1)
        if wins and losses:
            avg_win = np.mean([r["pnl_percent"] for r in wins])
            avg_loss = np.mean([abs(r["pnl_percent"]) for r in losses])
            kelly = win_rate - (1 - win_rate) / max(avg_win / avg_loss, 0.01)
            max_position = max(10, min(80, kelly * 100))
        else:
            max_position = 50

        now = int(time.time())
        await self._safe_run(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('profit_target_pct', ?)",
            (str(round(profit_target, 1)),))
        await self._safe_run(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('stop_loss_pct', ?)",
            (str(round(stop_loss, 1)),))
        await self._safe_run(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('max_position_pct', ?)",
            (str(round(max_position, 1)),))

        # Log to model_versions
        await self._safe_run(
            "INSERT INTO model_versions (model_type, version, cv_score, trade_count, metrics, saved_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("readout", len(rows), readout.cv_score, len(rows),
             json.dumps({"auc": readout.cv_score, "win_rate": win_rate,
                         "profit_target": profit_target, "stop_loss": stop_loss,
                         "max_position": max_position,
                         "threshold": optimal_threshold}), now))

        # Discord notification
        await self._post_retrain_discord(readout.cv_score, len(rows), win_rate,
                                          profit_target, stop_loss, max_position,
                                          optimal_threshold)

        return {"status": "retrained", "auc": readout.cv_score, "n": len(rows),
                "win_rate": win_rate, "profit_target": profit_target,
                "stop_loss": stop_loss, "max_position": max_position,
                "threshold": optimal_threshold}

    async def _post_retrain_discord(self, auc_score, n_trades, win_rate,
                                      profit_target, stop_loss, max_position, threshold):
        webhook = getattr(self.env, "DISCORD_WEBHOOK_URL", None)
        if not webhook:
            return
        try:
            await fetch(webhook, {
                "method": "POST",
                "headers": {"Content-Type": "application/json"},
                "body": json.dumps({
                    "username": "SYM Brain Trainer",
                    "embeds": [{
                        "title": f"Model retrained ({n_trades} trades)",
                        "color": 0x9b59b6,
                        "fields": [
                            {"name": "Readout AUC", "value": f"{auc_score:.3f}", "inline": True},
                            {"name": "Win rate", "value": f"{win_rate:.1%}", "inline": True},
                            {"name": "Threshold", "value": f"{threshold:.2f}", "inline": True},
                            {"name": "Profit target", "value": f"+{profit_target:.1f}%", "inline": True},
                            {"name": "Stop loss", "value": f"-{stop_loss:.1f}%", "inline": True},
                            {"name": "Max position", "value": f"{max_position:.0f}%", "inline": True},
                        ],
                        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    }],
                }),
            })
        except Exception:
            pass

    async def _verify(self) -> dict:
        """Verify that market signals reach descending neurons (inject.py pattern).

        Stimulates each sensory channel and measures if the signal reaches
        the descending neurons. Returns a diagnostic report.
        """
        brain = self.brain
        brain.reset(seed=64)

        # Test each channel: loom, threat, shot, chase
        channels = {
            "loom": {"opp": (0, 30), "shots": [], "threat": 0.0},
            "threat": {"opp": (0, 30), "shots": [], "threat": 1.0},
            "shot": {"opp": None, "shots": [("test", 0, 12)], "threat": 0.0},
            "chase": {"opp": (50, 30), "shots": [], "threat": 0.0},
        }

        results = {}
        for name, inputs in channels.items():
            brain.reset(seed=64)
            trace = Trace(brain, types=["descending_neuron"], tau=0.1)
            for step in range(LARGE_SIMULATION_STEPS):  # Scaled for fetch handler timeout
                inject = self.eyes.inject(opp=inputs["opp"], shots=inputs["shots"],
                                          threat=inputs["threat"])
                fired = brain.step(inject=inject)
                trace.observe(fired)
            activity = trace.features()
            results[name] = {
                "mean_activity": float(np.mean(activity)),
                "max_activity": float(np.max(activity)),
                "active_neurons": int(np.sum(activity > 0)),
            }

        return {"status": "verified", "channels": results}

    async def fetch(self, request):
        """Manual trigger, status check, retrain, or verify."""
        url = request.url
        # Extract connectome_id from URL path or query param
        if not self.connectome_id:
            # Check query param first
            if "?" in url:
                query = url.split("?")[1]
                for param in query.split("&"):
                    if param.startswith("cid="):
                        self.connectome_id = param.split("=")[1]
                        break
            # Then check URL path
            if not self.connectome_id:
                parts = url.rstrip("/").split("/")
                for p in parts:
                    if p in ALL_CONNECTOMES:
                        self.connectome_id = p
                        break
        if url.endswith("/trigger") or "/trigger?" in url:
            # Initialize and process tokens synchronously
            try:
                await self._ensure_brain()
                candidates = await self._fetch_candidates(limit=3)
                signals_made = 0
                for token in candidates:
                    decision = await self._evaluate_token(token)
                    await self._store_signal(token, decision)
                    signals_made += 1
                # Set alarm for next cycle
                await self.ctx.storage.setAlarm(int(time.time() * 1000) + 60_000)
                return Response.json({"status": "ok", "initialized": self.initialized, "signals": signals_made})
            except Exception as e:
                # Don't set alarm if init failed — prevents crash loop
                if "exceed Python Worker memory limit" in str(e):
                    return Response.json({"status": "skipped", "reason": str(e), "initialized": False})
                self._log(f"trigger failed: {e}")
                return Response.json({"status": "error", "error": str(e), "initialized": self.initialized})
        elif "/r2test" in url:
            # Diagnostic: test weight storage (D1)
            try:
                row = await self.env.DB.prepare(
                    "SELECT path, size FROM weights WHERE path = 'celegans_male/weights.npz'"
                ).first()
                if row is None:
                    return Response.json({"weights": "not found"})
                return Response.json({"weights": "ok", "size": row["size"]})
            except Exception as e:
                return Response.json({"weights": "error", "error": str(e)})
        elif "/clear" in url:
            # Clear alarm — useful for stopping crash loops
            await self.ctx.storage.deleteAlarm()
            return Response.json({"status": "alarm_cleared"})
        elif "/retrain" in url:
            result = await self._retrain()
            return Response.json(result)
        elif "/verify" in url:
            await self._ensure_brain()
            result = await self._verify()
            return Response.json(result)
        elif "/decide" in url:
            # Governance decision — the connectome evaluates a protocol action
            # against LIVE SYM market conditions (the proposal affects SYM).
            # POST body = {signalScore} from the proposal's market context.
            # Returns governor-ready {action: -1|0|1, confidence: 0-100}.
            try:
                await self._ensure_brain()
                market = {}
                try:
                    market = await request.json()
                except Exception:
                    pass
                if not isinstance(market, dict):
                    market = {}
                if not market:
                    # fallback: ?signalScore=NN as query param
                    for param in url.split("?")[-1].split("&"):
                        if param.startswith("signalScore="):
                            market = {"signalScore": float(param.split("=")[1])}
                signal = float((market or {}).get("signalScore", 50) or 50)

                # Real SYM market data — same fields a discovery candidate carries
                token = {"address": FLYAI_TOKEN, "score": signal,
                         "score_reasons": json.dumps({"src": "governance"})}
                try:
                    resp = await fetch(
                        f"https://api.dexscreener.com/latest/dex/tokens/{FLYAI_TOKEN}")
                    dex = await resp.json()
                    pair = (dex.get("pairs") or [{}])[0]
                    token.update({
                        "price_usd": float(pair.get("priceUsd") or 0),
                        "volume_24h": float((pair.get("volume") or {}).get("h24") or 0),
                        "liquidity_usd": float((pair.get("liquidity") or {}).get("usd") or 0),
                        "price_change_24h": float((pair.get("priceChange") or {}).get("h24") or 0),
                        "launchpad": "tolly",
                    })
                except Exception:
                    pass  # DexScreener down → score-only stimulus

                decision = await self._evaluate_token(token)
                # LLM adjudication — the persona layer interprets the raw
                # neural decision and may confirm, veto, or redirect it.
                decision = await self._llm_adjudicate(token, decision)
                action_map = {"BUY": 1, "SELL": -1, "HOLD": 0}
                return Response.json({
                    "action": action_map.get(decision["action"], 0),
                    "confidence": int(round(float(decision["confidence"]) * 100)),
                    "reason": decision["reason"],
                    "debug": {"signal": signal, "token_score": token["score"],
                              "gain": float(self.brain.gain) if self.brain else None,
                              "llm": decision.get("llm_note") or decision.get("reason","")[:60], "llm_raw": decision.get("llm_raw", ""),
                              "n_left": int(len(self._left_cells)) if self._left_cells is not None else -1},
                })
            except Exception as e:
                import traceback
                return Response.json({"error": str(e), "tb": traceback.format_exc()[-800:]}, status=500)
        elif "/code" in url:
            # Code generation — the connectome's persona+LLM writes new file
            # content for a task. POST {task, file_path, file_content}.
            try:
                body = await request.json()
            except Exception:
                body = {}
            if not isinstance(body, dict):
                body = {}
            try:
                return Response.json(await self._llm_code(
                    str(body.get("task", "")), str(body.get("file_path", "")),
                    str(body.get("file_content", ""))))
            except Exception as e:
                return Response.json({"error": str(e)}, status=500)
        elif "/ideate" in url:
            # Self-directed task ideation — pick one file + one improvement.
            # POST {repo_map, recent_outcomes} → {task, file_path, rationale}.
            try:
                body = await request.json()
            except Exception:
                body = {}
            if not isinstance(body, dict):
                body = {}
            try:
                return Response.json(await self._llm_ideate(
                    str(body.get("repo_map", "")), str(body.get("recent_outcomes", ""))))
            except Exception as e:
                return Response.json({"error": str(e)}, status=500)
        elif "/review" in url:
            # Code-review vote — colony quorum gate for merging. POST
            # {task, file_path, patch} → {action, confidence, reason}.
            try:
                body = await request.json()
            except Exception:
                body = {}
            if not isinstance(body, dict):
                body = {}
            try:
                return Response.json(await self._llm_review(
                    str(body.get("task", "")), str(body.get("file_path", "")),
                    str(body.get("patch", ""))))
            except Exception as e:
                return Response.json({"error": str(e)}, status=500)
        elif "/evolve" in url:
            return Response.json(await self._evolve())
        elif "/status" in url:
            return Response.json({
                "initialized": self.initialized,
                "n_neurons": self.brain.n if self.brain else 0,
                "n_synapses": len(self.brain.data) if self.brain else 0,
                "n_groups": len(self.brain.groups) if self.brain else 0,
                "groups": list(self.brain.groups.keys()) if self.brain else [],
                "readout_loaded": self.readout is not None,
                "readout_cv_score": float(self.readout.cv_score) if self.readout else None,
                "encoder_loaded": self.encoder_w_az is not None,
                "eyes_loaded": self.eyes is not None,
            })
        return Response.json({"error": "unknown endpoint"})


class Default(WorkerEntrypoint):
    """Entry point — routes requests to the correct Connectome DO.

    URL path determines which connectome DO to use:
      /<connectome_id>/trigger  -> e.g. /celegans/trigger
      /<connectome_id>/status
      /trigger                  -> defaults to drosophila
    """

    # Routes that cost AI neurons / write D1 — require the colony key.
    # Internal stub fetches (scheduled(), DO-to-DO) bypass this entrypoint
    # entirely, so colony-internal calls never need the header.
    _MUTATION_PATHS = {"trigger", "decide", "code", "ideate", "review",
                       "evolve", "retrain", "clear", "verify", "r2test"}

    def _authed(self, request, path) -> bool:
        if not any(seg in self._MUTATION_PATHS for seg in path):
            return True
        key = request.headers.get("X-Colony-Key") or ""
        return bool(self.env.COLONY_ADMIN_KEY) and key == self.env.COLONY_ADMIN_KEY

    async def fetch(self, request):
        url = request.url
        path = url.rstrip("/").split("/")
        if not self._authed(request, path):
            return Response.json({"error": "forbidden"}, status=403)

        # Handle /all/trigger — trigger all 7 connectomes
        if "all" in path and "trigger" in path:
            results = []
            for cid in ALL_CONNECTOMES:
                do_id = self.env.FLY_BRAIN.idFromName(f"connectome:{cid}")
                do_stub = self.env.FLY_BRAIN.get(do_id)
                try:
                    # Pass connectome_id as query param
                    trigger_url = f"https://do/{cid}/trigger?cid={cid}"
                    await do_stub.fetch(trigger_url)
                    results.append({"connectome": cid, "status": "triggered"})
                except Exception as e:
                    results.append({"connectome": cid, "status": "error", "error": str(e)})
            return Response.json({"status": "alarm_set", "results": results})
        
        # Extract connectome_id from URL path or default to drosophila
        connectome_id = "drosophila"

        for p in path:
            if p in ALL_CONNECTOMES:
                connectome_id = p
                break
        
        # Also check query params
        if "?" in url:
            query = url.split("?")[1]
            for param in query.split("&"):
                if param.startswith("cid="):
                    connectome_id = param.split("=")[1]
        
        do_id = self.env.FLY_BRAIN.idFromName(f"connectome:{connectome_id}")
        do_stub = self.env.FLY_BRAIN.get(do_id)
        # Pass connectome_id as query param so the DO can extract it
        do_url = request.url + (f"&cid={connectome_id}" if "?" in request.url else f"?cid={connectome_id}")
        return await do_stub.fetch(do_url)

    async def scheduled(self, event, env=None, ctx=None):
        """Cron trigger — kick all 7 connectome DOs.

        Fire-and-forget via waitUntil: each /trigger runs a full brain eval
        (~5-40s). Awaiting them serially blows the cron's CPU/wall budget
        after the first couple, leaving the rest silent.
        """
        tasks = []
        for cid in ALL_CONNECTOMES:
            do_id = self.env.FLY_BRAIN.idFromName(f"connectome:{cid}")
            do_stub = self.env.FLY_BRAIN.get(do_id)
            tasks.append(do_stub.fetch(f"https://do/{cid}/trigger?cid={cid}"))
        for t in tasks:
            self.ctx.waitUntil(t)

# Backward-compatible alias
FlyBrainDO = ConnectomeDO
