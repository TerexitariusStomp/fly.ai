#!/usr/bin/env python3
"""Pack connectome NPZ files into int4/uint16 CSR format for SSTORE2 deployment.

Based on alextitonis/fly.ai FlyBrain (MIT) CSR format:
  indptr (delta-encoded), indices (uint16), data (int4 quantized)

Output: binary chunks ready for SSTORE2.write() deployment.
"""
import numpy as np
import os
import json
import struct
import sys

CONNECTOMES_DIR = os.path.expanduser("~/fly-data/connectomes")
OUTPUT_DIR = os.path.expanduser("~/fly-data/packed")
CHUNK_SIZE = 24575  # EIP-170 max code size minus SSTORE2 overhead (STOP byte)

# 7 connectomes governing the protocol (one-third quorum = 3 of 7)
CONNECTOMES = [
    "drosophila", "rat", "mouse", "ciona",
    "macaque_modha", "human", "celegans_male",
]

def quantize_int4(data):
    """Quantize float32 weights to int4 (-8..7)."""
    scale = np.abs(data).max() / 7.0
    quantized = np.clip(np.round(data / scale), -8, 7).astype(np.int8)
    return quantized, scale

def pack_int4(weights):
    """Pack int8 array (values -8..7) into bytes, 2 per byte."""
    packed = np.zeros((len(weights) + 1) // 2, dtype=np.uint8)
    for i, w in enumerate(weights):
        val = int(w) & 0x0F
        if i % 2 == 0:
            packed[i // 2] |= val << 4  # high nibble
        else:
            packed[i // 2] |= val       # low nibble
    return packed.tobytes()

def pack_connectome(name):
    """Pack a single connectome from NPZ to binary CSR format."""
    wpath = os.path.join(CONNECTOMES_DIR, name, "weights.npz")
    if not os.path.exists(wpath):
        print(f"  SKIP {name}: no weights.npz")
        return None

    w = np.load(wpath, allow_pickle=True)
    indptr = w["indptr"].astype(np.uint32)
    indices = w["indices"].astype(np.uint16)
    data = w["data"].astype(np.float32)
    n_neurons = int(w["shape"][0])
    n_synapses = len(data)

    # Quantize weights to int4
    quantized, scale = quantize_int4(data)
    packed_weights = pack_int4(quantized)

    # Delta-encode indptr
    deltas = np.diff(indptr).astype(np.uint32)
    max_delta = deltas.max()
    if max_delta < 256:
        indptr_width = 1
        packed_indptr = deltas.astype(np.uint8).tobytes()
    else:
        indptr_width = 2
        # Big-endian uint16 for EVM
        packed_indptr = struct.pack('>' + 'H' * len(deltas), *deltas.tolist())

    # Pack indices as big-endian uint16 (EVM reads big-endian)
    packed_indices = struct.pack('>' + 'H' * len(indices), *indices.tolist())

    # Build data blob: [indptr][indices][weights]
    indptr_offset = 0
    indices_offset = len(packed_indptr)
    weights_offset = indices_offset + len(packed_indices)
    total_size = weights_offset + len(packed_weights)

    blob = packed_indptr + packed_indices + packed_weights

    # Split into SSTORE2 chunks
    chunks = []
    for i in range(0, len(blob), CHUNK_SIZE):
        chunk = blob[i:i + CHUNK_SIZE]
        chunks.append(chunk)

    # Determine simulation steps — reduce to fit within block gas limit (~30M)
    # 10 steps = ~41M gas for celegans, so use 5 steps for small, 2 for large
    if n_neurons <= 1000:
        n_steps = 5   # ~20M gas
    elif n_neurons <= 10000:
        n_steps = 3   # ~15M gas
    else:
        n_steps = 2   # ~10M gas

    result = {
        "name": name,
        "nNeurons": n_neurons,
        "nSynapses": n_synapses,
        "nSteps": n_steps,
        "indptrWidth": indptr_width,
        "indptrOffset": indptr_offset,
        "indicesOffset": indices_offset,
        "weightsOffset": weights_offset,
        "weightScale": float(scale),
        "totalSize": total_size,
        "nChunks": len(chunks),
    }

    # Save chunks
    conn_dir = os.path.join(OUTPUT_DIR, name)
    os.makedirs(conn_dir, exist_ok=True)
    for i, chunk in enumerate(chunks):
        with open(os.path.join(conn_dir, f"chunk_{i:03d}.bin"), "wb") as f:
            f.write(chunk)

    # Save metadata
    with open(os.path.join(conn_dir, "metadata.json"), "w") as f:
        json.dump(result, f, indent=2)

    print(f"  {name}: {n_neurons} neurons, {n_synapses} synapses, "
          f"{n_steps} steps, {len(chunks)} chunks, {total_size} bytes, "
          f"indptr_width={indptr_width}")
    return result

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    print("Packing 7 connectomes for SSTORE2 deployment...")
    print(f"  Input: {CONNECTOMES_DIR}")
    print(f"  Output: {OUTPUT_DIR}")
    print()

    all_metadata = {}
    for name in CONNECTOMES:
        result = pack_connectome(name)
        if result:
            all_metadata[name] = result

    # Save combined metadata
    with open(os.path.join(OUTPUT_DIR, "all_connectomes.json"), "w") as f:
        json.dump(all_metadata, f, indent=2)

    print()
    print(f"Packed {len(all_metadata)} connectomes")
    total_bytes = sum(m["totalSize"] for m in all_metadata.values())
    total_chunks = sum(m["nChunks"] for m in all_metadata.values())
    print(f"Total: {total_bytes} bytes in {total_chunks} chunks")

if __name__ == "__main__":
    main()
