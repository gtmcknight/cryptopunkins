// The patch's own scenery, drawn as pixel art at startup: the sky (stars, far hills), tonight's moon beside the pot,
// and the soil rows the pumpkins sit in. Each is a small canvas, most turned into a CSS background.

const px = (g: CanvasRenderingContext2D, x: number, y: number, c: string, w = 1, h = 1) => {
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
};
const canvas = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!] as const;
};
// a fixed shuffle, so the scenery is the same on every visit
const rand = (i: number) => (((i * 2654435761) >>> 0) % 10000) / 10000;

export type Box = { x: number; y: number; w: number; h: number };

type Theme = { sky: string[]; star: string; dim: string; moon: string; crater: string; far: string; soil: string[] };
const NIGHT: Theme = {
  sky: ['#0a0e1a', '#0d1222', '#11152a', '#161731'],
  star: '#c9d2e8', dim: '#5d6680', moon: '#efe6c8', crater: '#d3c8a4', far: '#13152b',
  soil: ['#21160f', '#2c1e14', '#18100b', '#3a2819'],
};
const DAY: Theme = {
  sky: ['#f6e3bf', '#f3dcb1', '#f0d3a3', '#edca95'],
  star: '', dim: '', moon: '#f7cf63', crater: '', far: '#d9b98a',
  soil: ['#8a6440', '#9a7149', '#77553a', '#ab8257'],
};

// a waxing crescent, lit on the right: the Halloween moon, whatever the sky is really doing
const phase = 0.16;

/// A pixel crescent (on the right while it waxes, the left as it wanes), with a few craters. By day, a plain sun.
function moon(g: CanvasRenderingContext2D, t: Theme, mx: number, my: number, r: number) {
  const sun = !t.star;
  const s = Math.max(1, Math.round(r / 5)); // crater size
  const craters = [[-2, -2], [1, 2], [-3, 1], [2, -3]].map(([x, y]) => [x * s, y * s]);
  for (let y = -r; y <= r; y++) {
    const half = Math.sqrt(Math.max(0, r * r + r * 0.8 - y * y));
    for (let x = -r; x <= r; x++) {
      if (x * x + y * y > r * r + r * 0.8) continue;
      const lit = sun || (phase < 0.5 ? x > half * Math.cos(2 * Math.PI * phase) : x < half * Math.cos(2 * Math.PI * (phase - 0.5)));
      const crater = !sun && craters.some(([cx, cy]) => x >= cx && x < cx + s && y >= cy && y < cy + s);
      if (lit) px(g, mx + x, my + y, crater ? t.crater : t.moon);
    }
  }
}

/// The sky across the top of the page, drawn at 3 screen pixels per pixel so stars stay square: bands of night
/// dithered into each other, small stars kept off every word and control (`avoid`), and two ridges of hills, the
/// near one the colour of the field.
const P = 3;
function sky(t: Theme, ground: string, cssW: number, cssH: number, avoid: Box[]) {
  const w = Math.ceil(cssW / P), h = Math.ceil(cssH / P);
  const [c, g] = canvas(w, h);
  const seam = (i: number) => Math.floor((i * h) / t.sky.length);
  t.sky.forEach((col, i) => px(g, 0, seam(i), col, w, seam(i + 1) - seam(i)));
  // a quarter, a half, then three quarters of the next band over each seam, so the sky shades instead of striping
  for (let i = 1; i < t.sky.length; i++) {
    const y = seam(i), col = t.sky[i];
    for (let x = 0; x < w; x++) {
      if (x % 4 === 0) px(g, x, y - 3, col);
      if (x % 2) px(g, x, y - 2, col);
      if (x % 4 !== 2) px(g, x, y - 1, col);
    }
  }
  const clear = (x: number, y: number, pad: number) =>
    avoid.every((b) => x < b.x - pad || x > b.x + b.w + pad || y < b.y - pad || y > b.y + b.h + pad);
  const twinkles: { x: number; y: number }[] = [];
  if (t.star) {
    const n = Math.round((w * h) / 1100);
    for (let i = 0; i < n; i++) {
      const x = Math.floor(rand(i) * w), y = Math.floor(rand(i + 999) * h * 0.82);
      if (!clear(x * P + 1, y * P + 1, 10)) continue;
      px(g, x, y, i % 4 ? t.dim : t.star);
      if (i % 12 === 0) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) px(g, x + dx, y + dy, t.dim);
      if (i % 3 === 0 && twinkles.length < 14) twinkles.push({ x: x * P, y: y * P }); // these few twinkle (see paintScenery)
    }
  }
  for (let x = 0; x < w; x++) {
    const far = 10 + Math.round(3 * Math.sin(x / 23 + 2) + 2 * Math.sin(x / 9));
    px(g, x, h - far, t.far, 1, far);
  }
  for (let x = 0; x < w; x++) {
    const near = 5 + Math.round(3 * Math.sin(x / 19) + 2 * Math.sin(x / 7 + 1));
    px(g, x, h - near, ground, 1, near);
  }
  return { url: c.toDataURL(), size: `${w * P}px ${h * P}px`, twinkles };
}

