"""Clean Variety textures: ribs that follow the pumpkin's curve, a highlight and a shadow, drawn as see-through
light and dark so they work on every pumpkin colour (Ripe, Fresh, Zombie, Dead). Replaces the 2021 hatching.
"""
N = 38


def _body(g):
    """Rows of the pumpkin's flesh (not outline, not stem): {y: (x0, x1)}"""
    L = g["layers"]["Pumpkin/Ripe"]
    rows = {}
    for y in range(N):
        xs = [x for x in range(N) if tuple(L[y * N + x][:3]) == (0xDA, 0x67, 0x00) and L[y * N + x][3]]
        if len(xs) >= 6:
            rows[y] = (min(xs), max(xs))
    return rows


DARK = lambda a: (0, 0, 0, a)
LIGHT = lambda a: (255, 255, 255, a)

# name: ribs (positions across the width), rib strength, highlight strength, shadow strength, extras
STYLES = {
    "Jack-o-Lantern": dict(ribs=(-0.62, -0.2, 0.2, 0.62), rib=70, light=70, shade=60),
    "Small Sugar": dict(ribs=(-0.72, -0.42, -0.12, 0.18, 0.48, 0.76), rib=95, light=55, shade=70),
    "Harvest Moon": dict(ribs=(-0.5, 0.0, 0.5), rib=40, light=95, shade=45),
    "Autumn Gold": dict(ribs=(-0.6, -0.2, 0.2, 0.6), rib=60, light=60, shade=55, glints=True),
    "Ghost Rider": dict(ribs=(-0.8, -0.56, -0.32, -0.08, 0.16, 0.4, 0.64, 0.86), rib=55, light=45, shade=80),
    "Jumpin Jack": dict(ribs=(-0.55, 0.0, 0.55), rib=75, light=50, shade=110),
    "Spooktacular": dict(ribs=(-0.62, -0.2, 0.2, 0.62), rib=65, light=65, shade=55, splatter=True),
    "Zombie": dict(ribs=(-0.62, -0.2, 0.2, 0.62), rib=60, light=40, shade=70, drips=True),
}
BLOOD = (0x7C, 0x06, 0x04, 255)
GOLD = (255, 214, 120, 170)


def texture(g, name):
    s = STYLES[name]
    rows = _body(g)
    top, bottom = min(rows), max(rows)
    cy, hh = (top + bottom) / 2, (bottom - top) / 2
    cells = [(0, 0, 0, 0)] * (N * N)

    def put(x, y, c):
        if y in rows and rows[y][0] <= x <= rows[y][1]:
            cells[y * N + x] = c

    for y, (x0, x1) in rows.items():
        cx, hw = (x0 + x1) / 2, (x1 - x0) / 2
        v = (y - cy) / hh
        for x in range(x0, x1 + 1):
            u = (x - cx) / hw
            # light from the upper left, shade on the lower right and along the bottom
            if (u + 0.5) ** 2 + (v + 0.38) ** 2 < 0.13:
                put(x, y, LIGHT(s["light"]))
            elif u * u + v * v > 0.6 and 0.7 * u + v > 0.3:  # a crescent along the lower right rim
                put(x, y, DARK(s["shade"]))
        # ribs: each one a fixed share of the row's half width, so they bow with the pumpkin
        last = None
        for r in s["ribs"]:
            x = round(cx + r * hw)
            if last is not None and x - last < 2:
                continue
            put(x, y, DARK(s["rib"]))
            last = x
    if s.get("glints"):
        for y, (x0, x1) in rows.items():
            cx, hw = (x0 + x1) / 2, (x1 - x0) / 2
            if -0.6 < (y - cy) / hh < 0.2:
                for r in s["ribs"]:
                    if (y + round(r * 10)) % 3 == 0:
                        put(round(cx + r * hw) - 1, y, GOLD)
    if s.get("drips"):
        # blood runs down from the top edge, all the way across
        lo, hi = min(r[0] for r in rows.values()), max(r[1] for r in rows.values())
        drips = (3, 6, 2, 8, 4, 9, 3, 7, 2, 5, 4)
        for i, length in enumerate(drips):
            x = lo + 2 + round(i * (hi - lo - 4) / (len(drips) - 1))
            col = [y for y, (x0, x1) in rows.items() if x0 <= x <= x1]
            if not col:
                continue
            y0 = min(col)
            for d in range(length + 1):
                put(x, y0 + d, BLOOD)
            if length > 3:  # a drop at the end
                put(x + 1, y0 + length - 1, BLOOD)
            put(x - 1, y0, BLOOD)
            put(x + 1, y0, BLOOD)
    if s.get("splatter"):
        for x, y in [(8, 20), (9, 21), (7, 22), (9, 23), (10, 22), (28, 27), (29, 26), (27, 28), (30, 28), (29, 29)]:
            put(x, y, BLOOD)
    return cells


