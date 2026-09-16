"""Generate 7 connectome NPZ artifacts for paper trading.

Produces weights.npz (CSR sparse matrix) and brain.npz (metadata) for each
of the 7 governing connectomes.
use biologically-inspired synthetic networks with appropriate structure.

Output: /home/terex/fly-data/connectomes/<id>/{weights.npz,brain.npz}
"""
import os
import numpy as np
from scipy import sparse
from pathlib import Path

OUT = Path("/home/terex/fly-data/connectomes")
OUT.mkdir(parents=True, exist_ok=True)

# 7 governing connectomes (quorum: 3 of 7 on-chain)
CONNECTOMES = [
    # (id, species, n_neurons, description)
    ("drosophila",    "D. melanogaster", 49,    "Drosophila subnetwork (49 neurons)"),
    ("rat",           "R. norvegicus",   73,    "Rat subnetwork (73 neurons)"),
    ("mouse",         "M. musculus",     112,   "Mouse subnetwork (112 neurons)"),
    ("ciona",         "C. intestinalis", 205,   "Ciona connectome (Ryan et al. 2016)"),
    ("macaque_modha", "M. mulatta",      242,   "Macaque Modha & Singh (242 neurons)"),
    ("human",         "H. sapiens",      234,   "Human subnetwork (234 neurons)"),
    ("celegans_male", "C. elegans",      575,   "C. elegans male (Cook et al. 2019)"),
]


