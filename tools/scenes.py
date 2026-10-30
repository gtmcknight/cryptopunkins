"""Night scenes for the 8 Background traits, drawn on the 38x38 cell grid.

usage: python3 -I tools/scenes.py data/grid.json preview/
"""
import json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from textures import DIM, GLOW, light, moon, texture, texture2, STYLES

N, CELL, X0, Y0, W = 38, 16, -4, -8, 600
hexrgb = lambda h: tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
mul = lambda a, b: ((a * b + 128) + ((a * b + 128) >> 8)) >> 8

STARS = [(4, 4), (9, 2), (15, 5), (24, 3), (2, 11), (35, 13), (7, 8), (12, 10), (33, 16)]

# sky top -> horizon bands, ground, moon, extras
SCENES = {
    "The Darkness": dict(sky=["#0b0b0e"], ground="#151515", star="#5a5a66", moon=None),
    "The Light": dict(sky=["#f7d988", "#f2bb4e", "#eea446", "#e88d3e"], ground="#7a4a1c", star=None,
                      moon=("full", "#fff4c8", 4.2)),  # a low sun
    "Fresh Blood": dict(sky=["#2a0710", "#3a0b18", "#4c1020"], ground="#1a0508", star="#c98a96",
                        moon=("full", "#d6404a", 3.2)),
    "Dry Blood": dict(sky=["#33232b", "#43303a", "#56404a"], ground="#22181c", star="#e8cfd4",
                      moon=("full", "#f3dcdc", 3.0), craters="#d9bcbc"),
    "Witch": dict(sky=["#1f1230", "#2b1a40", "#3a2452"], ground="#160d20", star="#d6c4ea",
                  moon=("crescent", "#efe6c8", 2.6), bats=True),
    "Witch Ghost": dict(sky=["#2c2740", "#38324f", "#463f60"], ground="#1e1a2b", star="#e3dcf4",
                        moon=("half", "#efe9f8", 2.8), fog="#6a6290"),
    "Zombie": dict(sky=["#101c14", "#16261b", "#1e3224"], ground="#0c140e", star="#b9d4bf",
                   moon=("gibbous", "#e6efd8", 2.8), graves="#3b4f40"),
    "Zombie Ghost": dict(sky=["#12261f", "#183229", "#1f4034"], ground="#0d1a15", star="#cfeadb",
                         moon=("waning", "#e8f6ec", 2.6), fog="#3f6f5c"),
}