/// A strip of soil, tiled across under each row of pumpkins (deep enough that it never repeats down a row).
function soil(t: Theme) {
  const [c, g] = canvas(32, 24);
  px(g, 0, 0, t.soil[1], 32, 24);
  px(g, 0, 0, t.soil[3], 32, 1); // the lit top of the mound
  for (let i = 0; i < 52; i++) px(g, Math.floor(rand(i) * 32), 1 + Math.floor(rand(i + 77) * 23), i % 3 ? t.soil[2] : t.soil[0]);
  return c.toDataURL();
}

/// `horizon`: how far down the page the field starts, so the hills sit right behind the first row. `avoid` is in
/// page pixels. Also draws tonight's moon (by day, the sun) on `moon`, the canvas beside the pot.
export function paintScenery(horizon: number, avoid: Box[], moonCanvas: HTMLCanvasElement) {
  const t = document.documentElement.dataset.theme === 'light' ? DAY : NIGHT;
  const root = document.documentElement.style;
  const ground = getComputedStyle(document.documentElement).getPropertyValue('--ground').trim();
  const sk = sky(t, ground, innerWidth, horizon, avoid);
  const g = moonCanvas.getContext('2d')!;
  g.clearRect(0, 0, moonCanvas.width, moonCanvas.height);
  moon(g, t, 12, 12, t.star ? 10 : 9);
  // centre what's lit over its column (a crescent sits off to one side of its disk)
  const lit = g.getImageData(0, 0, moonCanvas.width, moonCanvas.height).data;
  let lo = moonCanvas.width, hi = 0;
  for (let i = 3; i < lit.length; i += 4) if (lit[i]) { const x = ((i - 3) / 4) % moonCanvas.width; lo = Math.min(lo, x); hi = Math.max(hi, x); }
  moonCanvas.style.translate = `${(((moonCanvas.width - lo - hi - 1) / 2 / moonCanvas.width) * 100).toFixed(2)}% 0`;
  root.setProperty('--sky-h', `${horizon}px`);
  root.setProperty('--sky', `url(${sk.url})`);
  root.setProperty('--sky-size', sk.size);
  root.setProperty('--soil', `url(${soil(t)})`);
  // the night moves a little: some stars twinkle, and now and then a bat crosses
  const skyEl = document.querySelector('.sky') as HTMLElement;
  skyEl.querySelectorAll('.tw').forEach((e) => e.remove());
  sk.twinkles.forEach((s, i) => {
    const e = document.createElement('i');
    e.className = 'tw';
    e.style.cssText = `left:${s.x}px;top:${s.y}px;animation-delay:${-(rand(i + 7) * 5).toFixed(2)}s;animation-duration:${(3 + rand(i + 3) * 3).toFixed(2)}s`;
    skyEl.append(e);
  });
  // the bat flies in front of the page, right across the moon
  const night = document.querySelector('.night') as HTMLElement;
  if (t.star && !night.querySelector('.bat')) night.insertAdjacentHTML('beforeend', BAT);
  if (!t.star) night.querySelector('.bat')?.remove();
  const m = moonCanvas.getBoundingClientRect();
  if (m.height) night.style.setProperty('--bat-y', `${m.top + scrollY + m.height / 2}px`);
}

