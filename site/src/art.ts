// Draws pumpkins from the same packed art the contract stores (tools/pack.py writes public/art.json).
// Cells are drawn 4px each and cropped to the contract's viewBox (0.25 0.5 37.5 37.5), so tiles match the NFT.

export type Art = {
  palette: [string, number][];
  layers: [number, number, number, number][][]; // y, x, length, colour
  cats: string[];
  values: Record<string, string[]>;
  layerOf: Record<string, number[]>;
  glowOf: Record<string, number[]>; // the Halloween glow drawn over each eye, nose and mouth (-1 none)
  editions: number[][];
  whole: number;
  wholeLit: number;
  great: number;
  dim: number; // percent the pumpkins dim to on Halloween
  // the patch page draws pumpkins without their sky (site only, never onchain)
  wholeSprite: number;
  wholeSpriteLit: number;
  greatSprite: number;
  colours: string[]; // Orange, Rust, Amber, Copper, Gold
  shades: string[][]; // every palette colour in each colour but Orange
};

export const WHOLE = 0, CARVING = 1, CARVED = 2, GREAT = 3;

let art: Art;
const cache = new Map<string, string>();
const S = 4;

export async function loadArt() {
  art = await (await fetch('art.json')).json();
  return art;
}

/// Every Oct 31 in New York (always UTC-4 that day) the pumpkins dim and their carved holes glow, as in the contract.
let forced: boolean | null = null;
export const forceLit = (v: boolean | null) => (forced = v);
export function halloween(now = Date.now()) {
  if (forced !== null) return forced;
  const d = new Date(now - 4 * 3600e3);
  return d.getUTCMonth() === 9 && d.getUTCDate() === 31;
}

/// What to draw, in order: [layer, dimmed]. Skips some categories (and their glow) when asked.
export type Draw = [number, boolean];
export function drawsFor(look: number, edition: number, lit = halloween(), skip: string[] = []): Draw[] {
  if (look === GREAT) return [[art.great, false]];
  if (look !== CARVED) return [[lit ? art.wholeLit : art.whole, false]];
  const v = art.editions[edition - 1];
  const out: Draw[] = [];
  art.cats.forEach((c, i) => {
    if (!v[i] || skip.includes(c)) return;
    out.push([art.layerOf[c][v[i] - 1], lit && c !== 'Background']);
    const glow = art.glowOf[c]?.[v[i] - 1] ?? -1;
    if (lit && glow >= 0) out.push([glow, false]);
  });
  return out;
}

// An uncut pumpkin's colour is set by its id, the same sum the contract's renderer does, so the patch shows the real
// thing: one of five oranges (the packer's table holds every palette colour in the four besides plain orange)
export const tintOf = (id: number) => ((id * 2654435761) >>> 0) % 5;
export const colourName = (id: number) => art.colours[tintOf(id)];
const shade = (k: number, hex: string, tint: number) => (tint ? art.shades[tint - 1][k] : hex);

const dimHex = (hex: string) =>
  '#' + [1, 3, 5].map((i) => Math.floor((parseInt(hex.slice(i, i + 2), 16) * art.dim) / 100).toString(16).padStart(2, '0')).join('');

