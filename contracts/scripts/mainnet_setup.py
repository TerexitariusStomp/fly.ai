#!/usr/bin/env python3
"""Mainnet FLYAI wiring: engine governor, decision ledger, approveToken proposal,
remaining connectome registration, SocialPostLog deploy.

Admin = deployer key (PRIVATE_KEY env). RPC = Robinhood mainnet via apikey.
"""
import json
import os
from web3 import Web3
from eth_account import Account

RPC_URL = os.environ["RPC_URL"]
CHAIN_ID = 4663

GOV = "0x6a7a1dF72301E6A09dd43aDf2fdd4487994E72A8"          # ConnectomeGovernor proxy
ENGINE = "0x07732dB25b67fd0cee4625b062ee6e710921c132"       # FlyEngine proxy
POLICY = "0x2257c925E5D6156Cca11F0d7F9a69859d383099f"       # GovernorPolicy
LEDGER = "0x9552e44a2ba380b4ddd62b6ca4359661cee6a864"       # DecisionLedger
BOND = "0x73fCF57eA4bB78b103e9323fAd27b54Fd7aeCCf2"         # SymbientInverseBond
FLYAI = "0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C"

w3 = Web3(Web3.HTTPProvider(RPC_URL, request_kwargs={"timeout": 30}))
assert w3.eth.chain_id == CHAIN_ID, f"wrong chain {w3.eth.chain_id}"

GOV = w3.to_checksum_address(GOV)
ENGINE = w3.to_checksum_address(ENGINE)
POLICY = w3.to_checksum_address(POLICY)
LEDGER = w3.to_checksum_address(LEDGER)
BOND = w3.to_checksum_address(BOND)
FLYAI = w3.to_checksum_address(FLYAI)

account = Account.from_key(os.environ["PRIVATE_KEY"])
print(f"admin: {account.address}  bal: {w3.eth.get_balance(account.address)/1e18:.6f} ETH")

CONNECTOMES = {
    "drosophila":   "0x496f04d31790c9dd6c0b19b95a2b76a2606490cacd621e9279fec4eeba059fa5",
    "rat":          "0x45d94bd5738ea6a952303cf25392ed25a7ebed9c4231fff56e76b7a2c88e3288",
    "mouse":        "0xcb70cd364aadb9e12f5c2c9ab8ba1d653220a4151039c4325545b338c4ef9af7",
    "ciona":        "0xd8b7c107f4cc62ee7ee98cf1ec64cea78ef53d0d209d3c53fa9c0f29f3527f72",
    "macaque_modha":"0xcbc4ab83fb41cebff809768ae02d1146df52359d26346e775c353edbc4591c2f",
    "human":        "0x8b6845f04f65083939b9eb59c895631085bf892ef3817ac55720ee694cfad0af",
    "celegans_male":"0xe5a70057cdf1ce4d0ed2f137fa8f483f6b3f42c41c1e4f7b9fe168642af0789b",
}
MISSING = ["rat", "mouse", "ciona", "macaque_modha"]
REGISTERED = ["drosophila", "human", "celegans_male"]


