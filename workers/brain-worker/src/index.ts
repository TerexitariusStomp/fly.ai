/** brain-worker — the full MaleCNS connectome (166,700 neurons) as a Cloudflare Worker.
 *
 *  Vendored from alextitonis/fly.ai world/src/connectome.ts (MIT). The brain runs natively
 *  in TypeScript — no pyodide, no numba. Weights come from D1 `weights`/`weight_chunks`
 *  as FLYW (gzip-compressed binary, quantized codes + LUT, per `flybrain export --web`).
 *
 *  Routes:
 *    POST /episode    one fly episode: {senses: {LPLC2_L: 0.4, ...}, steps?: n, warm?: n, seed?: n}
 *                     → {actions: {escaped: bool, ...}, dn_trace: number[], fired: n, ms: n}
 *    POST /batch      N independent episodes (sequential — one brain, fresh reset each)
 *    GET  /status     brain stats: n, nnz, params, load_ms
 */
import {
  ConnectomeBrain, parseMeta, parseWeights, cells, cellsWithPrefix,
  type ConnectomeMeta, type ConnectomeWeights,
} from "./connectome";

interface Env {
  DB: D1Database;
  BRAIN_ID?: string;   // D1 weights path prefix, default "malecns"
}

let brain: ConnectomeBrain | null = null;
let meta: ConnectomeMeta | null = null;
let loadError: string | null = null;
let loadMs = 0;

