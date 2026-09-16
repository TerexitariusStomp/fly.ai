#!/usr/bin/env python3
"""Deploy FlyEngine + ConnectomeGovernor + 7 connectomes to Arc testnet.

Uses web3.py to:
1. Deploy FlyEngine (UUPS proxy)
2. Deploy ConnectomeGovernor (UUPS proxy)
3. Link them
4. Deploy SSTORE2 chunks for each connectome
5. Register each connectome in FlyEngine AND ConnectomeGovernor

The 7 registered connectomes:
  rosophila(49) rat(73) mouse(112) ciona(205) macaque_modha(242) human(234) celegans_male(575)

After registration, connectomes vote on governor proposals via vote(pid, cid) —
each vote runs the connectome's on-chain LIF inference via FlyEngine.analyze().
Pass = >=3 of 7 for votes (one-third quorum) and for > against.
"""
import json
import os
import sys
import time
from web3 import Web3
from eth_account import Account

# Arc testnet
RPC_URL = os.environ.get("ARC_RPC_URL", "https://rpc.testnet.arc.io")
CHAIN_ID = 5042002

# Load private key
PRIVATE_KEY = os.environ.get("PRIVATE_KEY")
if not PRIVATE_KEY:
    # Try loading from deploy script
    deploy_script = os.path.join(os.path.dirname(__file__), "deploy-arc.sh")
    if os.path.exists(deploy_script):
        with open(deploy_script) as f:
            for line in f:
                if line.startswith("export PRIVATE_KEY="):
                    PRIVATE_KEY = line.split("=", 1)[1].strip().strip('"')
                    break

if not PRIVATE_KEY or not PRIVATE_KEY.startswith("0x"):
    print("ERROR: PRIVATE_KEY not found. Set PRIVATE_KEY env var.")
    sys.exit(1)

PACKED_DIR = os.path.expanduser("~/fly-data/packed")

# Connect
w3 = Web3(Web3.HTTPProvider(RPC_URL))
if not w3.is_connected():
    print(f"ERROR: Cannot connect to {RPC_URL}")
    sys.exit(1)

print(f"Connected to {RPC_URL} (chain ID: {w3.eth.chain_id})")
assert w3.eth.chain_id == CHAIN_ID, f"Wrong chain ID: {w3.eth.chain_id}"

account = Account.from_key(PRIVATE_KEY)
deployer = account.address
balance = w3.eth.get_balance(deployer)
print(f"Deployer: {deployer}")
print(f"Balance: {w3.from_wei(balance, 'ether')} ETH")

# Load compiled contracts
def load_contract(name):
    """Load compiled contract from Foundry out/ directory."""
    out_dir = os.path.join(os.path.dirname(__file__), "..", "out")
    # Search recursively for the contract JSON
    for root, dirs, files in os.walk(out_dir):
        path = os.path.join(root, f"{name}.json")
        if os.path.exists(path):
            with open(path) as f:
                return json.load(f)
    print(f"ERROR: {name}.json not found in {out_dir}. Run 'forge build' first.")
    sys.exit(1)

def deploy_contract(w3, account, abi, bytecode, constructor_args=None):
    """Deploy a contract and return the deployed address."""
    contract = w3.eth.contract(abi=abi, bytecode=bytecode)
    if constructor_args:
        tx = contract.constructor(*constructor_args).build_transaction({
            "from": account.address,
            "nonce": w3.eth.get_transaction_count(account.address),
            "gas": 5_000_000,
            "gasPrice": w3.eth.gas_price,
            "chainId": w3.eth.chain_id,
        })
    else:
        tx = contract.constructor().build_transaction({
            "from": account.address,
            "nonce": w3.eth.get_transaction_count(account.address),
            "gas": 5_000_000,
            "gasPrice": w3.eth.gas_price,
            "chainId": w3.eth.chain_id,
        })
    signed = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
    if receipt.status != 1:
        print(f"ERROR: Deploy failed: {tx_hash.hex()}")
        sys.exit(1)
    return receipt.contractAddress, receipt

def send_tx(w3, account, to, data, gas=2_000_000):
    """Send a transaction and return receipt."""
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

