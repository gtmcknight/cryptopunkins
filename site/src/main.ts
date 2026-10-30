import { loadArt, picture, sprite, haloSprite, tintOf, colourName, traits, forceLit, WHOLE, CARVING, CARVED, GREAT } from './art';
import { paintScenery, knifeCursor, KNIFE, STAKE, type Box } from './scene';
import { carveIn } from './carve';
import { wake, fx } from './sound';
import {
  loadConfig, config, readPatch, readFeed, wallets, session, onSession, connect, disconnect, restore, buy, carve, carveMany, claim, landed,
  plain, short, walletName, knownName, onNames, pub, abi, PRICE, PER_BUY, type Pumpkin, type Happening,
} from './chain';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const FOR_SALE = 1031; // (all of them: no twins, no airdrops)
const params = new URLSearchParams(location.search);

const state = {
  pumpkins: [] as Pumpkin[],
  sold: 0,
  whole: 0,
  pot: 0n,
  owed: 0n, // what this wallet can claim after midnight
  salesEnd: 0,
  end: 0,
  loaded: false,
  netDown: false,
  view: (params.get('view') as View) || 'all',
  count: 1,
  busy: false,
  open: Number(params.get('p')) || 0,
  // the pumpkin someone came to carve: connecting or buying a knife brings them back to it
  returnTo: 0,
  revealing: new Set<number>(),
  animating: 0, // the pumpkin whose carve is playing in the sheet
  justRevealed: 0,
  // a carve on its way: the target and what its button says, so a refresh mid-flight keeps it
  pending: null as null | { id: number; label: string },
};
type View = 'all' | 'whole' | 'carved' | 'yours';

const ethFmt = (wei: bigint, places = 6) => (Number(wei) / 1e18).toFixed(places).replace(/0+$/, '').replace(/\.$/, '');
// the chain's clock minus this device's, when they're more than a few blocks apart (a phone set wrong, a test chain)
let skew = 0;
const now = () => Date.now() / 1000 + skew;
const salesOver = () => state.salesEnd > 0 && now() >= state.salesEnd;
const closed = () => state.end > 0 && now() >= state.end; // carving's over and the whole ones are Great
const carving = () => salesOver() && !closed(); // 8\u00a0PM to midnight on Halloween
const isMe = (a: string | null) => !!a && !!session.account && a.toLowerCase() === session.account.toLowerCase();
const mine = (p: Pumpkin) => isMe(p.owner);
// (one with a knife in it already counts as carved, as it does for the pot)
const isWhole = (p: Pumpkin) => p.look === WHOLE || p.look === GREAT;
const myKnife = () => state.pumpkins.filter((p) => mine(p) && p.knives > 0).sort((a, b) => a.id - b.id)[0];
const canBuy = () => !salesOver() && state.sold < FOR_SALE;
const pot = () => state.pot;
const share = () => (state.whole ? pot() / BigInt(state.whole) : 0n);
// carving night in a calendar, so people come back for it
const calendar = () => {
  const t = (s: number) => new Date(s * 1000).toISOString().replace(/[-:]|\.\d{3}/g, '');
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent('Carving opens: CryptoPunkins')}`
    + `&dates=${t(state.salesEnd)}/${t(state.end)}&details=${encodeURIComponent(location.origin + location.pathname)}`;
};
// the pumpkins aimed at for 8\u00a0PM, kept in this browser only, so nobody sees them until you strike
let picked: number[] = [];
const pickKey = () => `punkin-picks:${config.game}`;
const loadPicks = () => { try { picked = JSON.parse(localStorage.getItem(pickKey()) || '[]'); } catch { picked = []; } };
const savePicks = () => { try { localStorage.setItem(pickKey(), JSON.stringify(picked)); } catch {} };
const knivesLeft = () => state.pumpkins.filter(mine).reduce((n, p) => n + p.knives, 0);
const livePicks = () => picked.filter((id) => { const p = state.pumpkins.find((x) => x.id === id); return !!p && isWhole(p) && !mine(p); });
// the Yours tab: your pumpkins, and the ones your knives are in (only you see those)
const yoursToo = (p: Pumpkin) => mine(p) || (!closed() && isWhole(p) && picked.includes(p.id));
// knives not yet stuck in a pumpkin; with one in hand, other pumpkins can be stabbed (from 8 PM, any knife carves)
const freeKnives = () => Math.max(0, knivesLeft() - livePicks().length);
const armed = () => !!session.account && !closed() && (carving() ? knivesLeft() > 0 : freeKnives() > 0);
// what this wallet takes from the pot after midnight: a share for each of its Great Pumpkins
const owed = () => (closed() ? state.pumpkins.filter((p) => mine(p) && !p.paid && p.look === GREAT) : []);
const nameOf = (p: Pumpkin) => (p.look === CARVED ? `CryptoPunkin #${p.edition}` : p.look === GREAT ? `Great Pumpkin #${p.id}` : `Pumpkin #${p.id}`);
const linkTo = (id: number) => `${location.origin}${location.pathname}?p=${id}`;
const xIntent = (text: string, url: string) => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
const SOON = 'Its face appears in about 12 seconds.';

function say(el: HTMLElement | null, text: string, bad = false) {
  if (!el) return;
  el.hidden = !text;
  el.textContent = text;
  el.classList.toggle('bad', bad);
}
const failure = (e: unknown) =>
  e instanceof Error && /timed out|timeout/i.test(e.message) ? 'Still waiting on the network. Check your wallet before trying again.' : plain(e);

// ---------------------------------------------------------------- the pot and the clock

// a moment on the visitor's own clock: "9 PM" (or "21:00" where clocks run to 24), and "Midnight" on the dot
function clockAt(ts: number) {
  const d = new Date(ts * 1000);
  if (!d.getHours() && !d.getMinutes()) return 'Midnight';
  const parts = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).formatToParts(d);
  const whole = !d.getMinutes() && parts.some((x) => x.type === 'dayPeriod'); // "9 PM", not "9:00 PM"
  return parts.filter((x, i) => !(whole && (x.type === 'minute' || parts[i + 1]?.type === 'minute'))).map((x) => x.value).join('').replace(/\s/g, '\u00a0');
}
// the day it falls on there: Halloween, or the weekday it has become
const dayOf = (ts: number) => {
  const d = new Date(ts * 1000);
  return d.getMonth() === 9 && d.getDate() === 31 ? 'Halloween' : d.toLocaleDateString('en-US', { weekday: 'long' });
};
// carving opens, and the night ends, on this visitor's clock (for the middle of a sentence)
const opens = () => clockAt(state.salesEnd);
// carving opens in New York, for a post anyone anywhere reads ("8 PM ET")
const opensET = () => `${new Date(state.salesEnd * 1000).toLocaleTimeString('en-US', { hour: 'numeric', timeZone: 'America/New_York' }).replace(/\s/g, '\u00a0')}\u00a0ET`;
const twelve = () => clockAt(state.end).replace('Midnight', 'midnight');