def send(to, data, value=0):
    tx = {
        "from": account.address,
        "to": to,
        "data": data,
        "value": value,
        "nonce": w3.eth.get_transaction_count(account.address),
        "gasPrice": int(w3.eth.gas_price * 1.5),
        "chainId": CHAIN_ID,
    }
    tx["gas"] = int(w3.eth.estimate_gas(tx) * 12 // 10)
    signed = account.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    r = w3.eth.wait_for_transaction_receipt(h, timeout=180)
    print(f"  tx {h.hex()[:18]}.. gas={r['gasUsed']} status={r['status']}")
    return h.hex(), r


def sel(sig):
    return w3.keccak(text=sig)[:4]


def addr_word(a):
    return bytes.fromhex(a[2:].lower().rjust(64, "0"))


def b32_word(b):
    return bytes.fromhex(b[2:])


def uint_word(n):
    return n.to_bytes(32, "big")


def i256(n):
    return (n % (1 << 256)).to_bytes(32, "big")


# ============================================================
# Step 1: FlyEngine.setGovernor(gov) — governor can manage connectomes
# ============================================================
print("\n== 1. engine.setGovernor(gov) ==")
send(ENGINE, sel("setGovernor(address)") + addr_word(GOV))

# ============================================================
# Step 2: gov.setDecisionLedger(ledger)
# ============================================================
print("\n== 2. gov.setDecisionLedger(ledger) ==")
send(GOV, sel("setDecisionLedger(address)") + addr_word(LEDGER))

# ============================================================
# Step 3: propose GovernorPolicy.approveToken(FLYAI, bond, 50e24)
#   bounded float cap = 5% of 1B supply
# ============================================================
print("\n== 3. propose approveToken float ==")
FLOAT = 50_000_000 * 10**18
approve_data = (
    sel("approveToken(address,address,uint256)")
    + addr_word(FLYAI) + addr_word(BOND) + uint_word(FLOAT)
)
market = [10**18, 5 * 10**17, 10**17, 10**17, 0]
# ABI: propose(address,bytes,(int256 x5)) —
# [sel][target][off_bytes][tuple 5x32][len][data][pad]
off_bytes = 32 * (1 + 1 + 5)  # after target + offset + tuple
call = (
    sel("propose(address,bytes,(int256,int256,int256,int256,int256))")
    + addr_word(POLICY)
    + uint_word(off_bytes)
    + b"".join(i256(v) for v in market)
    + uint_word(len(approve_data))
    + approve_data
    + b"\x00" * ((32 - len(approve_data) % 32) % 32)
)
_, r = send(GOV, call)
prop_id = None
for lg in r["logs"]:
    if lg["address"].lower() == GOV.lower() and len(lg["topics"]) >= 2:
        prop_id = "0x" + lg["topics"][1].hex()
        break
print(f"  proposalId: {prop_id}")

# ============================================================
# Step 4: votes from the 3 registered connectomes (bound to deployer)
# ============================================================
print("\n== 4. votes ==")
passed = False
if prop_id:
    for name in REGISTERED:
        call = sel("vote(bytes32,bytes32)") + b32_word(prop_id) + b32_word(CONNECTOMES[name])
        try:
            _, vr = send(GOV, call)
            if vr["status"] == 0:
                print(f"  {name}: vote reverted")
        except Exception as e:
            print(f"  {name}: {str(e)[:100]}")
        res = w3.eth.call({"to": GOV, "data": sel("isPassed(bytes32)") + b32_word(prop_id)})
        passed = int.from_bytes(res[-1:], "big") == 1
        print(f"  isPassed: {passed}")
        if passed:
            break

# ============================================================
# Step 5: execute if quorum reached
# ============================================================
print("\n== 5. execute ==")
if prop_id and passed:
    send(GOV, sel("execute(bytes32)") + b32_word(prop_id))
else:
    print("  skipped — quorum not reached via on-chain votes")

# ============================================================
# Step 6: register 4 missing connectomes in the governor
#   (engine data upload deferred — needs ~8M gas for SSTORE2 chunks)
# ============================================================
print("\n== 6. addConnectome x4 (voter bound to admin) ==")
for name in MISSING:
    call = sel("addConnectome(bytes32,address)") + b32_word(CONNECTOMES[name]) + addr_word(account.address)
    try:
        send(GOV, call)
        print(f"  {name} registered")
    except Exception as e:
        print(f"  {name}: {str(e)[:100]}")

# ============================================================
# Step 7: SocialPostLog deploy + wire (if gas remains)
# ============================================================
print("\n== 7. SocialPostLog ==")
bal = w3.eth.get_balance(account.address)
print(f"  remaining bal: {bal/1e18:.6f} ETH")
bytecode = None
for root, dirs, files in os.walk("out"):
    if "SocialPostLog.json" in files:
        art = json.load(open(os.path.join(root, "SocialPostLog.json")))
        bytecode = art["bytecode"]["object"]
        break
if not bytecode:
    print("  artifact not found — run forge build first")
elif bal > int(0.0002 * 1e18):
    initcode = bytecode + addr_word(account.address).hex()
    tx = {
        "from": account.address,
        "data": initcode,
        "nonce": w3.eth.get_transaction_count(account.address),
        "gasPrice": int(w3.eth.gas_price * 1.5),
        "chainId": CHAIN_ID,
    }
    tx["gas"] = int(w3.eth.estimate_gas(tx) * 12 // 10)
    signed = account.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    r = w3.eth.wait_for_transaction_receipt(h, timeout=180)
    spl = r["contractAddress"]
    print(f"  SocialPostLog deployed: {spl} gas={r['gasUsed']} status={r['status']}")
    if r["status"] == 1:
        # setGovernor(gov) so the governor can post; then gov.setSocialPostLog
        send(spl, sel("setGovernor(address)") + addr_word(GOV))
        send(GOV, sel("setSocialPostLog(address)") + addr_word(spl))
        print(f"  wired: governor can post to {spl}")
else:
    print("  skipped — low gas, deploy later")

print("\ndone.")
