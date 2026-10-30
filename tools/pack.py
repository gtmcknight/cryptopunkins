"""Pack the art and the 1,031 editions into the bytes the contract stores, plus a JSON copy for the site.

art.bin       palette, layer table, row runs (y, x, len, colour) for every layer the renderer draws; the last three
              are the whole pumpkin, the whole pumpkin on Halloween, and the Great Pumpkin
traits.bin    category and value names, each value's layer and its Halloween glow layer (255 = none)
editions.bin  8 bytes per edition (one value per category, 0 = none); all 1,031 are for sale
              (art.bin ends with the colours: each palette colour in the four other oranges an uncut pumpkin comes in)

On Halloween the renderer dims every layer but the scenes to DIM percent and draws a value's glow layer right after it.

usage: python3 -I tools/pack.py data/grid.json data/
"""
import colorsys, json, os, struct, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scenes import DIM, N, SCENES, great_cells, great_sprite, lit, retexture, scene, whole_cells, whole_sprite

g = retexture(json.load(open(sys.argv[1])))
h = lit(g)  # Halloween
out = sys.argv[2]

# An uncut pumpkin's colour, by its id (the game and the site both use uint32(id * 2654435761) % 5): its oranges,
# yellows and browns shift in hue, saturation and lightness; its stem, outline and sky stay.
COLOURS = [("Orange", 0, 1, 1), ("Rust", -7, 1.08, 0.9), ("Amber", 9, 0.95, 1.08), ("Copper", -3, 0.95, 0.82), ("Gold", 14, 1, 1.02)]


def shade(rgb, c):
    _, dh, ms, ml = COLOURS[c]
    hh, l, s = colorsys.rgb_to_hls(*(v / 255 for v in rgb))
    h = hh * 360
    if not (s > 0.15 and 5 <= h <= 60) or not c:
        return tuple(rgb)
    r, g_, b = colorsys.hls_to_rgb(((h + dh) % 360) / 360, min(1, l * ml), min(1, s * ms))
    return tuple(int(min(255, max(0, round(v * 255)))) for v in (r, g_, b))

CATS = g["order"]  # Background, Pumpkin, Variety, Trick or Treat, Hair, Nose, Mouth, Eyes
clean = lambda v: v.strip()
values = {c: sorted({clean(k.split("/", 1)[1]) for k in g["layers"] if k.startswith(c + "/")}) for c in CATS}
assert values["Background"] == sorted(SCENES), values["Background"]

palette, pindex = [], {}


def colour(rgba):
    rgba = tuple(rgba)
    if rgba not in pindex:
        pindex[rgba] = len(palette)
        palette.append(rgba)
    return pindex[rgba]


def runs_of(cells):
    """cells: 38x38 RGBA (alpha 0 = nothing). Row runs of one colour."""
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
            runs.append((y, x, n, colour(p)))
            x += n
    return runs


opaque = lambda cells: [(*c, 255) for c in cells]
layers, layer_of = [], {}
for v in values["Background"]:  # each Background trait is a night scene now
    layer_of[("Background", v)] = len(layers)
    layers.append(runs_of(opaque(scene(v))))
for c in CATS[1:]:
    for v in values[c]:
        key = next(k for k in g["layers"] if k.startswith(c + "/") and clean(k.split("/", 1)[1]) == v)
        layer_of[(c, v)] = len(layers)
        layers.append(runs_of(g["layers"][key]))
# Halloween glow: the cells light() lit in each eye, nose and mouth layer, drawn over the dimmed layer
glow_of = {}
for c in ("Nose", "Mouth", "Eyes"):
    for v in values[c]:
        key = next(k for k in g["layers"] if k.startswith(c + "/") and clean(k.split("/", 1)[1]) == v)
        day, night = g["layers"][key], h["layers"][key]
        cells = [tuple(night[k]) if day[k][3] == 255 and tuple(day[k][:3]) == (0, 0, 0) and tuple(night[k][:3]) != (0, 0, 0)
                 else (0, 0, 0, 0) for k in range(N * N)]
        if any(p[3] for p in cells):
            glow_of[(c, v)] = len(layers)
            layers.append(runs_of(cells))
WHOLE, WHOLE_LIT, GREAT = len(layers), len(layers) + 1, len(layers) + 2
layers.append(runs_of(opaque(whole_cells(g))))
layers.append(runs_of(opaque(whole_cells(h))))
layers.append(runs_of(opaque(great_cells(g))))
assert len(palette) < 256 and len(layers) < 255

art = bytearray(struct.pack(">H", len(palette)))
for p in palette:
    art += bytes(p)
art += struct.pack(">H", len(layers))
off = 0
for l in layers:
    art += struct.pack(">H", off)
    off += 4 * len(l)
art += struct.pack(">H", off)
for l in layers:
    for r in l:
        art += bytes(r)
art += bytes([len(COLOURS) - 1])
for c in range(1, len(COLOURS)):
    for p in palette:
        art += bytes(shade(p[:3], c))

traits = bytearray([len(CATS)])
for c in CATS:
    traits += bytes([len(c)]) + c.encode() + bytes([len(values[c])])
    for v in values[c]:
        traits += bytes([len(v)]) + v.encode() + bytes([layer_of[(c, v)], glow_of.get((c, v), 255)])

eds = sorted(g["editions"], key=lambda x: x["edition"])
assert [x["edition"] for x in eds] == list(range(1, 1032))
editions = bytearray()
for x in eds:
    at = {k: clean(v) for k, v in x["attributes"].items()}
    editions += bytes(values[c].index(at[c]) + 1 if c in at else 0 for c in CATS)

for name, blob in [("art.bin", art), ("traits.bin", traits), ("editions.bin", editions)]:
    open(f"{out}/{name}", "wb").write(blob)
    print(f"{name:13s} {len(blob):6d} bytes")
print("layers", len(layers), "glow", len(glow_of), "palette", len(palette), "runs", sum(map(len, layers)), "whole", WHOLE, "great", GREAT)

# the same art for the site, so it can draw the patch without a call per pumpkin, plus sprites with no sky for the
# patch page itself (these three never go onchain: they come after the contract's layers)
SPRITES = {}
for name, cells in (("wholeSprite", whole_sprite(g)), ("wholeSpriteLit", whole_sprite(h)), ("greatSprite", great_sprite(g))):
    SPRITES[name] = len(layers)
    layers.append(runs_of(cells))
hexc = lambda p: "#%02x%02x%02x" % p[:3]
json.dump({
    "palette": [[hexc(p), p[3]] for p in palette],
    "layers": layers,
    "cats": CATS,
    "values": values,
    "layerOf": {c: [layer_of[(c, v)] for v in values[c]] for c in CATS},
    "glowOf": {c: [glow_of.get((c, v), -1) for v in values[c]] for c in CATS},
    "editions": [list(editions[i * 8:i * 8 + 8]) for i in range(1031)],
    "whole": WHOLE, "wholeLit": WHOLE_LIT, "great": GREAT, "dim": DIM, **SPRITES,
    "colours": [name for name, *_ in COLOURS],
    "shades": [[hexc(shade(p[:3], c)) for p in palette] for c in range(1, len(COLOURS))],
}, open(f"{out}/site-art.json", "w"), separators=(",", ":"))
print("site-art.json", os.path.getsize(f"{out}/site-art.json"), "bytes")