// the clock counts down to whatever closes next, and the page redraws as each thing closes
let stage = '';
function tick() {
  if (!state.end) return;
  const t = now();
  const next = t >= state.end ? 'over' : t >= state.salesEnd ? 'knives' : 'sales';
  if (stage && next !== stage) {
    stage = next;
    fx('bell');
    if (next === 'knives') document.body.insertAdjacentHTML('beforeend', '<div class="flash" aria-hidden="true"></div>');
    setTimeout(() => document.querySelector('.flash')?.remove(), 900);
    return render();
  }
  stage = next;
  // each step in the rules: the one happening now at full strength with its time left, the others faded, the ones
  // still to come with how long until they start
  const dur = (until: number) => {
    const left = Math.max(0, until - t);
    const d = Math.floor(left / 86400), h = Math.floor((left % 86400) / 3600), m = Math.floor((left % 3600) / 60), s = Math.floor(left % 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s}s`;
  };
  const order = ['sales', 'knives', 'over'];
  const starts: Record<string, number> = { knives: state.salesEnd, over: state.end };
  const ends: Record<string, number> = { sales: state.salesEnd, knives: state.end };
  const heads: Record<string, string> = { sales: `Until ${opens()} ${dayOf(state.salesEnd)}`, knives: opens(), over: clockAt(state.end) };
  for (const li of document.querySelectorAll<HTMLElement>('#how li[data-step]')) {
    const step = li.dataset.step!, at = order.indexOf(step), cur = order.indexOf(next);
    const b = li.querySelector('b')!;
    if (b.textContent !== heads[step]) b.textContent = heads[step];
    li.classList.toggle('off', at !== cur);
    li.querySelector('.when')!.textContent = at === cur ? (ends[step] ? `${dur(ends[step])} left` : '') : at > cur ? `in ${dur(starts[step])}` : '';
  }
}

// the pot's number rolls up when it grows, so a sale anywhere in the patch is felt
let shownPot = -1, rolling = 0;
function rollPot(to: number) {
  const from = shownPot;
  shownPot = to;
  cancelAnimationFrame(rolling);
  const show = (v: number) => ($('pot').textContent = `Pot ${v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} ETH`);
  if (from < 0 || to <= from || matchMedia('(prefers-reduced-motion: reduce)').matches) return show(to);
  const t0 = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / 700);
    show(from + (to - from) * (1 - Math.pow(1 - k, 3)));
    if (k < 1) rolling = requestAnimationFrame(step);
  };
  rolling = requestAnimationFrame(step);
}

function renderPot() {
  if (state.loaded) rollPot(Number(pot()) / 1e18); else $('pot').textContent = 'Pot';
  if (!state.loaded) return;
  // (no per-pumpkin split until midnight: before then everything is whole and it reads as less than you paid)
  $('potLine').textContent = closed() ? `${state.whole} Great Pumpkin${state.whole === 1 ? '' : 's'} · ${ethFmt(share(), 4)} ETH each`
    : carving() ? `${state.whole} uncut` : '';
}

// ---------------------------------------------------------------- buy

function renderBuy() {
  const btn = $('buy');
  $('item').hidden = $('supply').hidden = salesOver();
  $('qty').hidden = !canBuy();
  // the supply: how many of the 1,031 are left
  $('supplyFill').style.setProperty('--p', String(state.sold / FOR_SALE));
  $('supplyText').textContent = state.loaded ? `${(FOR_SALE - state.sold).toLocaleString()} of ${FOR_SALE.toLocaleString()} left` : '\u00a0';
  if (closed()) {
    const n = owed().length, paid = state.pumpkins.filter((p) => mine(p) && p.paid).length;
    btn.setAttribute('aria-disabled', String(!!session.account && !n));
    if (state.busy) return;
    btn.textContent = !session.account ? 'Connect to claim'
      : n ? `Claim ${ethFmt(state.owed)} ETH`
      : paid ? `Won ${ethFmt(share() * BigInt(paid))} ETH`
      : 'Nothing to claim in this wallet';
    return;
  }
  if (carving()) {
    // carving night: strike your picks with one click, or go find one
    const knives = knivesLeft(), n = Math.min(knives, livePicks().length);
    btn.setAttribute('aria-disabled', String(!knives));
    if (!state.busy) btn.textContent = !knives ? 'Minting has ended' : n ? `Stab your ${n}` : 'Pick one to stab';
    return;
  }
  renderCount();
  btn.setAttribute('aria-disabled', String(!canBuy()));
  if (state.busy) return;
  btn.textContent = salesOver() ? 'Minting has ended'
    : state.sold >= FOR_SALE ? 'Sold out'
    : `Mint ${state.count} for ${ethFmt(PRICE * BigInt(state.count))} ETH`;
}

// how many: up to ten a buy (or what's left), lit up to the count on the bar of ten
let dragging = false;
const most = () => Math.max(1, Math.min(PER_BUY, FOR_SALE - state.sold));
function renderCount() {
  const top = most(), n = (state.count = Math.max(1, Math.min(state.count, top)));
  const input = $('count') as HTMLInputElement;
  input.max = String(top);
  input.value = String(n);
  input.disabled = state.busy;
  input.setAttribute('aria-valuetext', `${n} pumpkin${n === 1 ? '' : 's'}`);
  $('qty').classList.toggle('busy', state.busy);
  if (!dragging) $('qty').style.setProperty('--n', String(n));
  $('slots').querySelectorAll('img').forEach((img, i) => { img.classList.toggle('on', i < n); img.classList.toggle('gone', i >= top); });
  $('kitHead').textContent = `${n} pumpkin NFT${n === 1 ? '' : 's'} + ${2 * n} stabs`; // (stabs, so nobody takes the knives for NFTs)
  $('kitLine').textContent = n === 1 ? 'Your shot at the pot' : 'Your shots at the pot';
}
function setCount(n: number) {
  n = Math.max(1, Math.min(n, most()));
  if (n === state.count || state.busy) return;
  state.count = n;
  fx('step', n);
  renderBuy();
}

async function onBuy() {
  const btn = $('buy'), msg = $('buyMsg');
  if (state.busy || !canBuy()) return;
  if (!session.account) return openConnect();
  state.busy = true;
  btn.classList.add('wait');
  btn.textContent = 'Confirm in your wallet';
  say(msg, '');
  try {
    const hash = await buy(state.count);
    btn.textContent = 'Minting…';
    await landed(hash);
    await refresh();
    state.busy = false;
    state.count = 1; // (the next buy starts from one again)
    btn.classList.remove('wait');
    renderBuy();
    const target = state.returnTo;
    state.returnTo = 0;
    const newest = Math.max(...state.pumpkins.filter(mine).map((p) => p.id));
    // watch it land: scroll to the new pumpkin, drop it in with a thunk, then open it (or the one they came to carve)
    const tile = document.querySelector<HTMLElement>(`.plant[data-id="${newest}"] img`);
    if (tile && !target && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      tile.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise((r) => setTimeout(r, 450));
      tile.classList.remove('drop');
      void tile.offsetWidth;
      tile.classList.add('drop');
      setTimeout(() => fx('plant'), 280);
      await new Promise((r) => setTimeout(r, 850));
    } else fx('plant');
    // came to carve someone's pumpkin: back to it with the new knife; otherwise, the new pumpkin to share
    openSheet(target || newest, !target);
  } catch (e) {
    state.busy = false;
    btn.classList.remove('wait');
    renderBuy();
    say(msg, failure(e), true);
  }
}

/// Holding stabs, a tap on someone else's whole pumpkin aims one at it and a tap on one you aimed at takes it back,
/// with no sheet: twenty stabs are twenty taps. Before 8 PM they wait for the night; from 8 PM, "Stab your N" sends
/// them all in one transaction. Anything else (yours, carved, no stab free) opens its sheet as before.
function quickAim(id: number): boolean {
  const p = state.pumpkins.find((x) => x.id === id);
  if (!p || !session.account || closed() || state.busy || state.pending || mine(p) || !isWhole(p)) return false;
  if (picked.includes(id)) picked = picked.filter((x) => x !== id);
  else {
    if ((carving() ? knivesLeft() - livePicks().length : freeKnives()) <= 0) return false;
    picked = [...livePicks(), id];
    fx('pick');
  }
  savePicks();
  renderPatch();
  renderKnives();
  renderBuy(); // (from 8 PM the stand's button counts them: "Stab your N")
  return true;
}

/// 8\u00a0PM, one tap: every knife you have on the pumpkins you aimed at, in one transaction.
async function onStrike() {
  const btn = $('buy'), msg = $('buyMsg');
  if (state.busy) return;
  if (!session.account) return openConnect();
  const knives: number[] = [];
  for (const p of state.pumpkins.filter(mine).sort((a, b) => a.id - b.id)) for (let i = 0; i < p.knives; i++) knives.push(p.id);
  const targets = livePicks().slice(0, knives.length);
  if (!targets.length) return hunt();
  state.busy = true;
  btn.classList.add('wait');
  say(msg, '');
  try {
    // a hundred stabs a transaction at most (each one is ~85k gas; a transaction holds 2^24)
    const pairs = targets.map((t, i) => [knives[i], t] as const);
    for (let i = 0; i < pairs.length; i += 100) {
      const part = pairs.slice(i, i + 100), of = Math.ceil(pairs.length / 100);
      btn.textContent = of > 1 ? `Confirm in your wallet (${i / 100 + 1} of ${of})` : 'Confirm in your wallet';
      const hash = await carveMany(part.map(([k]) => k), part.map(([, t]) => t));
      btn.textContent = 'Stabbing…';
      await landed(hash);
    }
    picked = [];
    savePicks();
    await refresh();
    say(msg, 'Stabbed. Faces appear in about 12 seconds.');
  } catch (e) {
    say(msg, failure(e), true);
  }
  state.busy = false;
  btn.classList.remove('wait');
  renderBuy();
}

/// To the patch, showing only what's still whole (where your knives go), or another of its tabs.
function hunt(view: View = 'whole') {
  state.view = view;
  const u = new URL(location.href);
  u.searchParams.set('view', view);
  history.replaceState(null, '', u);
  renderTabs();
  renderPatch();
  $('tabs').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/// After midnight the stand's button pays this wallet its share of the pot.
async function onClaim() {
  const btn = $('buy'), msg = $('buyMsg');
  if (state.busy) return;
  if (!session.account) return openConnect();
  const ids = owed().map((p) => p.id);
  if (!ids.length) return;
  state.busy = true;
  btn.classList.add('wait');
  say(msg, '');
  try {
    // two hundred a transaction at most, so a big holder's claim fits
    for (let i = 0; i < ids.length; i += 200) {
      const of = Math.ceil(ids.length / 200);
      btn.textContent = of > 1 ? `Confirm in your wallet (${i / 200 + 1} of ${of})` : 'Confirm in your wallet';
      const hash = await claim(ids.slice(i, i + 200));
      btn.textContent = 'Claiming…';
      await landed(hash);
    }
    await refresh();
    say(msg, 'Sent to your wallet.');
  } catch (e) {
    say(msg, failure(e), true);
  }
  state.busy = false;
  btn.classList.remove('wait');
  renderBuy();
}

// ---------------------------------------------------------------- the patch

function renderTabs() {
  const all = state.pumpkins;
  const n = (f: (p: Pumpkin) => boolean) => (state.loaded ? String(all.filter(f).length) : '');
  const tabs: [View, string, string][] = [
    ['all', 'All', ''],
    ['whole', closed() ? 'Great' : 'Uncut', n(isWhole)],
    ['carved', 'Carved', n((p) => !isWhole(p))],
  ];
  if (session.account) tabs.push(['yours', 'Yours', n(yoursToo)]);
  if (!tabs.some(([v]) => v === state.view)) state.view = 'all';
  $('tabs').innerHTML = tabs.map(([v, label, c]) =>
    `<a href="?view=${v}" data-view="${v}"${v === state.view ? ' aria-current="page"' : ''}>${label}${c ? ` <span>${c}</span>` : ''}</a>`).join('');
}

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const img = e.target as HTMLImageElement;
    img.src = img.dataset.src!;
    io.unobserve(img);
    // its owner's name is only asked for once the pumpkin is in view
    const p = state.pumpkins.find((x) => x.id === Number(img.closest<HTMLElement>('.plant')?.dataset.id));
    if (p && !mine(p)) walletName(p.owner);
  }
}, { rootMargin: '400px' });

function shown(): Pumpkin[] {
  const v = state.view;
  return state.pumpkins
    .filter((p) => v === 'all' || (v === 'whole' && isWhole(p)) || (v === 'carved' && !isWhole(p)) || (v === 'yours' && yoursToo(p)))
    .sort((a, b) => (v === 'yours' ? Number(mine(b)) - Number(mine(a)) : 0) || b.id - a.id); // newest first (yours: your own first)
}

// a fixed wobble per pumpkin, so the patch looks planted by hand and stays put between visits
const wobble = (id: number) => {
  const r = (k: number) => (((id * 2654435761 + k * 97) >>> 0) % 1000) / 1000;
  return { dx: `${Math.round((r(1) - 0.5) * 10)}px`, dy: `${Math.round((r(2) - 0.5) * 6)}px`, s: (0.88 + r(3) * 0.16).toFixed(3) };
};

function renderPatch() {
  const grid = $('patch');
  const empty = $('empty');
  const room = grid.parentElement!.clientWidth; // (not the patch's own width, which is set from this)
  const plantPx = Math.round(Math.max(84, Math.min(128, room / 7.5))); // the pumpkins grow with the screen
  const step = plantPx * 0.9;
  const cols = Math.max(3, Math.floor((room - step / 2) / step));
  grid.style.setProperty('--plant', `${plantPx}px`);
  if (!state.loaded) {
    // empty rows of soil at the final size while the patch loads
    if (!grid.children.length) grid.innerHTML = '<div class="row" aria-hidden="true"></div>'.repeat(4);
    empty.hidden = true;
    return;
  }
  const list = shown();
  empty.hidden = list.length > 0;
  empty.textContent = state.view === 'yours' ? 'No pumpkins yet. Mint one above.'
    : state.view === 'carved' ? 'Nothing carved yet.'
    : 'The patch is empty. Mint the first pumpkin.';
  const have = new Map([...grid.querySelectorAll<HTMLButtonElement>('.plant[data-id]')].map((t) => [Number(t.dataset.id), t]));
  const rows: HTMLElement[] = [];
  for (let i = 0; i < list.length; i += cols) {
    const row = document.createElement('div');
    row.className = 'row';
    if ((i / cols) % 2) row.style.setProperty('--inset', `${step / 2}px`); // every other row set in by half a pumpkin
    for (const p of list.slice(i, i + cols)) row.append(plant(p, have.get(p.id)));
    rows.push(row);
  }
  grid.replaceChildren(...rows);
  for (const p of state.pumpkins) seen.add(p.id);
  planted = true;
  grid.style.width = `${Math.min(list.length, cols) * step + step / 2}px`; // the patch sits centred
}

// the patch has drawn once: a pumpkin it hasn't seen before was just bought, and drops in (switching tabs doesn't count)
let planted = false;
const seen = new Set<number>();
function plant(p: Pumpkin, t?: HTMLButtonElement): HTMLButtonElement {
  // one being carved has a knife in it; one you've aimed at has yours hanging over it (only you see that one)
  const stabbed = p.look === CARVING || (!closed() && isWhole(p) && !mine(p) && picked.includes(p.id));
  const src = sprite(p.look, p.edition, undefined, false, p.look === CARVING ? 'in' : stabbed ? 'poised' : '', tintOf(p.id));
  if (!t) {
    t = document.createElement('button');
    t.className = 'plant';
    t.dataset.id = String(p.id);
    const img = document.createElement('img');
    img.width = img.height = 152;
    img.alt = '';
    img.dataset.src = src;
    const w = wobble(p.id);
    img.style.setProperty('--dx', w.dx);
    img.style.setProperty('--dy', w.dy);
    img.style.setProperty('--s', w.s);
    t.append(img);
    if (planted && !seen.has(p.id)) {
      img.src = src; // (no waiting for the lazy load, or it would drop in empty)
      img.classList.add('drop');
    } else io.observe(img);
  }
  const img = t.querySelector('img')!;
  if (img.dataset.src !== src) {
    img.dataset.src = src;
    if (img.getAttribute('src')) {
      img.src = src;
      img.classList.remove('fresh');
      void img.offsetWidth;
      img.classList.add('fresh');
    }
  }
  // your own get a stake with a tag; one being carved still has the knife in it
  // whose it is, under it (yours has its sign), and on carving night how many knives it still holds
  const pips = carving() && isWhole(p) ? '<i></i>'.repeat(p.knives) : '';
  const tag = mine(p) ? '' : `<span class="tag">${knownName(p.owner)}${pips}</span>`;
  const marks = (mine(p) ? STAKE : stabbed && p.look !== CARVING ? aimSign() : '') + tag;
  t.classList.toggle('target', !mine(p) && isWhole(p) && armed());
  if (t.dataset.marks !== marks) {
    t.querySelectorAll('.stake, .tag').forEach((m) => m.remove());
    t.insertAdjacentHTML('beforeend', marks);
    t.dataset.marks = marks;
  }
  t.setAttribute('aria-label', `${nameOf(p)}, ${p.look === CARVED ? 'carved' : p.look === GREAT ? 'Great Pumpkin' : p.look === CARVING ? 'being carved' : 'whole'}${mine(p) ? ', yours' : ''}`);
  return t;
}

// the sign on a pumpkin you've aimed at: when it gets stabbed (your 8 PM), or that it's time
const aimSign = () => `<span class="stake stabbed" aria-hidden="true">${carving() ? 'STAB' : opens().toUpperCase()}</span>`;

// your knives at the bottom of the screen whenever you hold one: how many, and what to do next. It steps aside only
// when it would cover the buy button, and on carving night (when that button says the same thing) whenever it shows
let buySeen = true, buyUnder = false;
function renderKnives() {
  const el = $('knives');
  const stabs = livePicks().length;
  const strike = carving() ? Math.min(knivesLeft(), stabs) : 0;
  const free = carving() ? knivesLeft() : freeKnives();
  const show = !!session.account && !closed() && !state.busy && (strike > 0 || free > 0 || stabs > 0) && !(carving() ? buySeen : buyUnder);
  el.hidden = !show;
  document.body.classList.toggle('armed', show);
  if (!show) return;
  el.classList.toggle('go', strike > 0);
  // before 9 with every knife aimed, it says what to do when you come back: tap this, here
  const text = strike ? `Stab your ${strike}`
    : free ? `${free} ${free === 1 ? 'stab' : 'stabs'} left · ${carving() ? 'Tap pumpkins to stab' : 'Tap pumpkins to aim'}`
    : `${stabs} aimed · Come back at ${opens()} to stab`;
  if ($('knivesText').textContent !== text) $('knivesText').textContent = text;
}

// ---------------------------------------------------------------- the pumpkin sheet

let shownHtml = '';
const sheetEl = () => $('sheet') as HTMLDialogElement;
// the tile a sheet was opened from, so it grows out of it
let origin: { x: number; y: number } | null = null;

function show(html: string, focusAct = true) {
  // only touch the DOM when the sheet's content changes, so focus, "Copied" and pending labels hold between blocks
  if (html === shownHtml) return;
  const active = (document.activeElement as HTMLElement | null)?.dataset?.act;
  shownHtml = html;
  $('sheetBody').innerHTML = html;
  if (active && focusAct) (document.querySelector(`#sheetBody [data-act="${active}"]`) as HTMLElement | null)?.focus();
  const d = sheetEl();
  if (!d.open) {
    d.showModal();
    d.focus(); // (the sheet itself, not its close button, so a click doesn't open it with a focus ring)
    const r = d.getBoundingClientRect();
    d.classList.toggle('fromTile', !!origin);
    d.style.transformOrigin = origin ? `${origin.x - r.left}px ${origin.y - r.top}px` : '';
  }
  origin = null;
}

function setUrl(id: number) {
  const u = new URL(location.href);
  if (id) u.searchParams.set('p', String(id)); else u.searchParams.delete('p');
  history.replaceState(null, '', u);
}

function openSheet(id: number, justBought = false) {
  state.open = id;
  setUrl(id);
  renderSheet(justBought);
}

function renderSheet(justBought = false) {
  const p = state.pumpkins.find((x) => x.id === state.open);
  if (!p) {
    show(state.loaded
      ? `<h2 id="sheetTitle">Not in the patch</h2><p class="note">There’s no pumpkin #${state.open} yet.</p>`
      : `<h2 id="sheetTitle">Pumpkin #${state.open}</h2><div class="art"></div><p class="note">Loading the patch…</p>`);
    return;
  }
  if (p.look === CARVED && state.revealing.has(p.id) && state.animating !== p.id) {
    state.revealing.delete(p.id);
    state.animating = p.id;
  }
  if (state.animating === p.id) return renderCarving(p);
  const yours = mine(p);
  // one line under the picture on who has it (and who carved it), its colour while it's uncut, and your stabs
  const who = (a: string | null) => `<b>${isMe(a) ? 'you' : a ? walletName(a) : ''}</b>`;
  const by: string[] = [];
  if (p.look === WHOLE || p.look === CARVING) by.push(colourName(p.id));
  if (p.look === CARVED) by.push(p.carver?.toLowerCase() === p.owner.toLowerCase() ? `Owned and carved by ${who(p.owner)}` : `Owned by ${who(p.owner)}, carved by ${who(p.carver)}`);
  else by.push(yours ? '<b>Yours</b>' : `owned by ${who(p.owner)}`);
  if (yours) {
    const on = p.cuts.map((c) => (c === p.id ? 'itself' : `#${c}`)).join(' and ');
    by.push(p.cuts.includes(p.id) ? `its stab used on ${on}` : p.broken ? (on ? `stabs lost after carving ${on}` : 'its stabs lost')
      : p.knives === 2 ? '2 stabs left' : p.knives === 1 ? `1 stab left, one used on ${on}` : `stabs used on ${on}`);
  }
  if (p.look === GREAT) by.push(`a ${ethFmt(share())} ETH share${p.paid ? ', paid' : ''}`);
  const byLine = by.join(' · ').replace(/^./, (c) => c.toUpperCase());
  // a carved one's traits, two to a row, each with how rare it is
  const pct = (f: number) => (f < 0.01 ? '<1%' : `${Math.round(f * 100)}%`);
  const traitList = p.look === CARVED ? traits(p.edition).map(([k, v, f]) => `<div><dt>${k}</dt><dd>${v}<small>${pct(f)}</small></dd></div>`).join('') : '';

  let note = '', actions = '', extra = '';
  let art: '' | 'pair' | 'poised' | 'in' = ''; // your knives in the picture: a pair beside your own, one over a target
  const knife = myKnife();
  // carving your own uses its own knife if it has one, so no other knife is spent
  const selfKnife = p.knives > 0 ? p : knife;
  const buyButton = `<button class="primary" data-act="buy">Mint a pumpkin for ${ethFmt(PRICE)} ETH</button>`;
  const due = owed();
  if (yours && due.some((x) => x.id === p.id)) {
    note = 'A Great Pumpkin, forever.';
    actions = `<button class="primary" data-act="claim">Claim ${ethFmt(state.owed)} ETH</button>`;
  } else if (p.look === WHOLE && !closed()) {
    if (state.pending?.id === p.id) {
      art = 'in';
      note = SOON;
      actions = `<button class="primary wait" data-act="carve">${state.pending.label}</button>`;
    } else if (yours) {
      // its face now, for one stab: say exactly what that costs before the wallet asks
      if (selfKnife) {
        const cost = p.knives === 2 ? 'Stab it yourself to see its face now. That uses up both its stabs, and it’s out of the pot.'
          : p.knives === 1 ? 'Stab it yourself to see its face now. That uses its last stab, and it’s out of the pot.'
          : `Stab it with one of #${selfKnife.id}’s stabs to see its face now. It’s out of the pot.`;
        extra = `<p class="note aside">Can’t wait? ${cost}</p><div class="actions"><button class="ghost" data-act="self">Reveal it now</button></div>`;
      }
      const post = `<a class="ghost" target="_blank" rel="noopener" href="${xIntent(`Still uncut. Carving opens at ${opensET()} on Halloween`, linkTo(p.id))}">Post</a>`;
      if (p.knives) art = 'pair';
      if (!carving() && freeKnives()) {
        // before 9, knives in hand: go stab someone's
        note = `${justBought ? 'It’s yours, with two stabs. ' : ''}Aim them at other pumpkins now, then come back at ${opens()} to stab.`;
        actions = `<button class="primary" data-act="hunt">Aim at a pumpkin</button>${post}`;
      } else if (!carving()) {
        note = `All your stabs are aimed. Come back at ${opens()} to stab.`;
        actions = `<a class="primary" target="_blank" rel="noopener" href="${calendar()}">Add ${opens()} to calendar</a>${post}`;
      } else if (p.knives) {
        // its knives are the clock: use them before someone carves this one and breaks them
        note = 'Stab before you get stabbed.';
        actions = `<button class="primary" data-act="hunt">Pick one to stab</button>${post}`;
      } else {
        note = `Uncut at ${twelve()}, it splits the pot.`;
        actions = `<button class="primary" data-act="copy">Copy link</button>${post}`;
      }
    } else if (!carving()) {
      // before 9: pick it now, strike at 9 with one click
      const cal = (cls: string) => `<a class="${cls}" target="_blank" rel="noopener" href="${calendar()}">Add ${opens()} to calendar</a>`;
      const isPicked = picked.includes(p.id);
      if (!knife) {
        note = canBuy() ? 'You need a stab. Every pumpkin you mint comes with two.' : `Carving opens at ${opens()}.`;
        actions = canBuy() ? buyButton : cal('primary');
      } else if (isPicked) {
        art = 'poised';
        note = `Aimed. Nothing happens yet: come back at ${opens()} and tap Stab. Only you can see your aim.`;
        actions = `${cal('primary')}<button class="ghost" data-act="unpick">Take it back</button>`;
      } else if (freeKnives()) {
        note = `Aim a stab at it now. At ${opens()}, come back and tap Stab to carve it. Only you can see your aim.`;
        actions = `<button class="primary" data-act="pick">Aim at it</button>`;
      } else {
        note = 'All your stabs are aimed. Take one back to move it.';
        actions = cal('primary');
      }
    } else if (session.account && !knife) {
      note = state.pumpkins.some(mine) ? 'No stabs left.' : 'Minting has ended.';
      actions = canBuy() ? buyButton : '';
    } else {
      art = picked.includes(p.id) ? 'in' : 'poised';
      note = `${knife ? `Uses a stab from #${knife.id}. ` : ''}${SOON}`;
      actions = `<button class="primary" data-act="carve">Stab it</button>`;
    }
  } else if (p.look === CARVING) {
    note = `Carving. ${SOON}`;
    if (isMe(p.carver)) actions = '<button class="primary wait" disabled>Carving…</button>';
  } else if (p.look === GREAT) {
    note = 'A Great Pumpkin, forever.';
  } else if (p.look === CARVED) {
    const line = isMe(p.carver) ? `I carved CryptoPunkin #${p.edition}` : yours ? `My pumpkin got carved: CryptoPunkin #${p.edition}` : `CryptoPunkin #${p.edition}`;
    // (no buy button here: nothing in the patch is for sale, only new pumpkins)
    actions = `<a class="${isMe(p.carver) || yours ? 'primary' : 'ghost'}" target="_blank" rel="noopener" href="${xIntent(line, linkTo(p.id))}">Post</a><button class="ghost" data-act="copy">Copy link</button>`;
  } else if (p.look === WHOLE && closed()) {
    note = 'The patch is closed.';
  }

  const reveal = state.justRevealed === p.id;
  if (reveal) state.justRevealed = 0;
  // every pumpkin, wherever it's at, ends its row of buttons with its page on OpenSea
  actions += `<a class="ghost" target="_blank" rel="noopener" href="https://opensea.io/assets/ethereum/${config.game}/${p.id}">OpenSea</a>`;
  show(`
    <h2 id="sheetTitle"${reveal ? ' class="swap"' : ''}>${nameOf(p)}</h2>
    <div class="art"><img alt="${nameOf(p)}" src="${picture(p.look, p.edition, undefined, art === 'pair' ? '' : art, tintOf(p.id))}">${art === 'pair' ? `<span class="pair">${KNIFE}${KNIFE}</span>` : ''}</div>
    <p class="by${reveal ? ' arrive' : ''}">${byLine}</p>
    ${traitList ? `<dl class="traits${reveal ? ' arrive' : ''}">${traitList}</dl>` : ''}
    <p class="note" id="sheetMsg" role="status"${note ? '' : ' hidden'}>${note}</p>
    <div class="actions${reveal ? ' arrive' : ''}">${actions}</div>${extra}`);
}

/// The carve plays in the sheet: same markup on every refresh while it runs, so nothing interrupts it.
function renderCarving(p: Pumpkin) {
  // the rows under the picture stay while it plays, so the sheet doesn't fold up and open again
  show(`<h2 id="sheetTitle">Pumpkin #${p.id}</h2><div class="art"><canvas class="carve" width="300" height="300"></canvas></div>
    <p class="by">${mine(p) ? 'Yours' : `Owned by <b>${walletName(p.owner)}</b>`}</p><p class="note" id="sheetMsg" role="status">Carving…</p>`);
  const cv = document.querySelector<HTMLCanvasElement>('#sheetBody canvas.carve');
  if (!cv || cv.dataset.started) return;
  cv.dataset.started = '1';
  fx('carve');
  carveIn(cv, p.edition, () => {
    fx('reveal');
    state.animating = 0;
    state.justRevealed = p.id;
    if (sheetEl().open && state.open === p.id) renderSheet();
  });
}

async function onSheetAction(act: string, btn: HTMLElement) {
  const p = state.pumpkins.find((x) => x.id === state.open);
  if (!p) return;
  if (act === 'copy') {
    const url = linkTo(p.id);
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = btn.dataset.label || 'Copy link'), 1600);
    } catch {
      say($('sheetMsg'), `Couldn’t copy. Here’s the link: ${url}`, true);
    }
    return;
  }
  if (act === 'hunt') {
    sheetEl().close();
    return hunt();
  }
  if (act === 'claim') {
    sheetEl().close();
    $('buy').focus();
    void onClaim();
    return;
  }
  if (act === 'buy') {
    if (p.look === WHOLE && !mine(p)) state.returnTo = p.id; // they came to carve this one
    sheetEl().close();
    $('buy').focus();
    void onBuy();
    return;
  }
  if (act === 'pick' || act === 'unpick') {
    if (act === 'pick') {
      fx('pick');
      const img = document.querySelector<HTMLImageElement>('#sheetBody .art img');
      if (img) img.src = picture(p.look, p.edition, undefined, 'poised', tintOf(p.id)); // (the knife comes up over it)
      await new Promise((r) => setTimeout(r, 200));
    }
    picked = act === 'pick' ? [...livePicks(), p.id] : picked.filter((id) => id !== p.id);
    savePicks();
    renderPatch();
    renderKnives();
    return renderSheet();
  }
  if (act === 'carve' || act === 'self') {
    if (!session.account) { state.returnTo = p.id; return openConnect(); }
    const knife = act === 'self' && p.knives > 0 ? p : myKnife();
    if (!knife || state.pending) return;
    const phase = (label: string) => { state.pending = { id: p.id, label }; renderSheet(); };
    phase('Confirm in your wallet');
    try {
      const hash = await carve(knife.id, p.id);
      phase('Carving…');
      await landed(hash);
      state.pending = null;
      await refresh();
    } catch (e) {
      state.pending = null;
      renderSheet();
      say($('sheetMsg'), failure(e), true);
    }
  }
}

