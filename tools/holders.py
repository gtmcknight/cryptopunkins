import json, sys, time, urllib.request

SF = "0x495f947276749ce646f68ac8c248420045cb7b5e"
FE35 = 0xFE35e15bE885750D9b2363cbB6aBDd57AC9C4c40


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    for _ in range(4):
        try:
            return json.load(urllib.request.urlopen(req, timeout=30))
        except Exception as e:
            err = e
            time.sleep(2)
    return {"error": str(err)}


scan = json.load(open(sys.argv[1]))
rows = []
for i in scan["minted"]:
    tid = (FE35 << 96) | (i << 40) | 1
    meta = get(f"https://api.opensea.io/api/v2/metadata/ethereum/{SF}/{format(tid, '064x')}")
    hold = get(f"https://eth.blockscout.com/api/v2/tokens/{SF}/instances/{tid}/holders")
    holders = [(h.get("address", {}).get("hash"), h.get("value")) for h in hold.get("items", [])] if isinstance(hold, dict) else hold
    rows.append({"index": i, "name": meta.get("name"), "holders": holders, "err": hold.get("error") if isinstance(hold, dict) else None})
    print(i, meta.get("name"), holders, flush=True)
    time.sleep(0.4)
json.dump(rows, open(sys.argv[2], "w"), indent=1)
