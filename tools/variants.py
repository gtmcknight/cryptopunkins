"""Art variants for Taylor to pick from, on the same punkins:
A  now (clean textures, night scenes)
B  now, plus a curled vine on the stem and a shadow under the pumpkin
C  lit at night: the pumpkin dims and every carved hole glows from inside (dark inner wall at its top edge);
   masks and shades stay as they are

usage: python3 -I tools/variants.py data/grid.json preview/variants
"""
import json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scenes import N, compose, hexrgb, png, retexture, scene

g = retexture(json.load(open(sys.argv[1])))
out = sys.argv[2]
os.makedirs(out, exist_ok=True)
by = {x["edition"]: x["attributes"] for x in g["editions"]}
L = g["layers"]
WORN = {"Big Shades", "Shades", "Cat Mask", "Thief"}  # eyes that are things worn, not holes
WALL, EDGE, CORE = hexrgb("#8a3a05"), hexrgb("#ffb02e"), hexrgb("#fff0a8")


def holes(at):
    """Cells of carved holes: the black of the eye, nose and mouth layers (not masks or shades)."""
    h = set()
    for cat in ("Eyes", "Nose", "Mouth"):
        v = at.get(cat)
        if not v or (cat == "Eyes" and v in WORN):
            continue
        for k, p in enumerate(L[f"{cat}/{v}"]):
            if p[3] == 255 and tuple(p[:3]) == (0, 0, 0):
                h.add(k)
    return h


def night(cells, at):
    """The pumpkin in the dark, so its lit face carries: everything that isn't sky or a hole dims."""
    sky = scene(at["Background"])
    for k, c in enumerate(cells):
        if c != sky[k]:
            cells[k] = tuple(v * 62 // 100 for v in c)
    return cells


def lit(cells, at):
    h = holes(at)
    for k in h:
        y, x = divmod(k, N)
        inside = lambda yy, xx: 0 <= yy < N and 0 <= xx < N and (yy * N + xx) in h
        if not inside(y - 1, x):
            cells[k] = WALL  # the cut's top edge: the inside wall in shadow
        elif all(inside(y + dy, x + dx) for dy, dx in ((1, 0), (0, 1), (0, -1))):
            cells[k] = CORE
        else:
            cells[k] = EDGE
    return cells


def vine(cells, at):
    green = hexrgb("#3d5c28")
    for x, y in [(22, 10), (23, 9), (24, 9), (25, 10), (25, 11), (24, 12), (23, 11)]:
        cells[y * N + x] = green
    # a shadow on the ground under the pumpkin
    for y in (36, 37):
        for x in range(9, 29):
            r, gg, b = cells[y * N + x]
            cells[y * N + x] = (r * 55 // 100, gg * 55 // 100, b * 55 // 100)
    return cells


picks = [586, 431, 8, 1, 303, 742, 155, 720]
rows = []
for name, fx in [("A", lambda c, a: c), ("B", lambda c, a: vine(c, a)), ("C", lambda c, a: vine(lit(night(c, a), a), a))]:
    files = []
    for e in picks:
        at = {k: v.strip() for k, v in by[e].items()}
        cells = fx(compose(g, by[e], scene(at["Background"])), at)
        f = f"{out}/{name}-{e}.png"
        png(cells, f, 200)
        files.append(f)
    row = f"{out}/row-{name}.png"
    args = ["ffmpeg", "-loglevel", "error", "-y"]
    for f in files:
        args += ["-i", f]
    args += ["-filter_complex", "".join(f"[{i}]" for i in range(len(files))) + f"hstack=inputs={len(files)}", row]
    subprocess.run(args, check=True)
    rows.append(row)
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", rows[0], "-i", rows[1], "-i", rows[2], "-filter_complex",
                "[0][1][2]vstack=inputs=3", f"{out}/abc.png"], check=True)
print("wrote", f"{out}/abc.png")