// ---------------------------------------------------------------- connect

function openConnect() {
  state.open = 0;
  setUrl(0);
  const found = wallets.length
    ? wallets.map((w, i) => `<button class="walletRow" data-wallet="${i}"><img alt="" src="${w.info.icon}"><span>${w.info.name}</span></button>`).join('')
    : (window as unknown as { ethereum?: unknown }).ethereum ? `<button class="walletRow" data-wallet="-1"><span>Browser wallet</span></button>` : '';
  // the wallet app opens on the pumpkin they came to carve, not the bare patch
  const back = state.returnTo ? linkTo(state.returnTo) : location.href;
  const apps = found ? '' : `
    <p class="note">No wallet in this browser. Open the patch in your wallet app:</p>
    <a class="walletRow" href="https://metamask.app.link/dapp/${encodeURI(back.replace(/^https?:\/\//, ''))}">MetaMask</a>
    <a class="walletRow" href="https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(back)}">Coinbase Wallet</a>
    <a class="walletRow" href="https://rnbwapp.com/dapp?url=${encodeURIComponent(back)}">Rainbow</a>`;
  show(`<h2 id="sheetTitle">Connect a wallet</h2>${found}${apps}<p class="note" id="sheetMsg" role="status" hidden></p>`);
}

async function onWallet(btn: HTMLElement) {
  if (btn.classList.contains('wait')) return;
  const i = Number(btn.dataset.wallet);
  const rows = [...document.querySelectorAll<HTMLButtonElement>('#sheetBody .walletRow')];
  rows.forEach((r) => (r.disabled = r !== btn));
  btn.classList.add('wait');
  const label = btn.querySelector('span')!;
  const name = label.textContent;
  label.textContent = 'Confirm in your wallet';
  const slow = setTimeout(() => {
    rows.forEach((r) => (r.disabled = false));
    btn.classList.remove('wait');
    label.textContent = name;
    say($('sheetMsg'), 'Your wallet hasn’t answered. Open it to finish, or try again.', true);
  }, 30_000);
  try {
    await connect(i >= 0 ? wallets[i] : undefined);
    clearTimeout(slow);
    const back = state.returnTo;
    state.returnTo = 0;
    if (back) openSheet(back); else sheetEl().close();
  } catch (e) {
    clearTimeout(slow);
    rows.forEach((r) => (r.disabled = false));
    btn.classList.remove('wait');
    label.textContent = name;
    say($('sheetMsg'), plain(e), true);
  }
}