def sstore2_write(w3, account, data):
    """Deploy SSTORE2 storage contract (bytecode = 0x00 + data)."""
    # SSTORE2 format: STOP (0x00) + data
    bytecode = b"\x00" + data
    tx = {
        "from": account.address,
        "data": "0x" + bytecode.hex(),
        "nonce": w3.eth.get_transaction_count(account.address),
        "gas": 3_000_000,
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

def main():
    print("\n=== Step 1: Deploy FlyEngine implementation ===")
    fly_engine_json = load_contract("FlyEngine")
    fly_impl_addr, _ = deploy_contract(
        w3, account,
        fly_engine_json["abi"],
        fly_engine_json["bytecode"]["object"]
    )
    print(f"  FlyEngine impl: {fly_impl_addr}")

    print("\n=== Step 2: Deploy FlyEngine UUPS proxy ===")
    # initialize(address admin)
    fly_contract = w3.eth.contract(
        abi=fly_engine_json["abi"],
        bytecode=fly_engine_json["bytecode"]["object"]
    )
    init_data = fly_contract.encode_abi(
        "initialize",
        [w3.to_checksum_address(deployer)]
    )

    erc1967_json = load_contract("ERC1967Proxy")
    fly_proxy_addr, _ = deploy_contract(
        w3, account,
        erc1967_json["abi"],
        erc1967_json["bytecode"]["object"],
        [fly_impl_addr, init_data]
    )
    print(f"  FlyEngine proxy: {fly_proxy_addr}")

    fly_engine = w3.eth.contract(
        address=fly_proxy_addr,
        abi=fly_engine_json["abi"]
    )

    print("\n=== Step 3: Deploy ConnectomeGovernor implementation ===")
    gov_json = load_contract("ConnectomeGovernor")
    gov_impl_addr, _ = deploy_contract(
        w3, account,
        gov_json["abi"],
        gov_json["bytecode"]["object"]
    )
    print(f"  Governor impl: {gov_impl_addr}")

    print("\n=== Step 4: Deploy ConnectomeGovernor UUPS proxy ===")
    # initialize(address admin, address flyEngine)
    gov_contract = w3.eth.contract(
        abi=gov_json["abi"],
        bytecode=gov_json["bytecode"]["object"]
    )
    gov_init_data = gov_contract.encode_abi(
        "initialize",
        [w3.to_checksum_address(deployer), w3.to_checksum_address(fly_proxy_addr)]
    )

    gov_proxy_addr, _ = deploy_contract(
        w3, account,
        erc1967_json["abi"],
        erc1967_json["bytecode"]["object"],
        [gov_impl_addr, gov_init_data]
    )
    print(f"  Governor proxy: {gov_proxy_addr}")

    governor = w3.eth.contract(
        address=gov_proxy_addr,
        abi=gov_json["abi"]
    )

    print("\n=== Step 5: Link FlyEngine.governor = Governor ===")
    tx_data = fly_engine.encode_abi("setGovernor", [w3.to_checksum_address(gov_proxy_addr)])
    receipt = send_tx(w3, account, fly_proxy_addr, tx_data)
    print(f"  Linked: {receipt.status == 1}")

    print("\n=== Step 6: Deploy connectomes via SSTORE2 ===")
    with open(os.path.join(PACKED_DIR, "all_connectomes.json")) as f:
        all_meta = json.load(f)

    # Optional voter EOA per connectome (bound voter for governor.vote())
    # env: CONNECTOME_VOTER_<NAME> (defaults to deployer EOA)
    def voter_for(name):
        return w3.to_checksum_address(
            os.environ.get(f"CONNECTOME_VOTER_{name.upper()}", deployer)
        )

    deployed = {}
    for name, meta in all_meta.items():
        print(f"\n  Deploying {name} ({meta['nNeurons']} neurons, {meta['nSynapses']} synapses)...")

        # Deploy SSTORE2 chunks
        chunk_addrs = []
        for i in range(meta["nChunks"]):
            chunk_path = os.path.join(PACKED_DIR, name, f"chunk_{i:03d}.bin")
            with open(chunk_path, "rb") as f:
                chunk_data = f.read()
            addr = sstore2_write(w3, account, chunk_data)
            chunk_addrs.append(addr)
            print(f"    chunk {i}: {addr} ({len(chunk_data)} bytes)")

        # Register connectome in FlyEngine
        connectome_id = w3.keccak(text=name)
        # Build ConnectomeData struct
        # struct ConnectomeData {
        #   uint32 nNeurons, uint32 nSynapses, uint8 nSteps, uint8 indptrWidth,
        #   uint32 indptrOffset, uint32 indicesOffset, uint32 weightsOffset,
        #   address[] chunks
        # }
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
        receipt = send_tx(w3, account, fly_proxy_addr, tx_data, gas=500000)
        if receipt.status == 1:
            print(f"    Registered in FlyEngine: {connectome_id.hex()}")
            # Register in governor (voter = bound EOA that calls vote())
            voter = voter_for(name)
            tx_data = governor.encode_abi("addConnectome", [connectome_id, voter])
            receipt = send_tx(w3, account, gov_proxy_addr, tx_data, gas=200000)
            if receipt.status == 1:
                print(f"    Registered in Governor, voter={voter}")
            else:
                print(f"    ERROR: governor registration failed")
            deployed[name] = {
                "connectomeId": connectome_id.hex(),
                "voter": voter,
                "chunks": chunk_addrs,
                "meta": meta,
            }
        else:
            print(f"    ERROR: Registration failed")
        time.sleep(1)

    # Save deployment addresses
    deployment = {
        "flyEngine": fly_proxy_addr,
        "flyEngineImpl": fly_impl_addr,
        "governor": gov_proxy_addr,
        "governorImpl": gov_impl_addr,
        "deployer": deployer,
        "connectomes": deployed,
    }
    out_path = os.path.join(os.path.dirname(__file__), "..", ".env.fly")
    with open(out_path, "w") as f:
        f.write(f"FLY_ENGINE={fly_proxy_addr}\n")
        f.write(f"FLY_ENGINE_IMPL={fly_impl_addr}\n")
        f.write(f"GOVERNOR={gov_proxy_addr}\n")
        f.write(f"GOVERNOR_IMPL={gov_impl_addr}\n")
        for name, d in deployed.items():
            f.write(f"CONNECTOME_{name.upper()}={d['connectomeId']}\n")
            f.write(f"CONNECTOME_VOTER_{name.upper()}={d['voter']}\n")

    deploy_json = os.path.join(os.path.dirname(__file__), "..", "deploy.fly.json")
    with open(deploy_json, "w") as f:
        json.dump(deployment, f, indent=2)

    print(f"\n=== Deployment complete ===")
    print(f"  FlyEngine: {fly_proxy_addr}")
    print(f"  Governor: {gov_proxy_addr}")
    print(f"  Connectomes: {len(deployed)}")
    print(f"  Config: {out_path}")
    print(f"  Full: {deploy_json}")

if __name__ == "__main__":
    main()
