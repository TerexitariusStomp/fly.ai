#!/usr/bin/env python3
"""Seed the colony's CF git repo (D1 git_files) with a baseline commit
containing the colony-scope source files (workers/, contracts/src/,
frontend/, migrations/, docs). Builds a temp git repo locally, then
uploads loose objects + refs via the worker's /repo.git/import endpoint.

Usage:
  COLONY_ADMIN_KEY=... python3 scripts/seed_colony_repo.py \
      https://governance-worker.symbient.workers.dev
"""
import base64, json, os, re, subprocess, sys, tempfile
import urllib.request

SCOPE = re.compile(r"^(workers/|contracts/src/|frontend/|migrations/|AGENTS\.md|README\.md)")
DENY = re.compile(r"\.env|secret|node_modules|\.git/|package-lock|pnpm-lock|"
                  r"\.(png|jpe?g|gif|ico|webp|so|wasm|whl|npz|mp4|woff2?|ttf|otf)$", re.I)
MAX_FILE = 300_000  # colony edits source, not binaries — keep D1 rows small
WORKER = sys.argv[1] if len(sys.argv) > 1 else "https://governance-worker.symbient.workers.dev"
KEY = os.environ["COLONY_ADMIN_KEY"]
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    files = subprocess.check_output(
        ["git", "-C", REPO, "ls-files"], text=True
    ).splitlines()
    files = [f for f in files if SCOPE.match(f) and not DENY.search(f)
             and os.path.isfile(os.path.join(REPO, f))
             and os.path.getsize(os.path.join(REPO, f)) <= MAX_FILE]
    print(f"{len(files)} colony-scope files")

    with tempfile.TemporaryDirectory() as tmp:
        for f in files:
            src = os.path.join(REPO, f)
            if not os.path.isfile(src):
                continue
            dst = os.path.join(tmp, f)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(src, "rb") as a, open(dst, "wb") as b:
                b.write(a.read())
        env = {**os.environ, "GIT_AUTHOR_NAME": "flyai-colony",
               "GIT_AUTHOR_EMAIL": "colony@fly.ai",
               "GIT_COMMITTER_NAME": "flyai-colony",
               "GIT_COMMITTER_EMAIL": "colony@fly.ai"}
        subprocess.run(["git", "-C", tmp, "init", "-b", "main"], check=True, env=env)
        subprocess.run(["git", "-C", tmp, "add", "-A"], check=True, env=env)
        subprocess.run(["git", "-C", tmp, "commit", "-m",
                        "colony baseline — source mirror of rad:z2kY22UBjvyrbxfKZftjF4H66C7Wx"],
                       check=True, env=env)

        # emit every loose object + ref + HEAD as NDJSON
        lines = []
        objdir = os.path.join(tmp, ".git", "objects")
        for root, _, names in os.walk(objdir):
            for name in names:
                p = os.path.join(root, name)
                rel = os.path.relpath(p, os.path.join(tmp, ".git"))
                with open(p, "rb") as fh:
                    lines.append({"path": rel, "b64": base64.b64encode(fh.read()).decode()})
        for rel in ("HEAD", "refs/heads/main"):
            p = os.path.join(tmp, ".git", rel)
            with open(p, "rb") as fh:
                lines.append({"path": rel, "b64": base64.b64encode(fh.read()).decode()})
        head = subprocess.check_output(["git", "-C", tmp, "rev-parse", "HEAD"], text=True).strip()
        print(f"baseline commit {head} — {len(lines)} objects")

    # upload in batches of 200 — split further on 5xx/413 (large blobs)
    BATCH = 200
    i = 0
    while i < len(lines):
        batch = "\n".join(json.dumps(l) for l in lines[i:i + BATCH])
        req = urllib.request.Request(
            f"{WORKER}/repo.git/import?key={KEY}",
            data=batch.encode(), method="POST",
            headers={"User-Agent": "colony-seed/1.0"})
        try:
            with urllib.request.urlopen(req) as r:
                print(f"batch {i//BATCH}: {r.read().decode()}")
                i += BATCH
        except Exception as e:
            if BATCH > 10:
                BATCH //= 2
                print(f"batch failed ({e}) — retrying with {BATCH}")
            else:
                raise


if __name__ == "__main__":
    main()
