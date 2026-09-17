/**
 * Dumb-HTTP git remote — serves the D1 git_files store as a cloneable repo.
 * git falls back to dumb protocol when info/refs?service= returns 404, then
 * just GETs HEAD / refs / info/refs / objects/* as plain files.
 * Read-only; the colony writes via commitFile() (isomorphic-git) internally.
 */

import { type GitEnv } from "./git-store";

export async function handleGitHttp(request: Request, env: GitEnv): Promise<Response> {
  const url = new URL(request.url);
  // /repo.git/... → git_files key "repo/..."
  const key = "repo/" + url.pathname.replace(/^.*\/repo\.git\/?/, "");

  // Admin import — seed objects/refs. POST /repo.git/import?key=SECRET
  // Body: NDJSON lines {"path":"objects/ab/cdef","b64":"..."}
  if (url.pathname.endsWith("/repo.git/import") && request.method === "POST") {
    const secret = url.searchParams.get("key") || "";
    const expected = (env as unknown as { COLONY_ADMIN_KEY?: string }).COLONY_ADMIN_KEY;
    if (!expected || secret !== expected) return new Response("forbidden", { status: 403 });
    const text = await request.text();
    let n = 0;
    const stmts: D1PreparedStatement[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const { path, b64 } = JSON.parse(line) as { path: string; b64: string };
      if (!path || path.includes("..")) continue;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      stmts.push(env.DB.prepare("INSERT OR REPLACE INTO git_files (path, data) VALUES (?, ?)")
        .bind("repo/" + path.replace(/^repo\//, ""), bytes));
      n++;
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    return Response.json({ imported: n });
  }

  // info/refs — dumb-format listing, generated live from ref rows. Served
  // even for ?service= probes: a 200 with plain content-type makes git fall
  // back to the dumb protocol (a 404 is treated as "repo not found").
  if (key === "repo/info/refs") {
    const rows = await env.DB.prepare(
      "SELECT path, data FROM git_files WHERE path LIKE 'repo/refs/%'"
    ).all();
    const lines: string[] = [];
    for (const r of rows.results || []) {
      const d = r.data;
      const text = typeof d === "string" ? d
        : new TextDecoder().decode(d instanceof ArrayBuffer ? d : new Uint8Array(d as Uint8Array));
      lines.push(`${text.trim()}\t${String(r.path).slice(5)}`);
    }
    return new Response(lines.join("\n") + (lines.length ? "\n" : ""), {
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Objects are sha-addressed → immutable → edge-cache forever. A clone
  // costs ~830 D1 reads once; repeat clones/fetches hit the cache.
  const isObject = key.startsWith("repo/objects/") && !key.endsWith("/packs");
  if (isObject && request.method === "GET") {
    const hit = await caches.default.match(request);
    if (hit) return hit;
  }

  const row = await env.DB.prepare("SELECT data, typeof(data) t FROM git_files WHERE path = ?").bind(key).first();
  if (!row) return new Response("not found", { status: 404 });
  const d = row.data;
  const bytes = d instanceof ArrayBuffer ? d
    : typeof d === "string" ? Uint8Array.from(atob(d), (c) => c.charCodeAt(0)).buffer as ArrayBuffer
    : new Uint8Array(d as Uint8Array).buffer as ArrayBuffer;
  const res = new Response(bytes, {
    headers: { "Content-Type": "application/octet-stream" },
  });
  if (isObject && request.method === "GET") {
    res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    await caches.default.put(request, res.clone());
  }
  return res;
}