/// A pixel bat, two frames of wing.
const BAT = `<span class="bat" aria-hidden="true"><svg viewBox="0 0 13 6" shape-rendering="crispEdges">
  <g class="up" fill="#05060a"><rect x="5" y="2" width="3" height="3"/><rect x="6" y="1" width="1" height="1"/><rect x="1" y="0" width="4" height="1"/><rect x="2" y="1" width="3" height="1"/><rect x="3" y="2" width="2" height="1"/><rect x="8" y="0" width="4" height="1"/><rect x="8" y="1" width="3" height="1"/><rect x="8" y="2" width="2" height="1"/></g>
  <g class="down" fill="#05060a"><rect x="5" y="1" width="3" height="3"/><rect x="6" y="0" width="1" height="1"/><rect x="1" y="4" width="4" height="1"/><rect x="2" y="3" width="3" height="1"/><rect x="3" y="2" width="2" height="1"/><rect x="8" y="4" width="4" height="1"/><rect x="8" y="3" width="3" height="1"/><rect x="8" y="2" width="2" height="1"/></g>
</svg></span>`;

/// A kitchen knife, blade up: steel with a bright edge, a dark bolster, a wooden handle with two brass rivets. It
/// stands by the pumpkin you buy, sits in one being carved, and is the cursor over one you can stab.
export const KNIFE = `<svg class="knife" viewBox="0 0 6 20" aria-hidden="true" shape-rendering="crispEdges">
  <rect x="1" y="1" width="1" height="11" fill="#4b5260"/><rect x="2" y="4" width="1" height="8" fill="#8b95a5"/>
  <rect x="2" y="2" width="1" height="2" fill="#c9d1dc"/><rect x="3" y="4" width="1" height="2" fill="#c9d1dc"/><rect x="3" y="6" width="2" height="6" fill="#c9d1dc"/>
  <rect x="1" y="0" width="1" height="1" fill="#f4f7fb"/><rect x="2" y="1" width="1" height="1" fill="#f4f7fb"/><rect x="3" y="2" width="1" height="2" fill="#f4f7fb"/><rect x="4" y="4" width="1" height="2" fill="#f4f7fb"/><rect x="5" y="6" width="1" height="6" fill="#f4f7fb"/>
  <rect x="0" y="12" width="6" height="1" fill="#2a2e36"/><rect x="1" y="13" width="4" height="6" fill="#5a3519"/><rect x="2" y="13" width="1" height="6" fill="#7a4a24"/>
  <rect x="2" y="14" width="2" height="1" fill="#d8b16a"/><rect x="2" y="17" width="2" height="1" fill="#d8b16a"/><rect x="1" y="19" width="4" height="1" fill="#2a2e36"/></svg>`;
/// The knife as the cursor over a pumpkin you can stab: blade down, its tip the hot spot, 2 screen pixels a pixel.
export async function knifeCursor() {
  const img = new Image();
  img.src = `data:image/svg+xml,${encodeURIComponent(KNIFE.replace('<svg class="knife"', '<svg xmlns="http://www.w3.org/2000/svg" width="6" height="20"'))}`;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 12;
  c.height = 40;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.translate(0, 40);
  g.scale(1, -1);
  g.drawImage(img, 0, 0, 12, 40);
  return `url(${c.toDataURL()}) 3 39, pointer`;
}

export const STAKE = `<span class="stake" aria-hidden="true">YOURS</span>`;
