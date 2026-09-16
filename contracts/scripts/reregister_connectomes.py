#!/usr/bin/env python3
"""Re-register connectomes with reduced simulation steps to fit block gas limit."""
import json
import os
import sys
from web3 import Web3
from eth_account import Account

RPC_URL = "https://rpc.testnet.arc.io"
CHAIN_ID = 5042002
FLY_ENGINE = "0x3858ce51c8b0AEeC27E7042A4B104A69bAFB8eec"
PACKED_DIR = os.path.expanduser("~/fly-data/packed")

# Load private key
deploy_script = os.path.join(os.path.dirname(__file__), "deploy-arc.sh")
PRIVATE_KEY = None
with open(deploy_script) as f:
    for line in f:
        if line.startswith("export PRIVATE_KEY="):
            PRIVATE_KEY = line.split("=", 1)[1].strip().strip('"')
            break

w3 = Web3(Web3.HTTPProvider(RPC_URL))
account = Account.from_key(PRIVATE_KEY)

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

# Connectome metadata with reduced steps
REDUCED_STEPS = {
    "drosophila": 5, "rat": 5, "mouse": 5, "ciona": 5,
    "macaque_modha": 5, "human": 5, "celegans_male": 5,
}

# Load all_connectomes.json to get chunk addresses
with open(os.path.join(PACKED_DIR, "all_connectomes.json")) as f:
    all_meta = json.load(f)

def send_tx(to, data, gas=500000):
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

# Re-register each connectome with reduced steps
for name, n_steps in REDUCED_STEPS.items():
    connectome_id = w3.keccak(text=name)
    meta = all_meta[name]
    print(f"Re-registering {name} with {n_steps} steps...")

    # Build ConnectomeData with reduced nSteps
    # We need the chunk addresses — they're in the .env.fly file
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env.fly")
    chunk_addrs = []
    with open(env_path) as f:
        for line in f:
            if line.startswith(f"CONNECTOME_{name.upper()}="):
                # This gives the connectome ID, not chunk addresses
                pass
            # We need to read chunk addresses from the packed dir metadata
            # Actually, we stored them during deployment — let me check if they're saved

    # The chunk addresses were printed during deployment but not saved
    # We need to re-deploy or use a different approach
    # For now, let's just update nSteps by calling a hypothetical update function
    # Or we can re-register with the same chunk addresses

    # Since we can't easily get the chunk addresses, let's deploy a helper contract
    # that reads them from the existing connectome registration
    # Or simpler: just re-register with the metadata we have

    # Actually, the simplest approach is to just update nSteps in the contract
    # But we don't have an update function. Let me add one.

    print(f"  Skipping {name} — need to re-deploy with new nSteps")
    continue

print("\nDone!")
