/**
 * Colony git repo — isomorphic-git (MIT) over a D1-backed fs adapter.
 *
 * One `git_files` table holds the whole .git tree + worktree:
 *   repo/HEAD               → "ref: refs/heads/main"
 *   repo/refs/heads/main    → <sha>
 *   repo/index              → git index
 *   repo/objects/aa/bb...   → loose zlib objects (seeded from .git/objects)
 *   work/...                → worktree files
 * Served as a dumb-HTTP remote by git-http.ts (~15 LOC file server).
 */

import git from "isomorphic-git";

export interface GitEnv {
  DB: D1Database;
}

const GITDIR = "repo";
const DIR = "work";

/** Minimal fs.promises-style adapter over D1 — the only custom git glue. */
class D1FS {
  constructor(private db: D1Database) {}
  private k(p: string) { return p.replace(/^\/+|\/+$/g, ""); }

  async readFile(p: string, opts?: { encoding?: string } | string) {
    const row = await this.db.prepare("SELECT data FROM git_files WHERE path = ?").bind(this.k(p)).first();
    if (!row) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    // D1 returns BLOBs as base64 strings; ArrayBuffer in some contexts
    const d = row.data;
    const bytes: Uint8Array = d instanceof ArrayBuffer ? new Uint8Array(d)
      : typeof d === "string" ? Uint8Array.from(atob(d), (c) => c.charCodeAt(0))
      : new Uint8Array(d as Uint8Array);
    const enc = typeof opts === "string" ? opts : opts?.encoding;
    return enc === "utf8" ? new TextDecoder().decode(bytes) : bytes;
  }
  async writeFile(p: string, data: Uint8Array | string) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    await this.db.prepare("INSERT OR REPLACE INTO git_files (path, data) VALUES (?, ?)")
      .bind(this.k(p), bytes).run();
  }
  async mkdir() { /* flat KV — dirs implied by path prefixes */ }
  async readdir(p: string): Promise<string[]> {
    const prefix = this.k(p) + "/";
    const rows = await this.db.prepare(
      "SELECT path FROM git_files WHERE path >= ? AND path < ? || char(0x10FFFF)"
    ).bind(prefix, prefix).all();
    const seen = new Set<string>();
    for (const r of rows.results || []) {
      const rest = String(r.path).slice(prefix.length);
      if (rest) seen.add(rest.split("/")[0]);
    }
    return [...seen];
  }
  async stat(p: string) {
    const key = this.k(p);
    const row = await this.db.prepare("SELECT length(data) n FROM git_files WHERE path = ?").bind(key).first();
    if (row) {
      return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
               size: row.n as number, mtimeMs: 0, mode: 0o100644 };
    }
    const prefix = key + "/";
    const kids = await this.db.prepare(
      "SELECT 1 FROM git_files WHERE path >= ? AND path < ? || char(0x10FFFF) LIMIT 1"
    ).bind(prefix, prefix).first();
    if (kids || key === "") {
      return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false,
               size: 0, mtimeMs: 0, mode: 0o040000 };
    }
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  }
  async lstat(p: string) { return this.stat(p); }
  async unlink(p: string) { await this.db.prepare("DELETE FROM git_files WHERE path = ?").bind(this.k(p)).run(); }
  async rmdir(p: string) {
    const prefix = this.k(p) + "/";
    await this.db.prepare("DELETE FROM git_files WHERE path >= ? AND path < ? || char(0x10FFFF)")
      .bind(prefix, prefix).run();
  }
  async readlink() { throw new Error("readlink unsupported"); }
  async symlink() { throw new Error("symlink unsupported"); }
  async chmod() { /* noop */ }
}

function ctx(env: GitEnv) {
  const fs = new D1FS(env.DB);
  return { fs, dir: `/${DIR}`, gitdir: `/${GITDIR}` };
}

/** Upsert a blob into a (possibly nested) tree path — plumbing only,
 *  no index/worktree needed. Returns the new tree oid. */
async function putBlobInTree(
  g: { fs: never; gitdir: string },
  treeOid: string | null, segs: string[], blobOid: string,
): Promise<string> {
  type Ent = { mode: string; path: string; oid: string; type: "blob" | "tree" | "commit" };
  const { tree } = treeOid
    ? await git.readTree({ ...g, oid: treeOid })
    : { tree: [] as Ent[] };
  const [head, ...rest] = segs;
  const i = tree.findIndex((e) => e.path === head);
  if (rest.length === 0) {
    const ent: Ent = { mode: "100644", path: head, oid: blobOid, type: "blob" };
    if (i >= 0) tree[i] = ent; else tree.push(ent);
  } else {
    const sub = i >= 0 && tree[i].type === "tree" ? tree[i].oid : null;
    const newSub = await putBlobInTree(g, sub, rest, blobOid);
    const ent: Ent = { mode: "040000", path: head, oid: newSub, type: "tree" };
    if (i >= 0) tree[i] = ent; else tree.push(ent);
  }
  return git.writeTree({ ...g, tree: tree as never });
}

/** Commit a file change onto main — blob → trees → commit → ref. */
export async function commitFile(
  env: GitEnv,
  opts: { path: string; content: string; message: string; author: string },
): Promise<string> {
  const c = ctx(env);
  const g = { fs: c.fs as never, dir: c.dir, gitdir: c.gitdir };
  const head = await git.resolveRef({ ...g, ref: "main" }).catch(() => null);
  const blobOid = await git.writeBlob({ ...g, blob: new TextEncoder().encode(opts.content) });
  const baseTree = head
    ? (await git.readCommit({ ...g, oid: head })).commit.tree
    : null;
  const treeOid = await putBlobInTree(g, baseTree, opts.path.split("/"), blobOid);
  const commitOid = await git.writeCommit({
    ...g,
    commit: {
      tree: treeOid,
      parent: head ? [head] : [],
      author: { name: opts.author, email: `${opts.author}@colony.symbient`, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
      committer: { name: opts.author, email: `${opts.author}@colony.symbient`, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 },
      message: opts.message + "\n",
    },
  });
  await git.writeRef({ ...g, ref: "refs/heads/main", value: commitOid, force: true });
  return commitOid;
}

export async function readFile(env: GitEnv, path: string): Promise<string> {
  const c = ctx(env);
  const g = { fs: c.fs as never, dir: c.dir, gitdir: c.gitdir };
  const oid = await git.resolveRef({ ...g, ref: "main" }).catch(() => null);
  if (!oid) return "";
  try {
    const { blob } = await git.readBlob({ ...g, oid, filepath: path });
    return new TextDecoder().decode(blob);
  } catch {
    return "";
  }
}

/** All tracked file paths — the ideation repo map. Walks HEAD's tree
 *  (listFiles needs an index, which the D1 store doesn't keep). */
export async function listPaths(env: GitEnv): Promise<string[]> {
  const c = ctx(env);
  const g = { fs: c.fs as never, dir: c.dir, gitdir: c.gitdir };
  try {
    const head = await git.resolveRef({ ...g, ref: "main" });
    const { commit } = await git.readCommit({ ...g, oid: head });
    const out: string[] = [];
    const walk = async (oid: string, prefix: string): Promise<void> => {
      const { tree } = await git.readTree({ ...g, oid });
      for (const e of tree) {
        if (e.type === "tree") await walk(e.oid, `${prefix}${e.path}/`);
        else out.push(`${prefix}${e.path}`);
      }
    };
    await walk(commit.tree, "");
    return out;
  } catch (e) {
    throw new Error(`listPaths: ${e}`);
  }
}
