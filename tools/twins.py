"""Refresh who holds the 39 CryptoPunkins that left FE35 in 2021, right before deploying, and confirm it onchain.

Reads data/twins.json (edition, old_token_id), asks Blockscout who holds each one now, checks that holder's
balanceOf on the 2021 shared contract, and rewrites data/twins.json and data/twins-forge.json.

usage: python3 -I tools/twins.py data/
"""
import json, sys, time, urllib.request

SF = "0x495f947276749ce646f68ac8c248420045cb7b5e"
RPC = "https://eth.drpc.org"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    for k in range(4):
        try:
            return json.load(urllib.request.urlopen(req, timeout=30))
        except Exception:
            time.sleep(2 + 2 * k)
    raise SystemExit(f"no answer from {url}")


def balance(holder, token_id):
    data = "0x00fdd58e" + holder[2:].lower().rjust(64, "0") + format(int(token_id), "064x")
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{"to": SF, "data": data}, "latest"]}).encode()
    req = urllib.request.Request(RPC, data=body, headers={"Content-Type": "application/json", "User-Agent": "curl/8"})
    return int(json.load(urllib.request.urlopen(req, timeout=30))["result"], 16)


out = sys.argv[1]
twins = json.load(open(f"{out}/twins.json"))
moved = 0
for t in twins:
    items = get(f"https://eth.blockscout.com/api/v2/tokens/{SF}/instances/{t['old_token_id']}/holders").get("items", [])
    if len(items) != 1:
        raise SystemExit(f"edition {t['edition']}: expected one holder, got {items}")
    holder = items[0]["address"]["hash"]
    if balance(holder, t["old_token_id"]) != 1:
        raise SystemExit(f"edition {t['edition']}: Blockscout says {holder} but balanceOf disagrees")
    if holder.lower() != t["holder"].lower():
        print(f"edition {t['edition']}: {t['holder']} -> {holder}")
        moved += 1
    t["holder"] = holder
    time.sleep(0.3)
json.dump(twins, open(f"{out}/twins.json", "w"), indent=1)
json.dump({"holders": [t["holder"] for t in twins], "editions": [t["edition"] for t in twins]}, open(f"{out}/twins-forge.json", "w"))
print(f"{len(twins)} twins checked onchain, {moved} changed hands")
