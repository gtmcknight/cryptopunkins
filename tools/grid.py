"""Read the 2021 HashLips build into 38x38 cell grids and check it rebuilds.

The art is 600px with 16px cells. Cell (0,0) starts at pixel (-4,-8), so the
outer row and column are partial cells clipped by the canvas.

usage: python3 -I tools/grid.py <CryptoPunkins dropbox dir> <out dir>
"""
import json, os, subprocess, sys
from collections import Counter

W, CELL, X0, Y0, N = 600, 16, -4, -8, 38
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)


def rgba(path):
    return subprocess.run(["ffmpeg", "-loglevel", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
                          check=True, capture_output=True).stdout


def cells(path):
    """38x38 list of RGBA tuples; transparent cells are (0,0,0,0). Fails on a non-uniform cell."""
    b = rgba(path)
    px = lambda x, y: tuple(b[(y * W + x) * 4:(y * W + x) * 4 + 4])
    grid = []
    for cy in range(N):
        for cx in range(N):
            x0, y0 = max(0, X0 + cx * CELL), max(0, Y0 + cy * CELL)
            x1, y1 = min(W, X0 + (cx + 1) * CELL), min(W, Y0 + (cy + 1) * CELL)
            seen = {px(x, y) if px(x, y)[3] else (0, 0, 0, 0) for y in range(y0, y1) for x in range(x0, x1)}
            if len(seen) != 1:
                raise SystemExit(f"{path}: cell {cx},{cy} not uniform: {seen}")
            grid.append(seen.pop())
    return grid


layers = {}
for t in sorted(os.listdir(f"{src}/layers")):
    if not os.path.isdir(f"{src}/layers/{t}"):
        continue
    for f in sorted(os.listdir(f"{src}/layers/{t}")):
        if f.endswith(".png"):
            layers[f"{t}/{f.split('#')[0]}"] = cells(f"{src}/layers/{t}/{f}")

meta = json.load(open(f"{src}/build-FINAL/json/_metadata.json"))
images = {}
for x in meta:
    e = x["edition"]
    p = f"{src}/build-FINAL/images/_done/{e}.png"
    images[e] = [c[:3] for c in cells(p if os.path.exists(p) else f"{src}/build-FINAL/images/{e}.png")]

mul = lambda a, b: ((a * b + 128) + ((a * b + 128) >> 8)) >> 8  # pixman MUL_UN8


def compose(x, order):
    out_ = [(0, 0, 0)] * (N * N)
    at = {a["trait_type"]: a["value"] for a in x["attributes"]}
    for t in order:
        if t not in at:
            continue
        for k, p in enumerate(layers[f"{t}/{at[t]}"]):
            a = p[3]
            if a == 255:
                out_[k] = p[:3]
            elif a:
                d = out_[k]
                out_[k] = tuple(min(255, mul(p[i], a) + mul(d[i], 255 - a)) for i in range(3))
    return out_


def worst(c, o):
    return max(max(abs(c[k][i] - o[k][i]) for i in range(3)) for k in range(N * N))


ORDER = ["Background", "Pumpkin", "Variety", "Hair", "Nose", "Mouth", "Eyes", "Trick or Treat"]
special = [x for x in meta if any(a["trait_type"] == "Trick or Treat" for a in x["attributes"])]
best = None
for pos in range(1, len(ORDER)):
    order = [t for t in ORDER if t != "Trick or Treat"]
    order.insert(pos, "Trick or Treat")
    score = sum(worst(compose(x, order), images[x["edition"]]) for x in special)
    if best is None or score < best[0]:
        best = (score, order)
order = best[1]
diffs = Counter(worst(compose(x, order), images[x["edition"]]) for x in meta)
print("layer order:", order)
print("worst channel difference per punkin (difference: count):", dict(sorted(diffs.items())))

json.dump({"order": order, "layers": {k: v for k, v in layers.items()},
           "editions": [{"edition": x["edition"], "dna": x["dna"],
                         "attributes": {a["trait_type"]: a["value"] for a in x["attributes"]}} for x in meta]},
          open(f"{out}/grid.json", "w"))
print("layers", len(layers), "editions", len(meta), "->", f"{out}/grid.json")
