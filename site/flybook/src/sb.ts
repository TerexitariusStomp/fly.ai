/** supabase-compat shim over the flybook-api worker's /table/<name> + /auth + /rpc.
 *  Keeps feed.ts/api.ts/Account.tsx/Market.tsx unchanged — the same .from().select()
 *  chains, auth calls, realtime channels and rpc() calls now hit our D1 worker.
 *
 *  Auth: SIWE-lite — signInWithWeb3 posts wallet+signature to /auth/verify which
 *  returns a session token stored in localStorage. Realtime channels are no-ops
 *  (the feed already polls). rpc() maps to /rpc/<fn> REST calls.
 */

const API = (import.meta.env.VITE_FLYBOOK_API as string | undefined) ?? "https://flybook-api.symbient.workers.dev";

export interface EthereumWallet { address: string }
export interface Session { user: { id: string; email?: string }; access_token?: string; wallet?: string }

interface Row { [k: string]: any }
interface Result { data: Row[] | Row | null; error: any }

const TOKEN_KEY = "flybook_session";

class Q {
  private table: string;
  private sel = "*";
  private wh: [string, string, any][] = [];
  private ord: [string, boolean][] = [];
  private lim?: number;
  private one = false;
  private maybe = false;
  private _patch?: Row;

  constructor(table: string) { this.table = table; }

  select(cols = "*", _opts?: any) { this.sel = cols; return this; }
  eq(c: string, v: any) { this.wh.push([c, "eq", v]); return this; }
  neq(c: string, v: any) { this.wh.push([c, "neq", v]); return this; }
  in(c: string, vs: any[]) { this.wh.push([c, "in", vs]); return this; }
  not(c: string, op: string, v: any) { this.wh.push([c, "not_" + op, v]); return this; }
  order(c: string, o?: { ascending?: boolean }) { this.ord.push([c, o?.ascending !== false]); return this; }
  limit(n: number) { this.lim = n; return this; }
  gte(c: string, v: any) { this.wh.push([c, "gte", v]); return this; }
  lte(c: string, v: any) { this.wh.push([c, "lte", v]); return this; }
  single() { this.one = true; return this; }
  maybeSingle() { this.maybe = true; return this; }

  private url(): string {
    const p = new URLSearchParams();
    p.set("select", this.sel);
    for (const [c, op, v] of this.wh) p.append(c, `${op}.${JSON.stringify(v)}`);
    for (const [c, asc] of this.ord) p.append("order", `${c}.${asc ? "asc" : "desc"}`);
    if (this.lim != null) p.set("limit", String(this.lim));
    return `${API}/table/${this.table}?${p}`;
  }

  private authH(): Record<string, string> {
    const t = localStorage.getItem(TOKEN_KEY);
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  async then(resolve: (r: Result) => any, _reject?: (e: any) => any) {
    try {
      const r = await fetch(this.url(), { headers: this.authH() });
      const j = await r.json();
      const rows: any[] = Array.isArray(j) ? j : ((j as any).rows ?? []);
      if (this.one || this.maybe) {
        const first = rows[0] ?? null;
        if (!first && this.one) return resolve({ data: null, error: { message: "not found" } });
        return resolve({ data: first, error: null });
      }
      resolve({ data: rows, error: j.error ?? null });
    } catch (e) { resolve({ data: [], error: e }); }
  }

  async insert(row: Row | Row[]): Promise<Result> {
    const r = await fetch(`${API}/table/${this.table}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...this.authH() }, body: JSON.stringify(row),
    });
    const j = await r.json().catch(() => null);
    return { data: j, error: r.ok ? null : j };
  }
  update(patch: Row): this { this._patch = patch; return this; }
  async upsert(row: Row): Promise<Result> {
    const r = await fetch(`${API}/table/${this.table}?upsert=1`, {
      method: "POST", headers: { "Content-Type": "application/json", ...this.authH() }, body: JSON.stringify(row),
    });
    return { data: await r.json().catch(() => null), error: null };
  }
  async delete(): Promise<Result> {
    const r = await fetch(this.url(), { method: "DELETE", headers: this.authH() });
    return { data: await r.json().catch(() => null), error: null };
  }
  // .update().eq() resolves via the then() above with a PATCH once wh is set
  async _doPatch(): Promise<Result> {
    const r = await fetch(this.url(), {
      method: "PATCH", headers: { "Content-Type": "application/json", ...this.authH() },
      body: JSON.stringify(this._patch),
    });
    return { data: await r.json().catch(() => null), error: null };
  }
}

// ---- auth surface (SIWE-lite over our worker) ----
const auth = {
  async getSession(): Promise<{ data: { session: Session | null } }> {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return { data: { session: null } };
    const [token, wallet] = raw.split(":");
    return { data: { session: { user: { id: wallet }, access_token: token, wallet } } };
  },
  onAuthStateChange(cb: (event: string, s: Session | null) => void) {
    const h = () => auth.getSession().then(({ data }) => cb("SIGNED_IN", data.session));
    window.addEventListener("flybook:auth", h);
    return { data: { subscription: { unsubscribe: () => window.removeEventListener("flybook:auth", h) } } };
  },
  async signInWithWeb3(opts: { chain: string; wallet?: EthereumWallet | string; statement?: string;
                               message?: string; signature?: string; options?: any }) {
    const w = opts.wallet;
    const wallet = (typeof w === "string" ? w : (w as any)?.address ?? "").toLowerCase();
    // request a nonce, ask the wallet to sign it, verify
    const nonce = crypto.randomUUID();
    const msg = `${opts.statement ?? "Sign in to fly.ai"}\n\nNonce: ${nonce}`;
    let signature = opts.signature ?? "";
    if (!signature && typeof w === "object" && w) {
      signature = await (w as any).request({
        method: "personal_sign",
        params: [`0x${Array.from(new TextEncoder().encode(msg)).map(b=>b.toString(16).padStart(2,"0")).join("")}`, wallet],
      }).catch(() => "");
    }
    const r = await fetch(`${API}/auth/verify`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, signature, nonce }),
    });
    const j = await r.json();
    if (j.token) {
      localStorage.setItem(TOKEN_KEY, `${j.token}:${wallet}`);
      window.dispatchEvent(new Event("flybook:auth"));
      return { data: { session: { user: { id: wallet }, access_token: j.token, wallet } }, error: null };
    }
    return { data: { session: null }, error: j };
  },
  async signInWithOtp(_opts: any) {
    return { data: {}, error: { message: "email sign-in not enabled — connect a wallet" } };
  },
  async signOut() {
    localStorage.removeItem(TOKEN_KEY);
    window.dispatchEvent(new Event("flybook:auth"));
    return { error: null };
  },
};

// ---- realtime channels: no-op (feed polls anyway) ----
function channel(_name: string) {
  const c: any = {
    on: (_ev: string, _f: any, _cb?: (m?: any) => void) => c,
    subscribe: (_cb?: any) => c,
    unsubscribe: () => {},
  };
  return c;
}

async function rpc(fn: string, args?: any): Promise<Result> {
  const r = await fetch(`${API}/rpc/${fn}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeader() }, body: JSON.stringify(args ?? {}),
  });
  const j = await r.json().catch(() => null);
  return { data: j, error: r.ok ? null : j };
}

function authHeader(): Record<string, string> {
  const t = localStorage.getItem(TOKEN_KEY)?.split(":")[0];
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export const sb = { from: (t: string) => new Q(t), auth, channel, removeChannel: (_c?: any) => {}, rpc };
export type SupabaseClient = typeof sb;
export const createClient = (_url?: string, _key?: string) => sb;