/// The whole game in one sheet, for anyone who wants every detail.
function openHelp() {
  state.open = 0;
  setUrl(0);
  show(`
    <h2 id="sheetTitle">How it works</h2>
    <ol class="rules">
      <li><b>Mint a pumpkin.</b> ${ethFmt(PRICE)} ETH, up to ${PER_BUY} at a time. Each pumpkin is an NFT and comes with two stabs. 90% of every mint goes in the pot, 10% to taylor.fyi. Minting ends at ${opens()} on ${dayOf(state.salesEnd)}.</li>
      <li><b>Aim your stabs.</b> Before ${opens()}, tap any pumpkin that isn’t yours to aim a stab at it, and tap again to take it back. Nothing happens yet, and only you can see your aims, in this browser.</li>
      <li><b>Come back at ${opens()} and stab.</b> One tap stabs every pumpkin you aimed at, and you can tap more to add them. Each stab carves one pumpkin. If yours gets carved before you use its stabs, they’re lost, so go early.</li>
      <li><b>See the face.</b> About 12 seconds after a carve, its face appears, chosen by the block, so nobody can pick it. To see yours sooner, stab it yourself any time. It leaves the pot.</li>
      <li><b>Survive the night.</b> Every pumpkin still uncut at ${twelve()} becomes a Great Pumpkin and splits the pot equally. After that, its share is sent to your wallet.</li>
    </ol>
    <p class="note">Times are on your own clock. If nothing survives, every pumpkin sold splits the pot. The art and the game are fully onchain, and every Oct 31 the pumpkins light up.</p>`);
}

