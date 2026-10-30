// The carve: the one big moment. The whole pumpkin turns into its real colour, the knife cuts each eye, the nose and
// the mouth out piece by piece (bits fly), then the night sky dissolves into the punkin's own sky. About 2.5s.
import { cells, drawsFor, halloween, N, CARVED, WHOLE } from './art';

const FACE = ['Eyes', 'Nose', 'Mouth', 'Trick or Treat'];
const PX = 8; // canvas pixels per cell; the canvas is 300px, cropped like the contract's viewBox
const BODY: [number, number] = [120, 700];
const CARVE: [number, number] = [520, 1800];
const SKY: [number, number] = [1400, 2350];
const END = 2500;

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const clamp = (t: number) => Math.max(0, Math.min(1, t));
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const css = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;
// a fixed shuffle per cell, so the sky dissolves the same way every time
const noise = (j: number) => ((j * 2654435761) >>> 0) / 4294967296;

type Bit = { x: number; y: number; vx: number; vy: number; c: string; born: number };

/// The order the knife cuts: eyes, then nose, then mouth, each shape traced around its middle from the top.
function cutOrder(owner: string[]): number[] {
  const seen = new Set<number>();
  const shapes: { cat: number; cx: number; cy: number; cells: number[] }[] = [];
  for (let j = 0; j < N * N; j++) {
    const cat = FACE.indexOf(owner[j]);
    if (cat < 0 || seen.has(j)) continue;
    const shape: number[] = [];
    const stack = [j];
    seen.add(j);
    while (stack.length) {
      const k = stack.pop()!;
      shape.push(k);
      const y = Math.floor(k / N), x = k % N;
      for (const [dy, dx] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const yy = y + dy, xx = x + dx, kk = yy * N + xx;
        if (yy < 0 || yy >= N || xx < 0 || xx >= N || seen.has(kk) || owner[kk] !== owner[j]) continue;
        seen.add(kk);
        stack.push(kk);
      }
    }
    const cx = shape.reduce((s, k) => s + (k % N), 0) / shape.length;
    const cy = shape.reduce((s, k) => s + Math.floor(k / N), 0) / shape.length;
    shapes.push({ cat, cx, cy, cells: shape });
  }
  shapes.sort((a, b) => a.cat - b.cat || a.cx - b.cx);
  return shapes.flatMap((s) =>
    s.cells.sort((a, b) => angle(a, s) - angle(b, s)));
}
const angle = (k: number, s: { cx: number; cy: number }) =>
  (Math.atan2(Math.floor(k / N) - s.cy, (k % N) - s.cx) + Math.PI * 2.5) % (Math.PI * 2);

export function carveIn(canvas: HTMLCanvasElement, edition: number, done: () => void) {
  const g = canvas.getContext('2d')!;
  const lit = halloween(); // on Oct 31 the cuts open onto candlelight
  const from = cells(drawsFor(WHOLE, 0, lit)).rgb;
  const to = cells(drawsFor(CARVED, edition, lit));
  const plain = cells(drawsFor(CARVED, edition, lit, FACE)).rgb; // the finished pumpkin before any cut
  const draw = (j: number, c: number[]) => {
    g.fillStyle = css(c);
    g.fillRect((j % N) * PX - 2, Math.floor(j / N) * PX - 4, PX, PX);
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (let j = 0; j < N * N; j++) draw(j, to.rgb[j]);
    return done();
  }
  const order = cutOrder(to.owner);
  const cutAt = new Map(order.map((j, i) => [j, CARVE[0] + (i / Math.max(1, order.length)) * (CARVE[1] - CARVE[0])]));
  const bits: Bit[] = [];
  const spawned = new Set<number>();
  const start = performance.now();
  let last = start;

  const frame = (now: number) => {
    if (!canvas.isConnected) return done();
    const t = now - start;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    for (let j = 0; j < N * N; j++) {
      const y = Math.floor(j / N);
      const kind = FACE.includes(to.owner[j]) ? 'face' : to.owner[j] === 'Background' ? 'sky' : 'body';
      let c: number[];
      if (kind === 'sky') {
        const s = SKY[0] + (y / N) * 500 + noise(j) * 450;
        c = mix(from[j], to.rgb[j], easeOut(clamp((t - s) / 220)));
      } else {
        const s = BODY[0] + (y / N) * 300;
        c = mix(from[j], kind === 'face' ? plain[j] : to.rgb[j], easeOut(clamp((t - s) / 320)));
        if (kind === 'face') {
          const at = cutAt.get(j)!;
          if (t >= at) {
            // the cut: a white nick, then the carved pixel
            c = t - at < 50 ? [255, 255, 255] : to.rgb[j];
            if (!spawned.has(j)) {
              spawned.add(j);
              for (let b = 0; b < 2; b++) {
                bits.push({
                  x: (j % N) * PX + PX / 2 - 2, y: y * PX + PX / 2 - 4,
                  vx: (Math.random() - 0.5) * 160, vy: -60 - Math.random() * 120, c: css(plain[j]), born: t,
                });
              }
            }
          }
        }
      }
      draw(j, c);
    }
    // the bits the knife throws out
    for (const b of bits) {
      const age = (t - b.born) / 1000;
      if (age > 0.7) continue;
      b.vy += 520 * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      g.globalAlpha = 1 - age / 0.7;
      g.fillStyle = b.c;
      g.fillRect(b.x, b.y, 3, 3);
      g.globalAlpha = 1;
    }
    if (t < END) requestAnimationFrame(frame);
    else {
      for (let j = 0; j < N * N; j++) draw(j, to.rgb[j]);
      done();
    }
  };
  requestAnimationFrame(frame);
}
