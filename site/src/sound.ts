// The patch's sounds, made here with Web Audio: no music, only the moments that matter, in a dark hall. A knock when a
// pumpkin lands, a thunk for a stab, a low pluck creeping up for each step of the bar of ten, a slash for a carve, a
// music-box flourish for a face, a bell at 8 PM and midnight. They wake with the first tap or key on the page
// (browsers won't play anything before one).

let ctx: AudioContext | null = null;
let bus: Bus;

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/// The room the sounds play in: a limiter on the way out, a dark hall, and an echo.
function build(c: BaseAudioContext, dest: AudioNode) {
  const master = c.createGain();
  master.gain.value = 1;
  const limit = c.createDynamicsCompressor();
  limit.threshold.value = -8;
  limit.knee.value = 0;
  limit.ratio.value = 20;
  limit.attack.value = 0.003;
  limit.release.value = 0.25;
  master.connect(limit).connect(dest);
  // the hall: three seconds of dark, decaying noise
  const len = Math.floor(c.sampleRate * 3.2);
  const ir = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      lp += 0.22 * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.exp((-2.4 * i) / c.sampleRate);
    }
  }
  const hall = c.createConvolver();
  hall.buffer = ir;
  const room = c.createGain();
  const back = c.createGain();
  back.gain.value = 0.9;
  room.connect(hall).connect(back).connect(master);
  // a dark echo
  const echo = c.createGain();
  const delay = c.createDelay(1);
  delay.delayTime.value = 0.59;
  const fb = c.createGain();
  fb.gain.value = 0.3;
  const dark = c.createBiquadFilter();
  dark.type = 'lowpass';
  dark.frequency.value = 2200;
  echo.connect(delay).connect(dark).connect(fb).connect(delay);
  dark.connect(master);
  return { master, room, echo };
}
type Bus = { master: AudioNode; room: AudioNode; echo: AudioNode };

/// One tine of an old music box: a bright ping that's gone at once over a tone that rings and slowly sags flat.
function tine(c: BaseAudioContext, b: Bus, f: number, at: number, level: number, cents = 0, wet = 0.45) {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(level, at + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 2.4);
  const ring = 2.5;
  for (const [mult, amp, decay] of [[1, 1, ring], [2, 0.12, 0.8], [6.27, 0.22, 0.18]] as const) {
    if (f * mult > 15000) continue;
    const o = c.createOscillator();
    o.frequency.value = f * mult;
    o.detune.setValueAtTime(cents, at);
    o.detune.linearRampToValueAtTime(cents - 9, at + ring);
    const a = c.createGain();
    a.gain.setValueAtTime(amp, at);
    a.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    o.connect(a).connect(g);
    o.start(at);
    o.stop(at + ring + 0.05);
  }
  g.connect(b.master);
  const w = c.createGain();
  w.gain.value = wet;
  g.connect(w).connect(b.room);
  const e = c.createGain();
  e.gain.value = 0.18;
  g.connect(e).connect(b.echo);
}

// ---------------------------------------------------------------- the effects

type Fx = 'plant' | 'pick' | 'step' | 'carve' | 'reveal' | 'bell';
/// A low, muted pluck that thuds and dies: each step of the bar of ten, creeping up a semitone at a time from A.
function pluck(c: BaseAudioContext, b: Bus, f: number, at: number) {
  const o = c.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(f * 1.03, at);
  o.frequency.exponentialRampToValueAtTime(f, at + 0.05);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 700;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(0.16, at + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
  o.connect(lp).connect(g).connect(b.master);
  const w = c.createGain();
  w.gain.value = 0.25;
  g.connect(w).connect(b.room);
  o.start(at);
  o.stop(at + 0.35);
}
function effect(c: BaseAudioContext, b: Bus, kind: Fx, t: number, n = 1) {
  if (kind === 'plant') {
    // a soft knock as it settles in the soil, and a tine
    const o = c.createOscillator();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(80, t + 0.16);
    const g = c.createGain();
    g.gain.setValueAtTime(0.28, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g).connect(b.master);
    o.start(t);
    o.stop(t + 0.22);
    tine(c, b, hz(76), t + 0.06, 0.05);
  }
  if (kind === 'pick') {
    // a stab: the blade going in, and a dull thunk
    const len = Math.floor(c.sampleRate * 0.08);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const s = c.createBufferSource();
    s.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 1.5;
    const sg = c.createGain();
    sg.gain.value = 0.12;
    s.connect(bp).connect(sg).connect(b.master);
    s.start(t);
    const o = c.createOscillator();
    o.frequency.setValueAtTime(110, t + 0.02);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.18);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    o.connect(g).connect(b.master);
    o.start(t + 0.02);
    o.stop(t + 0.26);
  }
  if (kind === 'step') pluck(c, b, hz(44 + Math.min(n, 10)), t); // A2 for one, up to F#3 for ten
  if (kind === 'carve') {
    // the knife: a short swish, then a low tine and a B flat rubbing against it
    const len = Math.floor(c.sampleRate * 0.22);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const s = c.createBufferSource();
    s.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(2600, t);
    bp.frequency.exponentialRampToValueAtTime(700, t + 0.2);
    const g = c.createGain();
    g.gain.value = 0.14;
    s.connect(bp).connect(g).connect(b.master);
    s.start(t);
    tine(c, b, hz(57), t + 0.12, 0.07);
    tine(c, b, hz(70), t + 0.12, 0.03);
  }
  if (kind === 'reveal') {
    // a face: the music box runs up A minor and lets it ring
    [69, 72, 76, 81].forEach((m, i) => tine(c, b, hz(m), t + i * 0.09, 0.06, 0, 0.6));
  }
  if (kind === 'bell') {
    // a bell tolls on A, long, in the hall, with the open fifth rising under it
    for (const [m, a, len] of [[1, 0.09, 7], [2, 0.05, 5], [2.76, 0.03, 3.5], [4.07, 0.02, 2.5], [5.4, 0.012, 1.8]] as const) {
      const o = c.createOscillator();
      o.frequency.value = 110 * m;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(a, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g);
      g.connect(b.master);
      const w = c.createGain();
      w.gain.value = 0.8;
      g.connect(w).connect(b.room);
      o.start(t);
      o.stop(t + len + 0.05);
    }
    for (const f of [55, 82.41]) {
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t + 0.1);
      g.gain.linearRampToValueAtTime(0.04, t + 0.8);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 6);
      o.connect(g).connect(b.master);
      o.start(t + 0.1);
      o.stop(t + 6.1);
    }
  }
}

/// Wakes the sound on a tap or key (browsers keep it asleep until one); after that it's a no-op.
export function wake() {
  if (!ctx) {
    ctx = new AudioContext();
    bus = build(ctx, ctx.destination);
  }
  if (ctx.state !== 'running') void ctx.resume();
}

export function fx(kind: Fx, n?: number) {
  if (!ctx || ctx.state !== 'running') return;
  effect(ctx, bus, kind, ctx.currentTime, n);
}
