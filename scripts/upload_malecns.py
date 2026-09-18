#!/usr/bin/env python3
"""Upload the full MaleCNS brain (FLYW format) to D1 for brain-worker.

Chunks the decompressed weights.bin + meta.bin into D1 `weight_chunks` —
same pattern as pack_connectomes.py's chunked upload.

Usage: python3 scripts/upload_malecns.py [--local]
"""
import base64
import os
import sqlite3
import sys
import subprocess
import tempfile

DB = "sym-protocol"
BRAIN = "malecns"
CHUNK = 400_000  # bytes per D1 row — under the 1MB statement limit w/ base64 overhead

FILES = {
    f"{BRAIN}/weights.bin": "/tmp/malecns_weights.bin",
    f"{BRAIN}/meta.bin": "/tmp/malecns_meta.bin",
    f"{BRAIN}/brain.json": "/tmp/malecns_brain.json",
}

def upload(path_key: str, file_path: str):
    data = open(file_path, "rb").read()
    print(f"  {path_key}: {len(data)/1e6:.1f} MB → {len(data)//CHUNK + 1} chunks")
    # write chunks to a temp sqlite-friendly SQL file, then pipe to wrangler
    stmts = [f"DELETE FROM weights WHERE path = '{path_key}';",
             f"DELETE FROM weight_chunks WHERE path = '{path_key}';"]
    for i in range(0, len(data), CHUNK):
        seq = i // CHUNK
        b64 = base64.b64encode(data[i:i+CHUNK]).decode()
        stmts.append(f"INSERT INTO weight_chunks (path, seq, data_b64) VALUES ('{path_key}', {seq}, '{b64}');")
    sql = "\n".join(stmts)
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as f:
        f.write(sql)
        tmp = f.name
    r = subprocess.run(
        ["wrangler", "d1", "execute", DB, "--remote", "--file", tmp],
        capture_output=True, text=True, cwd=os.path.expanduser("~/CascadeProjects/shit-token/workers/api-worker"),
        env={**os.environ, "WRANGLER_CONFIG_PATH": os.path.expanduser("~/.wrangler/config/default.toml")},
    )
    os.unlink(tmp)
    if r.returncode != 0:
        print("  FAILED:", r.stderr[-300:])
        sys.exit(1)
    print("  done")

for key, fp in FILES.items():
    if not os.path.exists(fp):
        print(f"missing {fp} — run the export first")
        continue
    upload(key, fp)
print("all uploaded")
