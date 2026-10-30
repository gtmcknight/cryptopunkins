"""Verify the deployed game and art contracts on Etherscan, with the full compiler input.

The art contract's bytecode depends on every file in the build (Sourcify saw the same), so forge's trimmed input
doesn't match it: this sends the whole standard JSON the deploy was built from, with each contract's constructor
arguments read off its creation transaction.

usage (after `forge build --build-info --force` in contracts/):
  ETHERSCAN_API_KEY=… python3 -I tools/verify-etherscan.py          (DRY=1 checks everything but the upload)
"""
import glob, json, os, subprocess, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RPC = os.environ.get("RPC", "https://ethereum-rpc.publicnode.com")
API = "https://api.etherscan.io/v2/api?chainid=1"
COMPILER = "v0.8.30+commit.73712a01"
DRY = bool(os.environ.get("DRY"))
KEY = os.environ.get("ETHERSCAN_API_KEY", "")
if not KEY and not DRY:
    sys.exit("Set ETHERSCAN_API_KEY.")


def get(url, data=None):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode() if data else None,
                                 headers={"user-agent": "cryptopunkins-verify"})
    return json.load(urllib.request.urlopen(req, timeout=60))


def cast(*args):
    return subprocess.run(["cast", *args, "--rpc-url", RPC], check=True, capture_output=True, text=True).stdout.strip()


game = open(os.path.join(ROOT, "deployed.txt")).read().split()[0]
renderer = cast("call", game, "renderer()(address)")
builds = [json.load(open(f)) for f in glob.glob(os.path.join(ROOT, "contracts/out/build-info/*.json"))]

for address, ident in ((renderer, "src/Renderer.sol:Renderer"), (game, "src/CryptoPunkins.sol:CryptoPunkins")):
    path, name = ident.split(":")
    build = next(b for b in builds if path in b.get("input", {}).get("sources", {}))
    std = {k: v for k, v in build["input"].items() if k in ("language", "sources", "settings")}
    compiled = json.load(open(os.path.join(ROOT, "contracts/out", os.path.basename(path), f"{name}.json")))["bytecode"]["object"]
    created = get(f"https://eth.blockscout.com/api/v2/addresses/{address}")["creation_transaction_hash"]
    sent = cast("tx", created, "input")
    if not sent.startswith(compiled):
        sys.exit(f"{name}: the build here doesn't match what was deployed; run `forge build --build-info --force` first.")
    args = sent[len(compiled):]
    print(f"{name} {address}: build matches the deploy, {len(args) // 2} bytes of constructor arguments")
    if DRY:
        continue
    r = get(API, {"apikey": KEY, "module": "contract", "action": "verifysourcecode", "contractaddress": address,
                  "sourceCode": json.dumps(std), "codeformat": "solidity-standard-json-input", "contractname": ident,
                  "compilerversion": COMPILER, "constructorArguements": args})
    if r.get("status") != "1":
        print(f"  {r.get('result')}")
        continue
    for _ in range(30):
        time.sleep(5)
        s = get(f"{API}&module=contract&action=checkverifystatus&guid={r['result']}&apikey={KEY}")["result"]
        if "Pending" not in s:
            break
    print(f"  {s}")