def moon(cells, kind, colour, cx, cy, r, put):
    """full, gibbous, half, crescent (lit on the right), waning (thin, lit on the left)"""
    for y in range(N):
        for x in range(N):
            d = (x - cx) ** 2 + (y - cy) ** 2 <= r * r
            if not d:
                continue
            if kind == "gibbous" and (x - cx + r * 1.15) ** 2 + (y - cy) ** 2 <= (r * 0.95) ** 2:
                continue
            if kind == "half" and x < cx:
                continue
            if kind == "crescent" and (x - cx + 1.1) ** 2 + (y - cy + 0.7) ** 2 <= (r - 0.4) ** 2:
                continue
            if kind == "waning" and (x - cx - 1.0) ** 2 + (y - cy + 0.6) ** 2 <= (r - 0.5) ** 2:
                continue
            put(x, y, colour)


# ---------------------------------------------------------------- lit at night

DIM = 62  # percent: the pumpkin in the dark, so a lit face carries
WALL, EDGE, CORE = (0x8A, 0x3A, 0x05, 255), (0xFF, 0xB0, 0x2E, 255), (0xFF, 0xF0, 0xA8, 255)
GLOW = {WALL, EDGE, CORE}


def light(g):
    """Every pumpkin at night: its layers dim, and each carved hole (the black of an eye, nose or mouth layer;
    shades and masks are cut too) glows from inside, with the cut's top edge as a dark inner wall."""
    for key, cells in g["layers"].items():
        cat, value = key.split("/", 1)
        if cat == "Background":
            continue
        out = [(p[0] * DIM // 100, p[1] * DIM // 100, p[2] * DIM // 100, p[3]) if p[3] else tuple(p) for p in cells]
        if cat in ("Nose", "Mouth", "Eyes"):
            hole = {k for k, p in enumerate(cells) if p[3] == 255 and tuple(p[:3]) == (0, 0, 0)}
            inside = lambda y, x: 0 <= y < N and 0 <= x < N and y * N + x in hole
            for k in hole:
                y, x = divmod(k, N)
                if not inside(y - 1, x):
                    out[k] = WALL
                elif inside(y + 1, x) and inside(y, x + 1) and inside(y, x - 1):
                    out[k] = CORE
                else:
                    out[k] = EDGE
        g["layers"][key] = out
    return g


# ---------------------------------------------------------------- texture v2: lobes

import math

# shading overlays, warm so a shadow reads as pumpkin, not grey: deep shadow, shadow, light, highlight
TONES = {-2: (52, 12, 0, 100), -1: (70, 20, 0, 50), 1: (255, 236, 170, 36), 2: (255, 246, 210, 80)}  # (subtle)
LOBES = {
    "Jack-o-Lantern": dict(k=6),
    "Small Sugar": dict(k=8, groove=-2),
    "Harvest Moon": dict(k=4, soft=True),
    "Autumn Gold": dict(k=6, flecks=True),
    "Ghost Rider": dict(k=9, groove=-2, dusk=True),
    "Jumpin Jack": dict(k=5, warts=True),
    "Spooktacular": dict(k=6, splatter=True),
    "Zombie": dict(k=6, drips=True, mottle=True),
}


def texture2(g, name):
    """Each lobe lit in its middle and dark into its groove, the whole pumpkin lit from the upper left,
    a bright spot where the light lands, a darker base. The variety sets the lobes and the extras."""
    s = LOBES[name]
    rows = _body(g)
    top, bottom = min(rows), max(rows)
    cy, hh = (top + bottom) / 2, (bottom - top) / 2
    cells = [(0, 0, 0, 0)] * (N * N)
    tone = {}
    for y, (x0, x1) in rows.items():
        cx, hw = (x0 + x1) / 2, max(1.0, (x1 - x0) / 2)
        v = (y - cy) / hh
        for x in range(x0, x1 + 1):
            u = max(-1.0, min(1.0, (x - cx) / hw))
            w = (math.asin(u) + math.pi / 2) / math.pi * s["k"]  # lobes bunch up toward the sides, like a sphere
            t = w - math.floor(w)
            light = -0.6 * u - 0.4 * v  # the pumpkin is lit from the upper left
            # each lobe: a dark groove line, a light band on its lit side, a shade on its far side
            if t < 0.13 or t > 0.9:
                lvl = s.get("groove", -1)
            elif 0.2 < t < 0.45 and light > -0.15:
                lvl = 1
            elif t > 0.62 and light < 0.25:
                lvl = -1
            else:
                lvl = 0
            # the shadow side of the whole pumpkin, deepest at its rim
            if light < -0.55:
                lvl = min(lvl, -1) if light > -0.85 else -2
            if s.get("soft") and lvl == -2:
                lvl = -1
            if s.get("dusk"):
                lvl = max(-2, lvl - 1) if lvl <= 0 else 0
            if v > 0.82 or y - top < 1:
                lvl = min(lvl, -1)  # the base, and the cavity round the stem
            tone[(x, y)] = lvl
    # pixel art keeps no strays: a cell unlike all four neighbours takes the most common of them (twice over)
    for _ in range(2):
        fixed = dict(tone)
        for (x, y), lvl in tone.items():
            near = [tone.get(p) for p in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1))]
            near = [n for n in near if n is not None]
            if near and all(n != lvl for n in near):
                fixed[(x, y)] = max(set(near), key=near.count)
        tone = fixed
    # where the light lands
    for (x, y) in list(tone):
        cx = (rows[y][0] + rows[y][1]) / 2
        hw = max(1.0, (rows[y][1] - rows[y][0]) / 2)
        if ((x - cx) / hw + 0.42) ** 2 + ((y - cy) / hh + 0.48) ** 2 < 0.022:
            tone[(x, y)] = 2
    for (x, y), lvl in tone.items():
        if lvl:
            cells[y * N + x] = TONES[lvl]
    put = lambda x, y, c: cells.__setitem__(y * N + x, c) if (x, y) in tone else None
    if s.get("flecks"):
        for (x, y), lvl in tone.items():
            if lvl >= 0 and (x * 7 + y * 13) % 23 == 0:
                put(x, y, GOLD)
    if s.get("warts"):
        for x, y in [(9, 22), (27, 20), (13, 30), (24, 31), (19, 34), (8, 28), (29, 27)]:
            put(x, y, TONES[2])
            put(x, y + 1, TONES[-2])
    if s.get("mottle"):
        for x, y in [(10, 24), (11, 24), (10, 25), (26, 29), (27, 29), (27, 30), (20, 32), (21, 32), (15, 19)]:
            put(x, y, (30, 40, 10, 110))
    if s.get("splatter"):
        for x, y in [(8, 20), (9, 21), (7, 22), (9, 23), (10, 22), (28, 27), (29, 26), (27, 28), (30, 28), (29, 29)]:
            put(x, y, BLOOD)
    if s.get("drips"):
        lo, hi = min(r[0] for r in rows.values()), max(r[1] for r in rows.values())
        drips = (3, 6, 2, 8, 4, 9, 3, 7, 2, 5, 4)
        for i, length in enumerate(drips):
            x = lo + 2 + round(i * (hi - lo - 4) / (len(drips) - 1))
            col = [y for y, (x0, x1) in rows.items() if x0 <= x <= x1]
            if not col:
                continue
            y0 = min(col)
            for d in range(length + 1):
                put(x, y0 + d, BLOOD)
            if length > 3:
                put(x + 1, y0 + length - 1, BLOOD)
            put(x - 1, y0, BLOOD)
            put(x + 1, y0, BLOOD)
    return cells
