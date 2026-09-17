/**
 * D1 circuit-breaker wrapper for Cloudflare Workers (free tier).
 *
 * Wraps a D1Database so every write (INSERT/UPDATE/DELETE/REPLACE) is
 * guarded by an in-memory breaker. On the first "exceeded limit" error
 * the breaker trips for the current UTC day and all subsequent writes
 * short-circuit in memory — no further D1 calls, so a failure can't
 * feedback-loop. Reads are never gated. The breaker self-heals at UTC
 * midnight (date comparison, no timer).
 *
 * Skipped writes return a synthetic success so callers continue; a
 * skipped `paper_trades` insert just means that trade isn't recorded.
 */
type D1Result = { success: boolean; meta?: any; results?: any[] };
type D1Stmt = {
  bind: (...vals: any[]) => D1Stmt;
  run: () => Promise<D1Result>;
  first: <T = any>() => Promise<T | null>;
  all: <T = any>() => Promise<{ results: T[] }>;
};

const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i;
const LIMIT_RE = /exceeded|limit/i;

let d1DeadDay: number | null = null;

function d1Writable(): boolean {
  const today = Math.floor(Date.now() / 86_400_000);
  if (d1DeadDay === today) return false;
  if (d1DeadDay !== null) d1DeadDay = null;
  return true;
}

function guardStmt(stmt: D1Stmt, sql: string): D1Stmt {
  const isWrite = WRITE_RE.test(sql);
  return new Proxy(stmt, {
    get(target, prop, receiver) {
      if (prop === "run") {
        return async (...args: any[]): Promise<D1Result> => {
          if (isWrite && !d1Writable()) return { success: true, meta: { changes: 0 } };
          try {
            return await target.run(...args);
          } catch (e: any) {
            if (isWrite && LIMIT_RE.test(String(e))) {
              d1DeadDay = Math.floor(Date.now() / 86_400_000);
              console.error("D1 write limit hit — writes disabled until UTC midnight");
              return { success: true, meta: { changes: 0 } };
            }
            throw e;
          }
        };
      }
      if (prop === "first" || prop === "all") {
        // Reads are never gated
        return (...args: any[]) => (target as any)[prop](...args);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as D1Stmt;
}

export function safeDb(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string): D1Stmt => guardStmt(db.prepare(sql) as unknown as D1Stmt, sql);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as D1Database;
}
