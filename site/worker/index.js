// taylor.fyi/cryptopunkins: the patch, as the game ended. Static files from ./dist (the page reads the game's final
// state from final.json, read off the chain once by freeze.mjs), /config.json for pages opened before, and link
// previews: ?p=<id> unfurls with that pumpkin's card as the game left it. The game's over, so nothing here asks the
// chain any more, and /rpc says so to any page still open from before.
// It has its own route, taylor.fyi/cryptopunkins*, so it takes the folder off itself (the page uses relative URLs).

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
      return Response.json({ chainId: 1, game: env.GAME, end: Number(env.END), from: Number(env.FROM_BLOCK || 0) }, { headers: { 'cache-control': 'public, max-age=86400' } });
    }
    if (url.pathname === '/rpc') return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'The game is over. Reload the page.' } }, { status: 410 });
    const res = await env.ASSETS.fetch(req);
    const id = Number(url.searchParams.get('p'));
    if (!(id >= 1 && id <= 1031) || !res.headers.get('content-type')?.includes('text/html')) return res;
    return preview(res, id, url, env);
  },
};

/// lookOf(id) -> (look, edition) as the game left it: 0 whole, 1 carving, 2 carved, 3 Great Pumpkin (null: never minted)
async function lookOf(id, url, env) {
  const f = await env.ASSETS.fetch(new Request(new URL('/final.json', url))).then((r) => (r.ok ? r.json() : null));
  const w = f?.words?.[id - 1];
  if (!w) return null;
  const word = BigInt(w);
  return { look: Number(word & 0xffn), edition: Number((word >> 8n) & 0xffffn) };
}

async function preview(res, id, url, env) {
  const l = await lookOf(id, url, env).catch(() => null);
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