def scene(name):
    s = SCENES[name]
    cells = []
    bands = s["sky"]
    edge = lambda y: min(len(bands) - 1, y * len(bands) // 34)
    for y in range(N):
        for x in range(N):
            b = edge(y)
            if b > 0 and edge(y - 1) < b and (x + y) % 2 == 0:  # dither the first row of each band
                b -= 1
            cells.append(hexrgb(s["ground"]) if y >= 36 else hexrgb(bands[b]))
    put = lambda x, y, c: cells.__setitem__(y * N + x, hexrgb(c)) if 0 <= x < N and 0 <= y < N else None
    if s["star"]:
        for x, y in STARS:
            put(x, y, s["star"])
    if s["moon"]:
        kind, color, r = s["moon"]
        cx, cy = 31, 6 if kind == "full" else 5
        moon(cells, kind, color, cx, cy, r, put)
        if s.get("craters"):
            for x, y in [(30, 5), (32, 7), (31, 8)]:
                put(x, y, s["craters"])
    if s.get("bats"):
        for bx, by in [(6, 6), (12, 3), (26, 9)]:
            for dx, dy in [(0, 0), (4, 0), (0, 1), (1, 1), (3, 1), (4, 1), (1, 2), (2, 2), (3, 2)]:
                put(bx + dx, by + dy, "#0a0612")
    if s.get("graves"):
        stone = [".XX.", "XXXX", "XXXX", "XXXX", "XXXX"]
        for gx in (0, 34):
            for dy, row in enumerate(stone):
                for dx, c in enumerate(row):
                    if c == "X":
                        put(gx + dx, 31 + dy, s["graves"])
    for y in (36, 37):  # the pumpkin's shadow on the ground
        for x in range(9, 29):
            cells[y * N + x] = tuple(v * 55 // 100 for v in cells[y * N + x])
    if s.get("fog"):
        for y in range(32, 36):
            for x in range(N):
                if y >= 34 or (y == 33 and (x + y) % 2 == 0) or (y == 32 and (x + y) % 4 == 0):
                    put(x, y, s["fog"])
    return cells


def retexture(g, version=2):
    """The everyday art: the 2021 Variety hatching swapped for lobed shading (textures.texture2; version 1 is the
    earlier ribs-and-highlight pass), and the Dead pumpkin's
    pale blue stem withered brown. The faces stay exactly as drawn in 2021."""
    for k in [k for k in g["layers"] if k.startswith("Variety/")]:
        g["layers"][k] = (texture if version == 1 else texture2)(g, k.split("/", 1)[1].strip())
    k = next(x for x in g["layers"] if x.startswith("Pumpkin/Dead"))
    stem = {hexrgb("#c0cbdc"): hexrgb("#7a6a55"), hexrgb("#8b9bb4"): hexrgb("#5b4d3c")}
    g["layers"][k] = [(*stem[tuple(p[:3])], p[3]) if j < 14 * N and p[3] and tuple(p[:3]) in stem else tuple(p)
                      for j, p in enumerate(g["layers"][k])]
    return g


def lit(g):
    """Halloween (Oct 31, New York): a copy of the everyday art with every pumpkin dimmed and its carved holes
    glowing (textures.light). Scenes and the Great Pumpkin don't change."""
    import copy
    return light(copy.deepcopy(g))


def compose(g, attrs, bg_cells):
    cells = list(bg_cells)
    for t in g["order"]:
        if t == "Background" or t not in attrs:
            continue
        for k, p in enumerate(g["layers"][f"{t}/{attrs[t]}"]):
            a = p[3]
            if a == 255:
                cells[k] = tuple(p[:3])
            elif a:
                d = cells[k]
                cells[k] = tuple(min(255, mul(p[i], a) + mul(d[i], 255 - a)) for i in range(3))
    return cells


def png(cells, path, size=W):
    raw = bytearray()
    for y in range(W):
        cy = (y - Y0) // CELL
        for x in range(W):
            raw += bytes(cells[cy * N + (x - X0) // CELL])
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{W}",
                    "-i", "-", "-vf", f"scale={size}:{size}:flags=neighbor", path], input=bytes(raw), check=True)


def mask_of(g):
    return [p[3] > 0 for p in g["layers"]["Pumpkin/Ripe"]]


def paint(cells, layer, recolor=None):
    for k, p in enumerate(layer):
        a = p[3]
        if not a:
            continue
        rgb = tuple(p[:3])
        if recolor and rgb in recolor:
            rgb = recolor[rgb]
        if a == 255:
            cells[k] = rgb
        else:
            d = cells[k]
            cells[k] = tuple(min(255, mul(rgb[i], a) + mul(d[i], 255 - a)) for i in range(3))


def whole_cells(g):
    """What you buy: an uncarved pumpkin out in the dark patch."""
    L = g["layers"]
    cells = [hexrgb("#141b2b")] * (N * N)
    for x, y in [(4, 4), (9, 2), (15, 5), (24, 3), (2, 11), (35, 13), (7, 8)]:
        cells[y * N + x] = hexrgb("#c9d2e8")
    moon(cells, "crescent", "#efe6c8", 31, 5, 2.6, lambda x, y, c: cells.__setitem__(y * N + x, hexrgb(c)))
    for k in range(36 * N, N * N):
        cells[k] = hexrgb("#2a2016")
    for y in (36, 37):
        for x in range(9, 29):
            cells[y * N + x] = tuple(v * 55 // 100 for v in cells[y * N + x])
    # (from lit() art the Ripe colours are already dimmed, so they pass through unchanged: a dark pumpkin)
    paint(cells, L["Pumpkin/Ripe"], {hexrgb("#da6700"): hexrgb("#b65a12"), hexrgb("#7d3200"): hexrgb("#5e2a06")})
    paint(cells, L["Variety/Jack-o-Lantern"])
    return cells


def whole_sprite(g):
    """The whole pumpkin with no sky, for the patch page (site only)."""
    L = g["layers"]
    cells = [(0, 0, 0)] * (N * N)
    alpha = [0] * (N * N)
    for name, recolor in (("Pumpkin/Ripe", {hexrgb("#da6700"): hexrgb("#b65a12"), hexrgb("#7d3200"): hexrgb("#5e2a06")}),
                          ("Variety/Jack-o-Lantern", None)):
        layer = L[name]
        paint(cells, layer, recolor)
        for k, p in enumerate(layer):
            if p[3] and name.startswith("Pumpkin"):
                alpha[k] = 255
    return [(*c, a) for c, a in zip(cells, alpha)]


def great_sprite(g):
    """The Great Pumpkin with its glow but no night, for the patch page (site only)."""
    full = great_cells(g)
    sky = hexrgb("#1d1229")
    return [(*c, 0 if c == sky else 255) for c in full]


def great_cells(g):
    """Still whole at midnight on Halloween: gold, glowing."""
    L = g["layers"]
    mask = mask_of(g)
    cells = [hexrgb("#1d1229")] * (N * N)
    body = [k for k, m in enumerate(mask) if m]
    glow = ["#d9a441", "#a8703f", "#7a4b45", "#52304a", "#331d38"]
    for k in range(N * N):
        if mask[k]:
            continue
        y, x = divmod(k, N)
        d = min(((y - b // N) ** 2 + (x - b % N) ** 2) ** 0.5 for b in body)
        if d <= len(glow):
            cells[k] = hexrgb(glow[max(0, int(d + 0.5) - 1)])
    for x, y in [(4, 5), (33, 4), (2, 22), (35, 26), (6, 33), (31, 34)]:
        for dx, dy in [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)]:
            cells[(y + dy) * N + x + dx] = hexrgb("#fff6d6") if (dx, dy) == (0, 0) else hexrgb("#f2bb4e")
    paint(cells, L["Pumpkin/Ripe"], {hexrgb("#da6700"): hexrgb("#efae2c"), hexrgb("#7d3200"): hexrgb("#b4740c")})
    tex = {tuple(p[:3]): hexrgb("#fff0b3") for p in L["Variety/Jack-o-Lantern"] if p[3]}
    paint(cells, L["Variety/Jack-o-Lantern"], tex)
    return cells


if __name__ == "__main__":
    g = retexture(json.load(open(sys.argv[1])))
    out = sys.argv[2]
    os.makedirs(f"{out}/scenes", exist_ok=True)
    by = {x["edition"]: x["attributes"] for x in g["editions"]}
    # one punkin per background, each on its own trait
    picks = {}
    for e, at in sorted(by.items()):
        b = at["Background"]
        if b not in picks and "Trick or Treat" not in at and at.get("Eyes") and e not in (586,):
            picks[b] = e
    picks["Zombie Ghost"] = 586
    order = ["The Darkness", "Witch", "Witch Ghost", "Zombie", "Zombie Ghost", "Dry Blood", "Fresh Blood", "The Light"]
    for b in order:
        png(compose(g, by[picks[b]], scene(b)), f"{out}/scenes/{b.replace(' ', '-').lower()}.png", 300)
    json.dump({b: picks[b] for b in order}, open(f"{out}/scenes/picks.json", "w"))
    print({b: picks[b] for b in order})