function renderWallet() {
  const a = session.account;
  const n = a ? walletName(a) : '';
  $('wallet').innerHTML = !a ? 'Connect' : n !== short(a) ? `<span class="long">${n}</span><span class="short">${n}</span><span class="tiny">${n.slice(0, 8)}…</span>`
    : `<span class="long">${short(a)}</span><span class="short">${a.slice(0, 4)}…${a.slice(-4)}</span><span class="tiny">…${a.slice(-4)}</span>`;
}

// ---------------------------------------------------------------- data

let lastBlock = 0n;
async function refresh() {
  const before = new Map(state.pumpkins.map((p) => [p.id, p.look]));
  const { pumpkins, sold, whole, salesEnd, end, pot, time } = await readPatch();
  const d = time - Date.now() / 1000;
  skew = Math.abs(d) > 30 ? d : 0;
  state.pumpkins = pumpkins;
  state.sold = sold;
  state.whole = whole;
  state.pot = pot;
  state.salesEnd = salesEnd;
  state.end = end;
  state.loaded = true;
  if (state.netDown) { state.netDown = false; say($('buyMsg'), ''); }
  // a face that just landed (from whole or carving: a quick block can skip the carving state entirely)
  for (const p of pumpkins) {
    const was = before.get(p.id);
    if (was !== undefined && was !== CARVED && p.look === CARVED) state.revealing.add(p.id);
  }
  // after midnight, what this wallet's Great Pumpkins can claim (it grows if anything feeds the pot)
  const greats = owed().map((p) => BigInt(p.id));
  state.owed = greats.length ? await pub.readContract({ address: config.game, abi, functionName: 'owed', args: [greats] }) : 0n;
  render();
}