async function readBlob(env: Env, path: string): Promise<Uint8Array> {
  const single = await env.DB.prepare("SELECT data_b64 FROM weights WHERE path = ?").bind(path).first();
  if (single) return Uint8Array.from(atob(single.data_b64 as string), (c) => c.charCodeAt(0));
  const chunks = await env.DB.prepare(
    "SELECT data_b64 FROM weight_chunks WHERE path = ? ORDER BY seq"
  ).bind(path).all();
  if (!chunks.results?.length) throw new Error(`${path} not found in D1 weights`);
  const parts = chunks.results.map((r) => Uint8Array.from(atob(r.data_b64 as string), (c) => c.charCodeAt(0)));
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

async function ensureBrain(env: Env): Promise<ConnectomeBrain> {
  if (brain) return brain;
  if (loadError) throw new Error(loadError);
  const id = env.BRAIN_ID ?? "malecns";
  const t0 = Date.now();
  try {
    const metaBytes = await readBlob(env, `${id}/meta.bin`);
    meta = parseMeta(metaBytes.buffer as ArrayBuffer);
    const wBytes = await readBlob(env, `${id}/weights.bin`);  // already decompressed FLYW
    const w: ConnectomeWeights = parseWeights(wBytes.buffer as ArrayBuffer);
    brain = new ConnectomeBrain(w, meta.params, 64);
    loadMs = Date.now() - t0;
    return brain;
  } catch (e) {
    loadError = String(e);
    throw e;
  }
}

// ---------- sensory input groups (same types as upstream fly_eyes.py / market.py) ----------
function inputGroups(m: ConnectomeMeta): Map<string, Int32Array> {
  const g = new Map<string, Int32Array>();
  for (const side of ["L", "R"] as const) {
    for (const type of ["LPLC2", "LC4", "LPLC1", "LC10a"]) g.set(`${type}_${side}`, cells(m, [type], side));
    g.set(`JO_${side}`, cellsWithPrefix(m, "JO", side));   // ear / wind (Johnston's organ)
    g.set(`ORN_${side}`, cellsWithPrefix(m, "ORN", side)); // smell
  }
  return g;
}

// ---------- action output groups (upstream actions.py neuron types) ----------
function outputGroups(m: ConnectomeMeta): Map<string, Int32Array> {
  const g = new Map<string, Int32Array>();
  g.set("escape_L", cells(m, ["DNp01", "DNp02", "DNp04"], "L"));
  g.set("escape_R", cells(m, ["DNp01", "DNp02", "DNp04"], "R"));
  g.set("steer_L", cells(m, ["DNa02"], "L"));
  g.set("steer_R", cells(m, ["DNa02"], "R"));
  g.set("forward_L", cells(m, ["DNg100"], "L"));
  g.set("forward_R", cells(m, ["DNg100"], "R"));
  g.set("backward_L", cells(m, ["MDN"], "L"));
  g.set("backward_R", cells(m, ["MDN"], "R"));
  g.set("groom", cells(m, ["DNg12"]));
  g.set("wings", cellsWithPrefix(m, "MN"));   // wing motor neurons
  return g;
}

interface EpisodeReq {
  senses?: Record<string, number>;   // group name -> drive amount per step
  steps?: number;                    // stimulus steps (default 50 = 1s @ 20ms)
  warm?: number;                     // warmup/rest-measure steps (default 25)
  seed?: number;
  id?: string;
}

interface EpisodeResult {
  id?: string;
  fired_total: number;
  ms: number;
  group_counts: Record<string, number>;
  rest_counts: Record<string, number>;
  dn_trace: number[];
  actions: Record<string, boolean>;
}

const Z_MIN = 3.0, MIN_EXTRA = 3.0;

function runEpisode(b: ConnectomeBrain, m: ConnectomeMeta, req: EpisodeReq): EpisodeResult {
  const warm = req.warm ?? 25;
  const steps = req.steps ?? 50;
  const inputs = inputGroups(m);
  const outputs = outputGroups(m);
  const senses = req.senses ?? {};

  b.reset(req.seed ?? 64);

  // rest: measure baseline activity with no stimulation
  const restCounts: Record<string, number> = {};
  for (const [g] of outputs) restCounts[g] = 0;
  for (let s = 0; s < warm; s++) {
    b.step();
    const fs = new Set(b.fired.slice(0, b.firedCount));
    for (const [g, idx] of outputs) restCounts[g] += countIn(idx, fs);
  }

  // stim: inject senses, count output-group spikes
  const counts: Record<string, number> = {};
  for (const [g] of outputs) counts[g] = 0;
  const dnIdx = outputs.get("escape_L")!;
  const dnTrace: number[] = [];
  const t0 = Date.now();
  for (let s = 0; s < steps; s++) {
    for (const [key, idx] of inputs) {
      const amt = senses[key];
      if (amt && amt > 0) b.stimulate(idx, amt);
    }
    b.step();
    const fs = new Set(b.fired.slice(0, b.firedCount));
    for (const [g, idx] of outputs) counts[g] += countIn(idx, fs);
    dnTrace.push(countIn(dnIdx, fs) / Math.max(1, dnIdx.length));
  }

  // decode vs rest — a group "fired" if it spiked meaningfully more than baseline:
  // absolute extra spikes AND proportional lift. (upstream actions.py uses z-scores
  // across repeated trials; single-episode decode uses count thresholds.)
  const actions: Record<string, boolean> = {};
  for (const [g, idx] of outputs) {
    const rest = restCounts[g];                       // spikes over `warm` steps
    const stim = counts[g];                           // spikes over `steps` steps
    const restPerStep = rest / warm;
    const stimPerStep = stim / steps;
    actions[g] = stim > rest + MIN_EXTRA && stimPerStep > Z_MIN * restPerStep + 0.02;
  }

  return {
    id: req.id,
    fired_total: b.firedCount,
    ms: Date.now() - t0,
    group_counts: counts,
    rest_counts: restCounts,
    dn_trace: dnTrace,
    actions,
  };
}

function countIn(idx: Int32Array, firedSet: Set<number>): number {
  let n = 0;
  for (const i of idx) if (firedSet.has(i)) n++;
  return n;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const json = (d: any, status = 200) =>
      new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json" } });

    try {
      const b = await ensureBrain(env);
      const m = meta!;

      if (url.pathname === "/status") {
        return json({ n: b.n, nnz: b.w.nnz, params: b.p, load_ms: loadMs, sensory_input: m.sensoryInput });
      }
      if (url.pathname === "/episode" && req.method === "POST") {
        return json(runEpisode(b, m, await req.json() as EpisodeReq));
      }
      if (url.pathname === "/batch" && req.method === "POST") {
        const body = await req.json() as { episodes: EpisodeReq[] };
        return json((body.episodes ?? []).map((ep) => runEpisode(b, m, ep)));
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};