/// A data URL for a pumpkin's picture, drawn once per look (and per Halloween or not) and kept.
export function picture(look: number, edition = 0, lit = halloween(), knife: Knife = '', tint = 0): string {
  const key = (look === CARVED ? `e${edition}` : look === GREAT ? 'great' : 'whole') + (lit ? '-lit' : '') + knife + (tint ? `t${tint}` : '');
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 150;
  const g = c.getContext('2d')!;
  for (const [l, dim] of drawsFor(look, edition, lit)) {
    for (const [y, x, n, k] of art.layers[l]) {
      const [hex, alpha] = art.palette[k];
      g.globalAlpha = alpha / 255;
      g.fillStyle = look !== CARVED && look !== GREAT ? shade(k, hex, tint) : dim ? dimHex(hex) : hex;
      g.fillRect(x * S - 1, y * S - 2, n * S, S);
    }
  }
  if (knife) paintKnife(g, look, knife, -1, -2);
  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

/// The traits of a carved edition, in the order they're drawn, for the pumpkin's sheet: each with how many of the
/// 1,031 share it, as a share of them.
export function traits(edition: number): [string, string, number][] {
  const v = art.editions[edition - 1];
  if (!counts) {
    counts = art.cats.map(() => new Map<number, number>());
    for (const e of art.editions) e.forEach((x, i) => x && counts![i].set(x, (counts![i].get(x) ?? 0) + 1));
  }
  return art.cats.flatMap((c, i) => (v[i] ? [[c, art.values[c][v[i] - 1], counts![i].get(v[i])! / art.editions.length] as [string, string, number]] : []))
    .filter(([c, val]) => !(c === 'Hair' && val === 'Invisible'));
}
let counts: Map<number, number>[] | null = null;

// ---------------------------------------------------------------- cells, for the carve

export const N = 38;
export type Cells = { rgb: [number, number, number][]; owner: string[] };

/// The picture as 38x38 cells, plus which category painted each cell last (Background, Pumpkin, Eyes...).
export function cells(draws: Draw[]): Cells {
  const catOf = new Map<number, string>();
  for (const c of art.cats) {
    art.layerOf[c].forEach((l) => catOf.set(l, c));
    art.glowOf[c]?.forEach((l) => l >= 0 && catOf.set(l, c));
  }
  const rgb: [number, number, number][] = Array.from({ length: N * N }, () => [0, 0, 0]);
  const owner: string[] = Array(N * N).fill('');
  for (const [l, dim] of draws) {
    const cat = catOf.get(l) ?? 'Scene';
    for (const [y, x, n, k] of art.layers[l]) {
      const [hex, alpha] = art.palette[k];
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).map((v) => (dim ? Math.floor((v * art.dim) / 100) : v));
      const a = alpha / 255;
      for (let i = 0; i < n; i++) {
        const j = y * N + x + i;
        rgb[j] = rgb[j].map((d, ch) => Math.round(c[ch] * a + d * (1 - a))) as [number, number, number];
        owner[j] = cat;
      }
    }
  }
  return { rgb, owner };
}



/// The Great Pumpkin with its glow all the way round, under it too (the art's own glow runs off the bottom of its
/// square): the pumpkin alone, then the glow's five rings redrawn evenly around its outline, and its sparkles.
export function haloSprite(): string {
  const hit = cache.get('halo');
  if (hit) return hit;
  const layer = art.layers[art.greatSprite];
  // the glow's rings, from the outline out, as the art colours them; everything else is the pumpkin or a sparkle
  const RINGS = ['#d9a441', '#a8703f', '#7a4b45', '#52304a', '#331d38'];
  const SPARKS = ['#f2bb4e', '#fff6d6'];
  const pad = RINGS.length, M = N + pad * 2;
  const body = new Uint8Array(M * M);
  for (const [y, x, n, k] of layer) {
    const hex = art.palette[k][0].toLowerCase();
    if (!RINGS.includes(hex) && !SPARKS.includes(hex)) for (let i = 0; i < n; i++) body[(y + pad) * M + x + pad + i] = 1;
  }
  const c = document.createElement('canvas');
  c.width = c.height = M * S;
  const g = c.getContext('2d')!;
  for (let y = 0; y < M; y++) {
    for (let x = 0; x < M; x++) {
      if (body[y * M + x]) continue;
      let d = pad + 1;
      for (let dy = -pad; dy <= pad; dy++) for (let dx = -pad; dx <= pad; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < M && xx >= 0 && xx < M && body[yy * M + xx]) d = Math.min(d, Math.max(Math.abs(dx), Math.abs(dy)));
      }
      if (d > pad) continue;
      g.fillStyle = RINGS[d - 1];
      g.fillRect(x * S, y * S, S, S);
    }
  }
  for (const [y, x, n, k] of layer) {
    const hex = art.palette[k][0].toLowerCase();
    if (RINGS.includes(hex)) continue;
    g.fillStyle = hex;
    g.fillRect((x + pad) * S, (y + pad) * S, n * S, S); // the pumpkin, then its sparkles over the rings
  }
  const url = c.toDataURL('image/png');
  cache.set('halo', url);
  return url;
}

