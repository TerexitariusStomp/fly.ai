#!/usr/bin/env python3
"""Deploy SSTORE2 chunks for 7 connectomes and register them in FlyEngine.

Uses already-deployed FlyEngine proxy on Arc testnet.
"""
import json
import os
import sys
import time
from web3 import Web3
from eth_account import Account

RPC_URL = "https://rpc.testnet.arc.io"
CHAIN_ID = 5042002
PACKED_DIR = os.path.expanduser("~/fly-data/packed")

# Already deployed
FLY_ENGINE = "0x3858ce51c8b0AEeC27E7042A4B104A69bAFB8eec"
GOVERNOR = "0x02102F5313a17Bae8d0e8E6278D8690a0cF2e07e"

# Load private key from deploy script
deploy_script = os.path.join(os.path.dirname(__file__), "deploy-arc.sh")
PRIVATE_KEY = None
with open(deploy_script) as f:
    for line in f:
        if line.startswith("export PRIVATE_KEY="):
            PRIVATE_KEY = line.split("=", 1)[1].strip().strip('"')
            break

if not PRIVATE_KEY:
    print("ERROR: PRIVATE_KEY not found")
    sys.exit(1)

w3 = Web3(Web3.HTTPProvider(RPC_URL))
account = Account.from_key(PRIVATE_KEY)
deployer = account.address

print(f"Connected to {RPC_URL} (chain ID: {w3.eth.chain_id})")
print(f"Deployer: {deployer}")
print(f"FlyEngine: {FLY_ENGINE}")
print(f"Governor: {GOVERNOR}")

# Load FlyEngine ABI
def load_abi(name):
    out_dir = os.path.join(os.path.dirname(__file__), "..", "out")
    for root, dirs, files in os.walk(out_dir):
        path = os.path.join(root, f"{name}.json")
        if os.path.exists(path):
            with open(path) as f:
                return json.load(f)["abi"]
    print(f"ERROR: {name}.json not found")
    sys.exit(1)

fly_abi = load_abi("FlyEngine")
fly_engine = w3.eth.contract(address=w3.to_checksum_address(FLY_ENGINE), abi=fly_abi)
gov_abi = load_abi("ConnectomeGovernor")
governor = w3.eth.contract(address=w3.to_checksum_address(GOVERNOR), abi=gov_abi)

def sstore2_write(data):
    """Deploy SSTORE2 storage contract using the correct init code pattern.
    
    SSTORE2 init code: PUSH2 len+1, DUP1, PUSH1 0x0a, RETURNDATASIZE, CODECOPY, 
    RETURNDATASIZE, RETURN, STOP — then data follows.
    The runtime code is STOP (0x00) + data.
    """
    n = len(data)
    # PUSH2 pushes n+1 (data length + 1 for STOP byte)
    init_code = (
        b"\x61" + (n + 1).to_bytes(2, "big") +  # PUSH2 len+1
        b"\x80" +                              # DUP1
        b"\x60\x0a" +                          # PUSH1 0x0a
        b"\x3d" +                              # RETURNDATASIZE
        b"\x39" +                              # CODECOPY
        b"\x3d" +                              # RETURNDATASIZE
        b"\xf3" +                              # RETURN
        b"\x00" +                              # STOP
        data                                    # the actual data
    )
    # Estimate gas: ~200 gas per byte for init code + overhead
    gas = max(5_000_000, 500_000 + len(data) * 300)
    tx = {
        "from": account.address,
        "data": "0x" + init_code.hex(),
        "nonce": w3.eth.get_transaction_count(account.address),
        "gas": gas,
        "gasPrice": w3.eth.gas_price,
        "chainId": w3.eth.chain_id,
    }
    signed = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
    if receipt.status != 1:
        print(f"ERROR: SSTORE2 write failed")
        sys.exit(1)
    return receipt.contractAddress

def send_tx(to, data, gas=2_000_000):
    tx = {
        "from": account.address,
        "to": to,
        "data": data,
        "nonce": w3.eth.get_transaction_count(account.address),
        "gas": gas,
        "gasPrice": w3.eth.gas_price,
        "chainId": w3.eth.chain_id,
    }
    signed = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    return w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)

# Load metadata
with open(os.path.join(PACKED_DIR, "all_connectomes.json")) as f:
    all_meta = json.load(f)

# Deploy each connectome
deployed = {}
for name, meta in all_meta.items():
    print(f"\n--- {name} ({meta['nNeurons']} neurons, {meta['nSynapses']} synapses, {meta['nChunks']} chunks) ---")

    # Check if already registered (but old chunks may be bad — re-deploy)
    connectome_id = w3.keccak(text=name)
    # Always re-deploy chunks to ensure correct SSTORE2 format
    print(f"  Deploying {meta['nChunks']} chunks...")

    # Deploy SSTORE2 chunks
    chunk_addrs = []
    for i in range(meta["nChunks"]):
        chunk_path = os.path.join(PACKED_DIR, name, f"chunk_{i:03d}.bin")
        with open(chunk_path, "rb") as f:
            chunk_data = f.read()
        addr = sstore2_write(chunk_data)
        chunk_addrs.append(addr)
        print(f"  chunk {i}: {addr} ({len(chunk_data)} bytes)")

    # Register connectome
    conn_data = (
        meta["nNeurons"],
        meta["nSynapses"],
        meta["nSteps"],
        meta["indptrWidth"],
        meta["indptrOffset"],
        meta["indicesOffset"],
        meta["weightsOffset"],
        chunk_addrs,
    )
    tx_data = fly_engine.encode_abi("registerConnectome", [connectome_id, conn_data])
    gas_limit = max(500000, 200000 + len(chunk_addrs) * 30000)
    receipt = send_tx(FLY_ENGINE, tx_data, gas=gas_limit)
    if receipt.status == 1:
        print(f"  Registered in FlyEngine: {connectome_id.hex()}")
        # Also register in the ConnectomeGovernor (bound voter = deployer EOA
        # unless CONNECTOME_VOTER_<NAME> is set)
        voter = os.environ.get(f"CONNECTOME_VOTER_{name.upper()}", account.address)
        gov_data = governor.encode_abi("addConnectome", [connectome_id, w3.to_checksum_address(voter)])
        gov_receipt = send_tx(GOVERNOR, gov_data, gas=200000)
        if gov_receipt.status == 1:
            print(f"  Registered in Governor (voter={voter})")
        else:
            print(f"  ERROR: governor registration failed")
        deployed[name] = {
            "connectomeId": connectome_id.hex(),
            "voter": voter,
            "chunks": chunk_addrs,
        }
    else:
        print(f"  ERROR: Registration failed")
    time.sleep(1)

# Save deployment info
out_path = os.path.join(os.path.dirname(__file__), "..", ".env.fly")
with open(out_path, "w") as f:
    f.write(f"FLY_ENGINE={FLY_ENGINE}\n")
    f.write(f"GOVERNOR={GOVERNOR}\n")
    for name, d in deployed.items():
        f.write(f"CONNECTOME_{name.upper()}={d['connectomeId']}\n")

print(f"\n=== Done: {len(deployed)} connectomes deployed ===")
print(f"Config: {out_path}")
