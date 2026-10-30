"""Link cards for taylor.fyi/cryptopunkins/?p=<id>: one per edition, the whole pumpkin in each of its five colours
(whole-0 to whole-4, by uint32(id * 2654435761) % 5), and the Great Pumpkin.
The site Worker points og:image at the card for that pumpkin's current look. 1200x630, one headline top left.

usage: python3 -I tools/cards.py data/grid.json site/public/cards [edition ...]
"""
import base64, json, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scenes import compose, great_cells, png, retexture, scene, whole_cells

g = retexture(json.load(open(sys.argv[1])))
out = sys.argv[2]
only = [int(e) for e in sys.argv[3:]]
os.makedirs(out, exist_ok=True)
by = {x["edition"]: x["attributes"] for x in g["editions"]}
FONT = "Helvetica Neue, Helvetica, Arial, sans-serif"


def card(name, headline, cells):
    art = f"{out}/.{name}.art.png"
    png(cells, art, 600)
    b64 = base64.b64encode(open(art, "rb").read()).decode()
    os.remove(art)
    lines = headline.split("\n")
    text = "".join(f'<text x="72" y="{140 + 76 * i}" font-family="{FONT}" font-weight="700" font-size="64" letter-spacing="-2" fill="#f3eee5">{t}</text>' for i, t in enumerate(lines))
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#0b0e14"/>{text}
<image href="data:image/png;base64,{b64}" x="650" y="65" width="500" height="500" style="image-rendering:pixelated" preserveAspectRatio="none"/>
</svg>'''
    raw = subprocess.run(["rsvg-convert", "-w", "1200", "-h", "630", "-f", "png"], input=svg.encode(), check=True, capture_output=True).stdout
    # pixel art plus one line of text: a 256-colour palette keeps each card small
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", "-", "-vf", "split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=none",
                    f"{out}/{name}.png"], input=raw, check=True)


def edition_card(e):
    at = by[e]
    card(str(e), f"CryptoPunkin\n#{e}", compose(g, at, scene(at["Background"].strip())))


# (each colour through the packer's own table, as the site and the contract draw it: sky, moon and soil included)
site = json.load(open(os.path.join(os.path.dirname(sys.argv[1]), "site-art.json")))
index = {h: k for k, (h, _) in enumerate(site["palette"])}
hexc = lambda c: "#%02x%02x%02x" % c
whole = whole_cells(g)
for t in range(len(site["colours"])):
    tint = lambda c: c if not t else tuple(int(site["shades"][t - 1][index[hexc(c)]][i:i + 2], 16) for i in (1, 3, 5))
    card(f"whole-{t}", "Stab my\npumpkin", [tint(c) for c in whole])
card("great", "Great\nPumpkin", great_cells(g))
with ThreadPoolExecutor(8) as ex:
    list(ex.map(edition_card, only or sorted(by)))
files = [f for f in os.listdir(out) if f.endswith(".png")]
print(len(files), "cards,", sum(os.path.getsize(f"{out}/{f}") for f in files) // 1024, "KB")
