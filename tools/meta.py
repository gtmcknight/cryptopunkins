import json, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

SF = "0x495f947276749ce646f68ac8c248420045cb7b5e"
FE35 = 0xFE35e15bE885750D9b2363cbB6aBDd57AC9C4c40


def get(i):
    tid = (FE35 << 96) | (i << 40) | 1
    url = f"https://api.opensea.io/api/v2/metadata/ethereum/{SF}/{format(tid, '064x')}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    for k in range(5):
        try:
            d = json.load(urllib.request.urlopen(req, timeout=30))
            return {"index": i, "id": str(tid), "name": d.get("name"), "image": d.get("image"),
                    "traits": {t["trait_type"]: t["value"] for t in d.get("traits") or []}}
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return {"index": i, "id": str(tid), "name": None, "status": 404}
            time.sleep(2 + k * 2)
        except Exception:
            time.sleep(2 + k * 2)
    return {"index": i, "id": str(tid), "name": None, "status": "fail"}


lo, hi = int(sys.argv[1]), int(sys.argv[2])
with ThreadPoolExecutor(4) as ex:
    rows = list(ex.map(get, range(lo, hi)))
json.dump(rows, open(sys.argv[3], "w"))
named = [r for r in rows if r.get("name")]
print("named", len(named), "of", len(rows), "fails", sum(1 for r in rows if r.get("status") == "fail"))