def generate_small_world(n, k=10, p=0.1, seed=42):
    """Generate a small-world connectivity matrix (Watts-Strogatz style)."""
    rng = np.random.default_rng(seed)
    rows, cols = [], []
    # Ring lattice
    for i in range(n):
        for j in range(1, k // 2 + 1):
            rows.extend([i, i])
            cols.extend([(i + j) % n, (i - j) % n])
    # Rewire
    edges = list(zip(rows, cols))
    for idx in range(len(edges)):
        if rng.random() < p:
            i, _ = edges[idx]
            j = rng.integers(0, n)
            if j != i:
                edges[idx] = (i, j)
    rows = np.array([e[0] for e in edges], dtype=np.int32)
    cols = np.array([e[1] for e in edges], dtype=np.int32)
    # Weights: log-normal, sign from excitatory/inhibitory (80/20)
    weights = np.abs(rng.lognormal(0, 0.5, len(rows))).astype(np.float32)
    inhibitory = rng.random(len(rows)) < 0.2
    weights[inhibitory] *= -1
    W = sparse.csr_matrix((weights, (rows, cols)), shape=(n, n))
    W.sum_duplicates()
    W.data = W.data / np.abs(W.data).max()  # normalize to [-1, 1]
    return W


def generate_scale_free(n, m=5, seed=42):
    """Generate a scale-free connectivity matrix (Barabasi-Albert style)."""
    rng = np.random.default_rng(seed)
    # Preferential attachment
    degrees = np.zeros(n, dtype=np.int32)
    rows, cols = [], []
    for i in range(m, n):
        targets = rng.choice(i, size=min(m, i), replace=False,
                             p=degrees[:i] / max(degrees[:i].sum(), 1) if degrees[:i].sum() > 0 else None)
        for t in targets:
            rows.extend([i, t])
            cols.extend([t, i])
            degrees[i] += 1
            degrees[t] += 1
    rows = np.array(rows, dtype=np.int32)
    cols = np.array(cols, dtype=np.int32)
    weights = np.abs(rng.lognormal(0, 0.5, len(rows))).astype(np.float32)
    inhibitory = rng.random(len(rows)) < 0.2
    weights[inhibitory] *= -1
    W = sparse.csr_matrix((weights, (rows, cols)), shape=(n, n))
    W.sum_duplicates()
    W.data = W.data / np.abs(W.data).max()
    return W


def generate_metadata(n, species, seed=42):
    """Generate brain.npz metadata for a synthetic connectome."""
    rng = np.random.default_rng(seed)
    # Cell types: sensory, interneuron, motor, modulatory
    cell_types = np.array([
        rng.choice(["sensory", "interneuron", "motor", "modulatory", "descending_neuron"],
                   p=[0.15, 0.55, 0.15, 0.05, 0.10])
        for _ in range(n)
    ], dtype=object)
    # Superclass
    superclass = np.array([
        {"sensory": "sensory", "interneuron": "interneuron", "motor": "motor",
         "modulatory": "modulatory", "descending_neuron": "descending"}[c]
        for c in cell_types
    ], dtype=object)
    # Side (L/R)
    side = rng.choice(["L", "R", "center"], p=[0.4, 0.4, 0.2], size=n).astype(str)
    # Visual neurons (subset of sensory)
    visual = np.where(cell_types == "sensory")[0][:min(n // 10, 1000)].astype(np.int32)
    azimuth = rng.uniform(-180, 180, len(visual)).astype(np.float32)
    # Positions (3D)
    positions = rng.normal(0, 100, (n, 3)).astype(np.float32)
    # Neuron groups for motor readouts
    motor_idx = np.where(cell_types == "motor")[0]
    desc_idx = np.where(cell_types == "descending_neuron")[0]

    def pick_group(arr, count=2):
        if len(arr) >= count:
            return rng.choice(arr, count, replace=False).astype(np.int32)
        return arr.astype(np.int32)

    metadata = {
        "ids": np.arange(n, dtype=np.int64),
        "visual": visual,
        "azimuth": azimuth,
        "cell_type": np.array([str(c) for c in cell_types], dtype="U47"),
        "side": np.array([str(s) for s in side], dtype="U7"),
        "positions": positions,
        "superclass": np.array([str(s) for s in superclass], dtype="U21"),
    }
    # Motor groups (BUY/SELL/HOLD)
    if len(motor_idx) >= 6:
        metadata["group_forward_L"] = pick_group(motor_idx, 2)
        metadata["group_forward_R"] = pick_group(motor_idx, 2)
        metadata["group_escape_L"] = pick_group(motor_idx, 2)
        metadata["group_escape_R"] = pick_group(motor_idx, 2)
        metadata["group_backward_L"] = pick_group(motor_idx, 2)
        metadata["group_backward_R"] = pick_group(motor_idx, 2)
    elif len(desc_idx) >= 6:
        metadata["group_forward_L"] = pick_group(desc_idx, 2)
        metadata["group_forward_R"] = pick_group(desc_idx, 2)
        metadata["group_escape_L"] = pick_group(desc_idx, 2)
        metadata["group_escape_R"] = pick_group(desc_idx, 2)
        metadata["group_backward_L"] = pick_group(desc_idx, 2)
        metadata["group_backward_R"] = pick_group(desc_idx, 2)
    else:
        # Fallback: use random neurons
        rand_idx = rng.choice(n, min(12, n), replace=False).astype(np.int32)
        metadata["group_forward_L"] = rand_idx[0:2] if len(rand_idx) >= 2 else rand_idx
        metadata["group_forward_R"] = rand_idx[2:4] if len(rand_idx) >= 4 else rand_idx
        metadata["group_escape_L"] = rand_idx[4:6] if len(rand_idx) >= 6 else rand_idx
        metadata["group_escape_R"] = rand_idx[6:8] if len(rand_idx) >= 8 else rand_idx
        metadata["group_backward_L"] = rand_idx[8:10] if len(rand_idx) >= 10 else rand_idx
        metadata["group_backward_R"] = rand_idx[10:12] if len(rand_idx) >= 12 else rand_idx

    return metadata


def save_connectome(cid, species, n, desc, seed=42):
    """Generate and save a connectome."""
    out_dir = OUT / cid
    out_dir.mkdir(parents=True, exist_ok=True)

    weights_path = out_dir / "weights.npz"
    brain_path = out_dir / "brain.npz"

    if weights_path.exists() and brain_path.exists():
        print(f"  {cid}: already exists, skipping")
        return

    print(f"  {cid}: generating {n} neurons...")

    # Generate synthetic connectome
    # Use small-world for smaller brains, scale-free for larger ones
    if n <= 5000:
        W = generate_small_world(n, k=10, p=0.15, seed=seed)
    else:
        W = generate_scale_free(n, m=5, seed=seed)

    # Save weights as CSR
    sparse.save_npz(str(weights_path), W)

    # Generate and save metadata
    metadata = generate_metadata(n, species, seed=seed)
    np.savez(str(brain_path), **metadata)

    print(f"  {cid}: {W.nnz} synapses, saved")


def main():
    print("Generating 7 connectomes for paper trading...")
    for i, (cid, species, n, desc) in enumerate(CONNECTOMES):
        seed = hash(cid) % (2**32)
        save_connectome(cid, species, n, desc, seed=seed)

    print("\nDone! Connectomes saved to:", OUT)
    # Print summary
    for cid, species, n, desc in CONNECTOMES:
        wpath = OUT / cid / "weights.npz"
        if wpath.exists():
            W = sparse.load_npz(str(wpath))
            print(f"  {cid:15s} {n:7d} neurons, {W.nnz:10d} synapses")


if __name__ == "__main__":
    main()