function render() {
  if (feed.length) renderFeed(); // (a face that just landed shows up in its line)
  renderWallet();
  renderPot();
  renderBuy();
  renderTabs();
  renderPatch();
  renderKnives();
  tick();
  if (sheetEl().open && state.open) renderSheet();
}

async function poll() {
  try {
    const b = await pub.getBlockNumber();
    if (b !== lastBlock) {
      lastBlock = b;
      await refresh();
      await follow(b);
    }
  } catch {}
}

// ---------------------------------------------------------------- the live feed

const feed: Happening[] = [];
let feedTo = -1n; // the last block the feed has read
const told = new Set<string>(); // lines already shown, so only new ones animate in

/// Reads what happened since the last look (the last week, the first time) and shows the newest few.
async function follow(latest: bigint) {
  // (from the game's first block, or the last day or so if the config doesn't say)
  const start = config.from ? BigInt(config.from) : latest > 9_000n ? latest - 9_000n : 0n;
  const from = feedTo < 0n ? start : feedTo + 1n;
  if (from > latest) return;
  const got = await readFeed(from, latest).catch(() => null);
  if (!got) return;
  feedTo = latest;
  feed.push(...got);
  feed.sort((a, b) => (a.block === b.block ? b.index - a.index : a.block > b.block ? -1 : 1));
  feed.splice(40);
  renderFeed();
}

