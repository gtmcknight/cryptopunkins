// The game's over: read its final state off the chain once, into site/public/final.json, which the page reads from then
// on instead of the chain. Every pumpkin's owner and packed word (as the contract's patch() gives them), the stats, the
// whole feed from the game's first block, the ETH price, and the ENS names of everyone in it.
//   cd site && node freeze.mjs
import fs from "node:fs";
import { createPublicClient, http, parseAbi } from "viem";
import { mainnet } from "viem/chains";

const vars = JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "")).vars;
const game = vars.GAME, from = BigInt(vars.FROM_BLOCK), end = Number(vars.END);
// (through the site's own read-only proxy, one last time: public nodes now call a week-old log read an archive request)
const pub = createPublicClient({ chain: mainnet, transport: http("https://taylor.fyi/cryptopunkins/rpc", { batch: { batchSize: 10 }, retryCount: 4, retryDelay: 1500 }) });
const abi = parseAbi([
  "function patch(uint256 from, uint256 to) view returns (address[] owners, uint256[] words)",
  "function stats() view returns (uint256 sold, uint256 carved, uint256 whole, uint256 pending, uint256 salesEnd, uint256 end, uint256 pot, uint256 time)",
  "event Bought(address indexed buyer, uint256 firstId, uint256 count)",
  "event Carving(uint256 indexed id, uint256 indexed knife, address indexed carver)",
  "event Claimed(uint256 indexed id, address indexed owner, uint256 amount)",
  "event Fed(address indexed from, uint256 amount)",
]);
const block = await pub.getBlockNumber();
const at = { blockNumber: block };
const [[o1, w1], [o2, w2], stats] = await Promise.all([
  pub.readContract({ address: game, abi, functionName: "patch", args: [1n, 516n], ...at }),
  pub.readContract({ address: game, abi, functionName: "patch", args: [517n, 1031n], ...at }),
  pub.readContract({ address: game, abi, functionName: "stats", ...at }),
]);
const logs = [];
for (let a = from; a <= block; a += 9000n) {
  const b = a + 8999n < block ? a + 8999n : block;
  logs.push(...(await pub.getContractEvents({ address: game, abi, fromBlock: a, toBlock: b, strict: true })));
}
const feed = logs.map((l) => {
  const a = l.args, base = { block: String(l.blockNumber), index: l.logIndex, tx: l.transactionHash };
  if (l.eventName === "Bought") return { ...base, kind: "bought", who: a.buyer, id: Number(a.firstId), count: Number(a.count), amount: "0" };
  if (l.eventName === "Carving") return { ...base, kind: "carving", who: a.carver, id: Number(a.id), count: 1, amount: "0" };
  if (l.eventName === "Claimed") return { ...base, kind: "claimed", who: a.owner, id: Number(a.id), count: 1, amount: String(a.amount) };
  return { ...base, kind: "fed", who: a.from, id: 0, count: 1, amount: String(a.amount) };
});
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);
const [, answer] = await pub.readContract({ address: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", abi: feedAbi, functionName: "latestRoundData", ...at });
const owners = [...o1, ...o2];
const everyone = [...new Set([...owners, ...feed.map((h) => h.who)].map((a) => a.toLowerCase()))];
const names = {};
for (let i = 0; i < everyone.length; i += 25) {
  const got = await Promise.all(everyone.slice(i, i + 25).map((a) => pub.getEnsName({ address: a }).catch(() => null)));
  got.forEach((n, k) => { if (n) names[everyone[i + k]] = n; });
}
const final = {
  at: new Date().toISOString(), block: String(block),
  config: { chainId: 1, game, end, from: Number(from) },
  owners, words: [...w1, ...w2].map((w) => "0x" + w.toString(16)), stats: stats.map(String),
  feed, usd: Number(answer) / 1e8, names,
};
fs.writeFileSync("public/final.json", JSON.stringify(final));
console.log(`final.json: block ${block}, ${owners.length} pumpkins, ${feed.length} happenings, ${Object.keys(names).length} names of ${everyone.length} people, ETH $${final.usd.toFixed(0)}, ${(fs.statSync("public/final.json").size / 1024).toFixed(0)} KB`);
