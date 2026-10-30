import json, sys, urllib.request

RPC = "https://eth.drpc.org"
SF = "495f947276749ce646f68ac8c248420045cb7b5e"
MC3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
FE35 = 0xFE35e15bE885750D9b2363cbB6aBDd57AC9C4c40


def rpc(method, params):
    req = urllib.request.Request(RPC, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": "curl/8"})
    r = json.load(urllib.request.urlopen(req, timeout=60))
    if "error" in r:
        raise SystemExit(r["error"])
    return r["result"]


def u(x):
    return format(x, "064x")


def aggregate(calls):
    # aggregate((address,bytes)[]) -> (uint256, bytes[])
    n = len(calls)
    tuples = []
    for target, cd in calls:
        cdb = bytes.fromhex(cd)
        pad = cdb + b"\0" * ((32 - len(cdb) % 32) % 32)
        tuples.append(u(int(target, 16)) + u(0x40) + u(len(cdb)) + pad.hex())
    offs, pos = [], 32 * n
    for t in tuples:
        offs.append(u(pos))
        pos += len(t) // 2
    data = "0x252dba42" + u(0x20) + u(n) + "".join(offs) + "".join(tuples)
    res = bytes.fromhex(rpc("eth_call", [{"to": MC3, "data": data}, "latest"])[2:])
    w = lambda o: int.from_bytes(res[o:o + 32], "big")
    base = w(32)
    m = w(base)
    out = []
    for i in range(m):
        o = base + 32 + w(base + 32 + 32 * i)
        ln = w(o)
        out.append(res[o + 32:o + 32 + ln])
    return out


def tid(index, creator=FE35, supply=1):
    return (creator << 96) | (index << 40) | supply


lo, hi = int(sys.argv[1]), int(sys.argv[2])
idx = list(range(lo, hi))
minted = []
for c in range(0, len(idx), 250):
    chunk = idx[c:c + 250]
    calls = [(SF, "bd85b039" + u(tid(i))) for i in chunk]
    for i, r in zip(chunk, aggregate(calls)):
        if int.from_bytes(r, "big") > 0:
            minted.append(i)
# for minted ones, does FE35 still hold it?
held = []
for c in range(0, len(minted), 250):
    chunk = minted[c:c + 250]
    calls = [(SF, "00fdd58e" + u(FE35) + u(tid(i))) for i in chunk]
    for i, r in zip(chunk, aggregate(calls)):
        if int.from_bytes(r, "big") > 0:
            held.append(i)
print(json.dumps({"scanned": [lo, hi], "minted": minted, "minted_held_by_fe35": held}))