function line(h: Happening) {
  const who = isMe(h.who) ? 'You' : walletName(h.who);
  if (h.kind === 'bought') return `${who} minted ${h.count === 1 ? 'a pumpkin' : `${h.count} pumpkins`}`;
  if (h.kind === 'claimed') return `${who} won ${ethFmt(h.amount, 4)} ETH`;
  if (h.kind === 'fed') return `${who} added ${ethFmt(h.amount, 4)} ETH to the pot`;
  const p = state.pumpkins.find((x) => x.id === h.id);
  const own = p && p.owner.toLowerCase() === h.who.toLowerCase();
  const face = p?.look === CARVED ? `: CryptoPunkin #${p.edition}` : '';
  return `${who} stabbed ${own ? (isMe(h.who) ? 'your own' : 'their own') : ''} #${h.id}${face}`.replace('  ', ' ');
}

// the ticker: the last dozen things that happened, newest first, and a new one slides in at the left
let tickerHtml = '';
function renderFeed() {
  // (back-to-back buys by one wallet read as one line: "bought 3 pumpkins")
  const shown: Happening[] = [];
  for (const h of feed) {
    const last = shown[shown.length - 1];
    if (last && h.kind === 'bought' && last.kind === 'bought' && last.who === h.who) shown[shown.length - 1] = { ...last, count: last.count + h.count };
    else if (shown.length < 12) shown.push(h);
  }
  const was = $('ticker').hidden;
  $('ticker').hidden = !shown.length;
  if (was !== $('ticker').hidden) scenery(); // (the ticker moves everything down: the hills and the bat's path follow)
  const html = shown.map((h, i) => {
    const fresh = told.size > 0 && !told.has(`${h.block}:${h.index}`) ? ' class="new"' : '';
    return i ? `<span${fresh}>${line(h)}</span>` : `<b${fresh}>${line(h)}</b>`;
  }).join('');
  if (html === tickerHtml) return fitTicker();
  tickerHtml = html;
  $('feed').innerHTML = html;
  fitTicker();
  for (const h of shown) told.add(`${h.block}:${h.index}`);
}

/// Only whole lines: one that would run off the edge isn't shown at all.
function fitTicker() {
  const run = $('feed'), room = run.parentElement!.clientWidth;
  for (const el of run.children as HTMLCollectionOf<HTMLElement>) el.hidden = false;
  for (const el of run.children as HTMLCollectionOf<HTMLElement>) el.hidden = el.offsetLeft + el.offsetWidth > room;
}

// ---------------------------------------------------------------- scenery

const boxOf = (r: DOMRect): Box => ({ x: r.left, y: r.top + scrollY, w: r.width, h: r.height });
/// The text in an element, line by line, so the sky can tell where the words end.
function lines(el: Element): Box[] {
  const out: Box[] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) if (r.width && r.height) out.push(boxOf(r));
  }
  return out;
}

