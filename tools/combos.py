"""A local test page for trying trait combos in every version of the art side by side:
2021 (your files) | Now (clean textures, night scenes) | New texture (lobed shading), each with Halloween lighting.

usage: python3 -I tools/combos.py data/grid.json preview/combos
then:  open -a "Google Chrome" preview/combos/index.html
"""
import copy, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scenes import N, SCENES, lit, retexture, scene

raw = json.load(open(sys.argv[1]))
out = sys.argv[2]
os.makedirs(out, exist_ok=True)
CATS = raw["order"]
clean = lambda v: v.strip()
values = {c: sorted({clean(k.split("/", 1)[1]) for k in raw["layers"] if k.startswith(c + "/")}) for c in CATS}


def pack(g, scenes):
    palette, index, layers = [], {}, {}

    def colour(p):
        p = tuple(p)
        if p not in index:
            index[p] = len(palette)
            palette.append("#%02x%02x%02x" % p[:3] if p[3] == 255 else [("#%02x%02x%02x" % p[:3]), p[3]])
        return index[p]

    for key, cells in g["layers"].items():
        cat, v = key.split("/", 1)
        if cat == "Background" and scenes:
            cells = [(*c, 255) for c in scene(clean(v))]
        runs = []
        for y in range(N):
            x = 0
            while x < N:
                p = tuple(cells[y * N + x])
                if p[3] == 0:
                    x += 1
                    continue
                n = 1
                while x + n < N and tuple(cells[y * N + x + n]) == p:
                    n += 1
                runs.append([y, x, n, colour(p)])
                x += n
        layers[f"{cat}/{clean(v)}"] = runs
    return {"palette": palette, "layers": layers}


old = copy.deepcopy(raw)
now = retexture(copy.deepcopy(raw), version=1)
new = retexture(copy.deepcopy(raw), version=2)
sets = {
    "2021": pack(old, scenes=False),
    "Now": pack(now, scenes=True),
    "Now lit": pack(lit(now), scenes=True),
    "New texture": pack(new, scenes=True),
    "New texture lit": pack(lit(new), scenes=True),
}
editions = [{"n": x["edition"], "a": {k: clean(v) for k, v in x["attributes"].items()}} for x in raw["editions"]]
with open(f"{out}/data.js", "w") as f:
    f.write("window.COMBOS = ")
    json.dump({"cats": CATS, "values": values, "sets": sets, "editions": editions}, f, separators=(",", ":"))
    f.write(";\n")
print("data.js", os.path.getsize(f"{out}/data.js") // 1024, "KB")
