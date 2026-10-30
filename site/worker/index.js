// taylor.fyi/cryptopunkins: the patch. Static files from ./dist, plus /config.json, a read-only /rpc that only
// answers calls to the game (and ENS and the ETH price), and link previews: ?p=<id> unfurls with that pumpkin's card as it looks right now.
// It has its own route, taylor.fyi/cryptopunkins*, so it takes the folder off itself (the page uses relative URLs).

// (eth_estimateGas too: the page sizes each transaction's gas before the wallet sends it; like eth_call, only to the game)
// (eth_getTransactionByHash: waiting on a transaction, viem looks it up to follow a wallet's speed-up or cancel)
const READS = new Set(['eth_call', 'eth_estimateGas', 'eth_blockNumber', 'eth_chainId', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByNumber', 'eth_getLogs']);
const ENS = '0xeeeeeeee14d718c2b47d9923deab1335e144eeee'; // ENS's universal resolver: names for addresses
const ETH_USD = '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419'; // Chainlink's ETH/USD feed: the pot in dollars
const FEED_BLOCKS = 10_000; // the most the live feed reads in one go (public nodes cap log ranges near this)
// publicnode takes every read the page makes (measured 10-30: 9,000-block logs, batches of 10); drpc only small ones
// (no logs over a few hundred blocks, no batches of 10). ALCHEMY_URL, a secret, is the paid backup between them.
const PUBLICNODE = 'https://ethereum-rpc.publicnode.com', DRPC = 'https://eth.drpc.org';
const SITE = 'https://taylor.fyi/cryptopunkins/';
const BASE = '/cryptopunkins';

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === BASE) return Response.redirect(`${url.origin}${BASE}/${url.search}`, 301);
    if (url.pathname.startsWith(BASE + '/')) {
      url.pathname = url.pathname.slice(BASE.length);
      req = new Request(url, req);
    }
    if (url.pathname === '/config.json') {
      return Response.json({ chainId: 1, game: env.GAME, end: Number(env.END), from: Number(env.FROM_BLOCK || 0) }, { headers: { 'cache-control': 'public, max-age=60' } });
    }
    if (url.pathname === '/rpc' && req.method === 'POST') return rpc(req, env);
    const res = await env.ASSETS.fetch(req);
    const id = Number(url.searchParams.get('p'));
    if (!(id >= 1 && id <= 1031) || !res.headers.get('content-type')?.includes('text/html')) return res;
    return preview(res, id, env, ctx);
  },
};

async function rpc(req, env) {
  const body = await req.json().catch(() => null);
  const calls = Array.isArray(body) ? body : [body];
  const game = String(env.GAME).toLowerCase();
  const allowed = body && calls.length <= 20 && calls.every((c) =>
    READS.has(c?.method) && ((c.method !== 'eth_call' && c.method !== 'eth_estimateGas') || [game, ENS, ETH_USD].includes(String(c.params?.[0]?.to).toLowerCase()))
    && (c.method !== 'eth_getLogs' || gameLogs(c.params?.[0], game, Number(env.FROM_BLOCK || 0))));
  if (!allowed) return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Only reads of the game' } }, { status: 400 });
  const answers = await shared(calls, !Array.isArray(body), env);
  if (!answers) return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'The network is busy. Try again.' } }, { status: 502 });
  const out = calls.map((c, i) => ({ ...answers[i], id: c.id ?? null }));
  return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

/// Everyone watching asks for the same things at the same moments, so identical reads in flight go upstream once and
/// share the answer, and the block number is kept a second. Nothing else outlives its answer, so nobody sees older
/// state than they would asking alone, and a crowd at 8 PM looks like a handful of readers to the public nodes.
const flights = new Map();
let head = { at: 0, answers: null };