function scenery() {
  const all = (s: string) => [...document.querySelectorAll(s)].map((e) => boxOf(e.getBoundingClientRect()));
  const head = lines(document.querySelector('h1')!), how = lines($('how'));
  const avoid = [...head, ...how, ...all('.how .ico, .tabs a, .mark, .tools, #act, #potBox')];
  paintScenery($('patch').getBoundingClientRect().top + scrollY + 24, avoid, $('moon') as HTMLCanvasElement);
}

/// The pictures beside the rules: a whole pumpkin, the knife, a Great Pumpkin.
function renderHow() {
  const icons = [`<img alt="" src="${sprite(WHOLE, 0)}">`, `<img alt="" src="${sprite(CARVED, 278, undefined, false, 'in')}">`, `<img class="halo" alt="" src="${haloSprite()}">`];
  document.querySelectorAll('#how .ico').forEach((el, i) => (el.innerHTML = icons[i]));
  $('kit').innerHTML = `${KNIFE}<img alt="" src="${sprite(WHOLE, 0)}">${KNIFE}`;
  $('knivesArt').innerHTML = KNIFE;
  $('slots').innerHTML = Array.from({ length: PER_BUY }, (_, k) => `<img alt="" style="--k:${k}" src="${sprite(WHOLE, 0)}">`).join('');
}

// ---------------------------------------------------------------- wiring

async function main() {
  scenery();
  await Promise.all([loadConfig(), loadArt()]);
  loadPicks();
  renderHow();
  // (local play only: ?lit=1 shows Halloween any day, ?lit=0 any day but it)
  if (config.fork && params.has('lit')) forceLit(params.get('lit') === '1');
  state.end = config.end;
  state.salesEnd = config.end - 4 * 3600; // (8 PM, until the contract says)
  render();
  onSession(() => { void refresh().catch(() => render()); });
  await restore().catch(() => {});
  try {
    await refresh();
  } catch {
    state.netDown = true;
    say($('buyMsg'), 'Can’t reach the network right now. Retrying…', true);
  }
  if (state.open) openSheet(state.open);
  void pub.getBlockNumber().then((b) => follow(b)).catch(() => {});
  scenery(); // the field's top is known now that the page has laid out
  setInterval(() => { if (!document.hidden) void poll(); }, 4000);
  setInterval(tick, 1000);
  let resize = 0;
  addEventListener('resize', () => { clearTimeout(resize); resize = window.setTimeout(() => { scenery(); renderPatch(); fitTicker(); }, 120); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });

  $('buy').addEventListener('click', () => void (closed() ? onClaim() : carving() ? (livePicks().length && knivesLeft() ? onStrike() : hunt()) : onBuy()));
  // the bar of ten: the handle follows a drag and settles on the nearest pumpkin; a tap jumps it there (a touch that
  // turns into a scroll puts the count back)
  const qty = $('qty'), countIn = $('count') as HTMLInputElement;
  let before = 1, downX = 0;
  const along = (e: PointerEvent) => {
    const r = qty.getBoundingClientRect(); // (pumpkin k sits 15px in plus k ninths of the rest, as in the CSS)
    const at = Math.max(1, Math.min(most(), 1 + ((e.clientX - r.left - 15) / (r.width - 30)) * (PER_BUY - 1)));
    if (dragging) qty.style.setProperty('--n', at.toFixed(3));
    setCount(Math.round(at));
  };
  const letGo = () => { dragging = false; qty.classList.remove('dragging'); renderBuy(); };
  qty.addEventListener('pointerdown', (e) => {
    if (state.busy) return;
    before = state.count;
    downX = e.clientX;
    qty.setPointerCapture(e.pointerId);
    along(e);
  });
  qty.addEventListener('pointermove', (e) => {
    if (!qty.hasPointerCapture(e.pointerId)) return;
    if (!dragging && Math.abs(e.clientX - downX) > 3) { dragging = true; qty.classList.add('dragging'); }
    along(e);
  });
  qty.addEventListener('pointerup', letGo);
  qty.addEventListener('pointercancel', () => { setCount(before); letGo(); });
  countIn.addEventListener('input', () => setCount(Number(countIn.value)));
  $('wallet').addEventListener('click', () => (session.account ? disconnect() : openConnect()));
  $('knives').addEventListener('click', () => void (carving() && livePicks().length && knivesLeft() ? onStrike()
    : !carving() && !freeKnives() && livePicks().length ? hunt('yours') : hunt()));
  new IntersectionObserver(([e]) => { buySeen = e.isIntersecting; renderKnives(); }).observe($('buy'));
  new IntersectionObserver(([e]) => { buyUnder = e.isIntersecting; renderKnives(); }, { rootMargin: '-90% 0px 0px 0px' }).observe($('buy')); // (the bar's strip)
  void knifeCursor().then((c) => document.documentElement.style.setProperty('--knife-cursor', c)).catch(() => {});
  $('howto').addEventListener('click', openHelp);
  // a name that just came back from ENS: redraw what shows addresses (once, however many land together)
  let naming = 0;
  onNames(() => { clearTimeout(naming); naming = window.setTimeout(() => { tickerHtml = ''; renderFeed(); renderWallet(); renderPatch(); if (sheetEl().open && state.open) renderSheet(); }, 150); });
  // the sounds wake with the first tap or key (caught on the way down, so the tap that wakes them can also play one)
  for (const kind of ['pointerdown', 'keydown'] as const) addEventListener(kind, wake, true);
  $('theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    scenery();
    try { localStorage.setItem('theme', next); } catch {}
    $('theme').setAttribute('aria-label', next === 'light' ? 'Switch to night' : 'Switch to day');
    document.querySelector('meta[name="theme-color"]')!.setAttribute('content', next === 'light' ? '#f5f0e6' : '#0b0e14');
  });
  $('tabs').addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a[data-view]') as HTMLAnchorElement | null;
    if (!a || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    state.view = a.dataset.view as View;
    const u = new URL(location.href);
    if (state.view === 'all') u.searchParams.delete('view'); else u.searchParams.set('view', state.view);
    history.replaceState(null, '', u);
    renderTabs();
    renderPatch();
  });
  $('patch').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('.plant[data-id]') as HTMLElement | null;
    if (!t) return;
    if (quickAim(Number(t.dataset.id))) return;
    const r = t.getBoundingClientRect();
    origin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    openSheet(Number(t.dataset.id));
  });
  const sheet = sheetEl();
  $('close').addEventListener('click', () => sheet.close());
  sheet.addEventListener('close', () => { state.open = 0; shownHtml = ''; setUrl(0); });
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) return sheet.close(); // the backdrop
    const btn = (e.target as HTMLElement).closest('[data-act],[data-wallet]') as HTMLElement | null;
    if (!btn) return;
    if (btn.dataset.wallet !== undefined) return void onWallet(btn);
    btn.dataset.label ||= btn.textContent || '';
    void onSheetAction(btn.dataset.act!, btn);
  });
  // (a copy of mainnet has no explorer page for its contract, so no link there)
  if (!config.fork) $('links').insertAdjacentHTML('afterbegin', `<a href="https://etherscan.io/address/${config.game}" target="_blank" rel="noopener">Contract</a>`);
}

void main();