/// A pumpkin with no sky, for the patch: it sits on the page's own night.
/// `solid` leaves out the see-through cells (the Great Pumpkin's glow), for a small picture that ends cleanly.
export function sprite(look: number, edition = 0, lit = halloween(), solid = false, knife: Knife = '', tint = 0): string {
  const key = 's' + (look === CARVED ? `e${edition}` : look === GREAT ? 'great' : 'whole') + (lit ? '-lit' : '') + (solid ? '-solid' : '') + knife + (tint ? `t${tint}` : '');
  const hit = cache.get(key);
  if (hit) return hit;
  const draws: Draw[] = look === GREAT ? [[art.greatSprite, false]]
    : look !== CARVED ? [[lit ? art.wholeSpriteLit : art.wholeSprite, false]]
    : drawsFor(CARVED, edition, lit, ['Background']);
  const c = document.createElement('canvas');
  c.width = c.height = 152;
  const g = c.getContext('2d')!;
  for (const [l, dim] of draws) {
    for (const [y, x, n, k] of art.layers[l]) {
      const [hex, alpha] = art.palette[k];
      if (solid && alpha < 255) continue;
      g.globalAlpha = alpha / 255;
      g.fillStyle = look !== CARVED && look !== GREAT ? shade(k, hex, tint) : dim ? dimHex(hex) : hex;
      g.fillRect(x * S, y * S, n * S, S);
    }
  }
  if (knife) paintKnife(g, look, knife, 0, 0);
  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

// ---------------------------------------------------------------- the knife in a pumpkin

/// A knife stabbed into the front of a pumpkin, in the art's own pixels: 45 degrees, handle up and to the right,
/// the blade going in at a dark gash. 'in' is stabbed; 'poised' is the same knife whole, hanging four pixels back,
/// about to go in.
export type Knife = '' | 'in' | 'poised';
// outlined in black like the pumpkins, so it reads as a knife even small: a white edge, steel, shade; a dark bolster;
// a wooden handle with two brass rivets
const O = '#000000', BLADE = [O, '#ffffff', '#c3ccd8', '#7d8899', O], WOOD = [O, '#a06a3a', '#6b3f1d', '#43250f', O];
function knifePixels(ex: number, ey: number, knife: Knife): [number, number, string][] {
  const out: [number, number, string][] = [];
  const back = knife === 'poised' ? 4 : 0;
  // s steps up and to the right from where it goes in; k runs across it, from the lit edge to the shaded one
  const at = (s: number, k: number, c: string) => out.push([ex + s + back + k, ey - s - back, c]);
  if (knife === 'poised') { // the tip, which goes in
    [O, '#ffffff', O].forEach((c, i) => at(-3, i - 1, c));
    [O, '#ffffff', '#c3ccd8', O].forEach((c, i) => at(-2, i - 2, c));
  }
  for (let s = knife === 'poised' ? -1 : 1; s <= 7; s++) BLADE.forEach((c, i) => at(s, i - 2, c));
  for (let k = -3; k <= 3; k++) at(8, k, Math.abs(k) === 3 ? O : '#3a3f4a');
  for (let s = 9; s <= 14; s++) WOOD.forEach((c, i) => at(s, i - 2, i === 2 && (s === 10 || s === 13) ? '#ffd27a' : c));
  for (let k = -2; k <= 2; k++) at(15, k, O);
  if (knife === 'in') { // the gash it went in at
    for (let k = -3; k <= 2; k++) out.push([ex + k, ey, '#140600']);
    for (let k = -2; k <= 1; k++) out.push([ex + k, ey + 1, '#5c2a0c']);
  }
  return out;
}
function paintKnife(g: CanvasRenderingContext2D, look: number, knife: Knife, ox: number, oy: number) {
  // into the middle of a whole one; into the cheek of a carved one, clear of its face
  const [ex, ey] = look === CARVED ? [20, 30] : [17, 26];
  g.globalAlpha = 1;
  for (const [x, y, c] of knifePixels(ex, ey, knife)) {
    g.fillStyle = c;
    g.fillRect(x * S + ox, y * S + oy, S, S);
  }
}
