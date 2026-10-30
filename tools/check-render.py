"""Check the contract's SVGs against the art they were packed from.

Rasterizes every SVG the render test wrote (contracts/render/*.svg) at 600px with rsvg-convert, samples each 16px
cell, and compares it with the same punkin composited here from the layers. Prints the worst channel difference.

usage: python3 -I tools/check-render.py data/grid.json contracts/render
"""
import json, os, subprocess, sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scenes import N, compose, great_cells, lit, retexture, scene, whole_cells

g = retexture(json.load(open(sys.argv[1])))
h = lit(g)  # Halloween
folder = sys.argv[2]
by = {x["edition"]: x["attributes"] for x in g["editions"]}


def expected(name):
    art = h if name.endswith("-lit") else g
    name = name.removesuffix("-lit")
    if name == "whole":
        return whole_cells(art)
    if name == "great":
        return great_cells(art)
    at = by[int(name)]
    return compose(art, at, scene(at["Background"].strip()))


def drawn(path):
    png = subprocess.run(["rsvg-convert", "-w", "600", "-h", "600", path], check=True, capture_output=True).stdout
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "-", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         input=png, check=True, capture_output=True).stdout
    return [tuple(raw[((16 * cy) * 600 + 4 + 16 * cx) * 3:((16 * cy) * 600 + 4 + 16 * cx) * 3 + 3])
            for cy in range(N) for cx in range(N)]


def check(f):
    name = f[:-4]
    a, b = drawn(f"{folder}/{f}"), expected(name)
    return name, max(max(abs(a[k][i] - b[k][i]) for i in range(3)) for k in range(N * N))


files = sorted(f for f in os.listdir(folder) if f.endswith(".svg"))
with ThreadPoolExecutor(8) as ex:
    results = list(ex.map(check, files))
worst = Counter(d for _, d in results)
print(len(results), "SVGs; worst channel difference (difference: count):", dict(sorted(worst.items())))
bad = [r for r in results if r[1] > 2]
print("off by more than 2:", bad[:20])
sys.exit(1 if bad else 0)
