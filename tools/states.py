"""Preview the three game states: whole, smashed (carved), Great Pumpkin.

usage: python3 -I tools/states.py data/grid.json preview/
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scenes import compose, great_cells, png, retexture, scene, whole_cells

g = retexture(json.load(open(sys.argv[1])))
out = sys.argv[2]
os.makedirs(out, exist_ok=True)
png(whole_cells(g), f"{out}/whole.png")
png(great_cells(g), f"{out}/great.png")
at = next(x for x in g["editions"] if x["edition"] == 586)["attributes"]
png(compose(g, at, scene(at["Background"])), f"{out}/smashed-586.png")
print("wrote", sorted(f for f in os.listdir(out) if f.endswith(".png")))