function shared(calls, single, env) {
  const key = (single ? 's' : 'b') + JSON.stringify(calls.map((c) => [c.method, c.params ?? []]));
  const isHead = single && calls[0].method === 'eth_blockNumber';
  if (isHead && Date.now() - head.at < 1000) return Promise.resolve(head.answers);
  let flight = flights.get(key);
  if (!flight) {
    const asked = calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params ?? [] }));
    flight = upstream(single ? asked[0] : asked, env).then((text) => {
      // (matched by id: a node may answer a batch in any order)
      const got = new Map((text ? [JSON.parse(text)].flat() : []).map((r) => [r?.id, r]));
      const answers = asked.map((a) => got.get(a.id));
      if (answers.some((r) => !r)) return null;
      if (isHead && answers[0].result) head = { at: Date.now(), answers };
      return answers;
    }).catch(() => null).finally(() => flights.delete(key));
    flights.set(key, flight);
  }
  return flight;
}

/// The live feed's reads: only the game's own events, a week or so at a time.
function gameLogs(f, game, since) {
  const a = Array.isArray(f?.address) ? (f.address.length === 1 ? f.address[0] : '') : f?.address;
  if (String(a).toLowerCase() !== game) return false;
  const from = /^0x[0-9a-f]+$/i.test(f.fromBlock) ? parseInt(f.fromBlock, 16) : null;
  const to = /^0x[0-9a-f]+$/i.test(f.toBlock) ? parseInt(f.toBlock, 16) : null;
  // (from the game's own deploy on: nothing older holds its events, and a full-history read is the costly kind)
  return from !== null && from >= since && (to === null ? f.toBlock === 'latest' : to - from <= FEED_BLOCKS);
}

async function upstream(body, env) {
  // (RPC_URL only for local play against a copy of mainnet)
  const nodes = env.RPC_URL ? [env.RPC_URL] : [PUBLICNODE, env.ALCHEMY_URL, DRPC].filter(Boolean);
  let last = null;
  for (const up of nodes) {
    try {
      const r = await fetch(up, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const text = await r.text();
      // a node that's busy, behind, or won't take the range says so in an error, and the next one gets a try;
      // a revert is a real answer
      if ([JSON.parse(text)].flat().some((a) => a?.error && !/revert/i.test(a.error.message))) { last = text; continue; }
      return text;
    } catch {}
  }
  return last;
}

/// lookOf(id) -> (look, edition): 0 whole, 1 carving, 2 carved, 3 Great Pumpkin. Kept 30 seconds at the edge.
async function lookOf(id, env, ctx) {
  const key = new Request(`https://cards.invalid/${env.GAME}/${id}`);
  const hit = await caches.default.match(key);
  if (hit) return hit.json();
  const data = '0xfa8bd61b' + id.toString(16).padStart(64, '0');
  const text = await upstream({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: env.GAME, data }, 'latest'] }, env);
  const hex = text && JSON.parse(text).result;
  if (!hex || hex.length < 130) return null;
  const out = { look: parseInt(hex.slice(2, 66), 16), edition: parseInt(hex.slice(66, 130), 16) };
  ctx.waitUntil(caches.default.put(key, new Response(JSON.stringify(out), { headers: { 'cache-control': 'public, max-age=30' } })));
  return out;
}

async function preview(res, id, env, ctx) {
  const l = await lookOf(id, env, ctx).catch(() => null);
  if (!l) return res;
  // (an uncut pumpkin's card is in its own colour, by the same sum the contract's renderer uses)
  const [card, title] = l.look === 2 ? [`${l.edition}`, `CryptoPunkin #${l.edition}`]
    : l.look === 3 ? ['great', `Great Pumpkin #${id}`]
    : [`whole-${((id * 2654435761) >>> 0) % 5}`, `Stab Pumpkin #${id}`];
  const image = `${SITE}cards/${card}.png`;
  const set = (v) => ({ element: (e) => e.setAttribute('content', v) });
  return new HTMLRewriter()
    .on('meta[property="og:image"]', set(image))
    .on('meta[property="og:image:alt"]', set(title))
    .on('meta[property="og:title"]', set(title))
    .on('meta[property="og:url"]', set(`${SITE}?p=${id}`))
    .transform(res);
}
