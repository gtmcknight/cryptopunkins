// The chain side: config, reads through the Worker's /rpc, wallets (EIP-6963), and the writes (buy, carve, claim).
import {
  createPublicClient, createWalletClient, custom, getAddress, http, parseAbi, BaseError, ContractFunctionRevertedError,
  UserRejectedRequestError, type Address, type EIP1193Provider, type Hash, type WalletClient,
} from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

export const abi = parseAbi([
  'function buy(uint256 count) payable',
  'function carve(uint256 knife, uint256 target)',
  'function carveMany(uint256[] knives, uint256[] targets) returns (uint256)',
  'function settle(uint256 max)',
  'function patch(uint256 from, uint256 to) view returns (address[] owners, uint256[] words)',
  'function claim(uint256[] ids)',
  'function owed(uint256[] ids) view returns (uint256)',
  'function stats() view returns (uint256 sold, uint256 carved, uint256 whole, uint256 pending, uint256 salesEnd, uint256 end, uint256 pot, uint256 time)',
  'function lookOf(uint256 id) view returns (uint256 look, uint256 edition)',
  'event Bought(address indexed buyer, uint256 firstId, uint256 count)',
  'event Carving(uint256 indexed id, uint256 indexed knife, address indexed carver)',
  'event Claimed(uint256 indexed id, address indexed owner, uint256 amount)',
  'event Fed(address indexed from, uint256 amount)',
  'error Closed()', 'error TooMany()', 'error SoldOut()', 'error WrongPrice()', 'error NotYourKnife()',
  'error KnifeUsed()', 'error KnifeBroken()', 'error NotCarvingYet()', 'error NotWhole()', 'error TokenDoesNotExist()', 'error TooEarly()',
  'error NotYours()', 'error AlreadyPaid()', 'error NoShare()',
]);

export const PRICE = 6_660_000_000_000_000n; // 0.00666 ETH
export const PER_BUY = 10; // (no limit per wallet)

export type Config = { chainId: number; game: Address; end: number; from?: number; fork?: boolean }; // from: the game's deploy block
export let config: Config;
export let pub: ReturnType<typeof makePublic>;

// (batches of 10 at most: the Worker takes up to 20 calls a request)
const makePublic = () => createPublicClient({ chain: mainnet, transport: http('rpc', { batch: { batchSize: 10, wait: 16 }, retryCount: 2, retryDelay: 800 }) });

export async function loadConfig() {
  config = await (await fetch('config.json')).json();
  pub = makePublic();
  return config;
}

export type Pumpkin = {
  id: number; owner: Address; look: number; edition: number;
  knives: number; // left to use
  broken: boolean; // it was carved with knives left
  cuts: number[]; // what its knives carved
  carver: Address | null;
  paid: boolean; // paid all it's owed from the pot so far
};

export type Patch = { pumpkins: Pumpkin[]; sold: number; whole: number; salesEnd: number; end: number; pot: bigint; time: number };

export async function readPatch(): Promise<Patch> {
  // (in two halves: the whole patch in one read costs ~15M gas, near what some nodes allow a call)
  const [[o1, w1], [o2, w2], stats] = await Promise.all([
    pub.readContract({ address: config.game, abi, functionName: 'patch', args: [1n, 516n] }),
    pub.readContract({ address: config.game, abi, functionName: 'patch', args: [517n, 1031n] }),
    pub.readContract({ address: config.game, abi, functionName: 'stats' }),
  ]);
  const owners = [...o1, ...o2], words = [...w1, ...w2];
  const pumpkins = words.map((w, i) => {
    const carver = (w >> 48n) & ((1n << 160n) - 1n);
    return {
      id: i + 1,
      owner: owners[i],
      look: Number(w & 0xffn),
      edition: Number((w >> 8n) & 0xffffn),
      knives: Number((w >> 24n) & 0xffn),
      broken: ((w >> 232n) & 0xffn) === 1n,
      cuts: [Number((w >> 32n) & 0xffffn), Number((w >> 216n) & 0xffffn)].filter(Boolean),
      carver: carver ? getAddress('0x' + carver.toString(16).padStart(40, '0')) : null,
      paid: ((w >> 208n) & 0xffn) === 1n,
    };
  });
  return {
    pumpkins, sold: Number(stats[0]), whole: Number(stats[2]), salesEnd: Number(stats[4]), end: Number(stats[5]), pot: stats[6],
    time: Number(stats[7]),
  };
}

export type Happening = { block: bigint; index: number; kind: 'bought' | 'carving' | 'claimed' | 'fed'; who: Address; id: number; count: number; amount: bigint };

/// What happened in the patch between two blocks, for the live feed.
export async function readFeed(fromBlock: bigint, toBlock: bigint): Promise<Happening[]> {
  // (in windows public nodes accept)
  const logs = [];
  for (let a = fromBlock; a <= toBlock; a += 9_000n) {
    const b = a + 8_999n < toBlock ? a + 8_999n : toBlock;
    logs.push(...(await pub.getContractEvents({ address: config.game, abi, fromBlock: a, toBlock: b, strict: true })));
  }
  const out: Happening[] = [];
  for (const l of logs as { eventName: string; args: Record<string, unknown>; blockNumber: bigint; logIndex: number }[]) {
    const a = l.args;
    if (l.eventName === 'Bought') out.push({ block: l.blockNumber, index: l.logIndex, kind: 'bought', who: a.buyer as Address, id: Number(a.firstId), count: Number(a.count), amount: 0n });
    if (l.eventName === 'Carving') out.push({ block: l.blockNumber, index: l.logIndex, kind: 'carving', who: a.carver as Address, id: Number(a.id), count: 1, amount: 0n });
    if (l.eventName === 'Claimed') out.push({ block: l.blockNumber, index: l.logIndex, kind: 'claimed', who: a.owner as Address, id: Number(a.id), count: 1, amount: a.amount as bigint });
    if (l.eventName === 'Fed') out.push({ block: l.blockNumber, index: l.logIndex, kind: 'fed', who: a.from as Address, id: 0, count: 1, amount: a.amount as bigint });
  }
  // a wallet paid for several Great Pumpkins in one block is one line, with the total
  const paid = new Map<string, Happening>();
  return out.filter((h) => {
    if (h.kind !== 'claimed') return true;
    const key = `${h.block}:${h.who.toLowerCase()}`;
    const first = paid.get(key);
    if (first) first.amount += h.amount;
    else paid.set(key, h);
    return !first;
  });
}

// ---------------------------------------------------------------- wallets

type Announced = { info: { uuid: string; name: string; icon: string; rdns: string }; provider: EIP1193Provider };
export const wallets: Announced[] = [];
window.addEventListener('eip6963:announceProvider', (e: Event) => {
  const d = (e as CustomEvent<Announced>).detail;
  if (!wallets.some((w) => w.info.uuid === d.info.uuid)) wallets.push(d);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

export const session: { account?: Address; wallet?: WalletClient; provider?: EIP1193Provider } = {};
const listeners = new Set<() => void>();
export const onSession = (f: () => void) => listeners.add(f);
const emit = () => listeners.forEach((f) => f());

/// Local play only: ?dev=<key> signs with a test key against the copy of mainnet.
function devKey(): `0x${string}` | null {
  const k = new URLSearchParams(location.search).get('dev');
  return config.fork && k && /^0x[0-9a-fA-F]{64}$/.test(k) ? (k as `0x${string}`) : null;
}

export async function connect(w?: Announced) {
  const key = devKey();
  if (key) {
    const account = privateKeyToAccount(key);
    session.account = account.address;
    session.wallet = createWalletClient({ account, chain: mainnet, transport: http('rpc') });
    emit();
    return;
  }
  const provider = w?.provider ?? (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!provider) throw new Error('No wallet here. Open this page in your wallet app.');
  const [account] = (await provider.request({ method: 'eth_requestAccounts' })) as Address[];
  session.provider = provider;
  session.account = account;
  session.wallet = createWalletClient({ account, chain: mainnet, transport: custom(provider) });
  try { localStorage.setItem('punkins-wallet', w?.info.rdns ?? 'injected'); } catch {}
  provider.on?.('accountsChanged', (accs: Address[]) => {
    if (session.provider !== provider) return;
    session.account = accs[0];
    session.wallet = accs[0] ? createWalletClient({ account: accs[0], chain: mainnet, transport: custom(provider) }) : undefined;
    emit();
  });
  emit();
}

export function disconnect() {
  session.account = session.wallet = session.provider = undefined;
  try { localStorage.removeItem('punkins-wallet'); } catch {}
  emit();
}

/// Reconnect quietly if this wallet was connected before and still shares the account.
export async function restore() {
  if (devKey()) return connect();
  let saved: string | null = null;
  try { saved = localStorage.getItem('punkins-wallet'); } catch {}
  if (!saved) return;
  await new Promise((r) => setTimeout(r, 120)); // let wallets announce
  const w = wallets.find((x) => x.info.rdns === saved);
  const provider = w?.provider ?? (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  const accs = (await provider?.request({ method: 'eth_accounts' }).catch(() => [])) as Address[] | undefined;
  if (accs?.length) await connect(w);
}

async function onMainnet() {
  if (!session.provider) return;
  const id = Number(await session.provider.request({ method: 'eth_chainId' }));
  if (id === config.chainId) return;
  await session.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + config.chainId.toString(16) }] });
}

// ---------------------------------------------------------------- writes

const MESSAGES: Record<string, string> = {
  Closed: 'Too late: that just closed.',
  TooMany: `That's more than ${PER_BUY} at once.`,
  SoldOut: 'Sold out.',
  WrongPrice: "The price didn't match. Nothing was sent.",
  NotYourKnife: "That stab isn't yours.",
  KnifeUsed: 'That stab is already used.',
  KnifeBroken: 'Those stabs were lost when their pumpkin got carved.',
  NotCarvingYet: 'Carving opens at 8 PM (New York) on Halloween.',
  NotWhole: 'Someone carved it first.',
  TokenDoesNotExist: "That pumpkin isn't in the patch.",
  TooEarly: 'The pot opens at midnight on Halloween.',
  NotYours: "That pumpkin isn't in this wallet.",
  AlreadyPaid: 'Already paid.',
  NoShare: 'Only pumpkins still whole at midnight share the pot.',
};

export function plain(e: unknown): string {
  console.warn(e);
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof UserRejectedRequestError)) return 'Nothing was sent.';
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = revert?.data?.errorName;
    if (name && MESSAGES[name]) return MESSAGES[name];
    if (/insufficient funds/i.test(e.message)) return 'Not enough ETH for this plus gas.';
  }
  const m = (e as Error)?.message ?? '';
  if (/rejected|denied/i.test(m)) return 'Nothing was sent.';
  return 'That didn’t go through. Nothing was sent. Try again.';
}

/// Gas over the estimate for every transaction: a buy, carve or claim also finishes up to four carves from earlier
/// blocks, and in the 8 PM rush the estimate can't see the ones landing just ahead of it. Only what's used is paid.
const HEADROOM = 250_000n;
const MOST_GAS = 16_777_216n; // (what one transaction may use)

async function send(request: Parameters<WalletClient['writeContract']>[0]): Promise<Hash> {
  await onMainnet();
  // the wallet's own account (a local key signs itself; an injected wallet signs in its window)
  const account = session.wallet!.account ?? request.account;
  // (if the estimate can't be had, the wallet sizes the gas itself rather than the send failing)
  const estimate = await pub.estimateContractGas({ ...request, account } as never).catch(() => null);
  const gas = estimate === null ? undefined : estimate + HEADROOM < MOST_GAS ? estimate + HEADROOM : MOST_GAS;
  return session.wallet!.writeContract({ ...request, account, ...(gas ? { gas } : {}) } as never);
}

/// Simulates first so a rule the contract would refuse comes back as a plain sentence before the wallet opens.
export async function buy(count: number): Promise<Hash> {
  const value = PRICE * BigInt(count);
  const { request } = await pub.simulateContract({ address: config.game, abi, functionName: 'buy', args: [BigInt(count)], value, account: session.account! });
  return send(request as never);
}

export async function carve(knife: number, target: number): Promise<Hash> {
  const { request } = await pub.simulateContract({ address: config.game, abi, functionName: 'carve', args: [BigInt(knife), BigInt(target)], account: session.account! });
  return send(request as never);
}

/// All of a wallet's knives at once: `knives[i]` carves `targets[i]`, skipping any someone else got to first.
export async function carveMany(knives: number[], targets: number[]): Promise<Hash> {
  const { request } = await pub.simulateContract({ address: config.game, abi, functionName: 'carveMany', args: [knives.map(BigInt), targets.map(BigInt)], account: session.account! });
  return send(request as never);
}

/// Every share of the pot these pumpkins are owed, in one transaction.
export async function claim(ids: number[]): Promise<Hash> {
  const { request } = await pub.simulateContract({ address: config.game, abi, functionName: 'claim', args: [ids.map(BigInt)], account: session.account! });
  return send(request as never);
}

/// Waits for the transaction, giving up after `ms` so nothing spins forever.
export async function landed(hash: Hash, ms = 180_000) {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: ms, pollingInterval: 2_000 });
  if (r.status !== 'success') throw new Error('reverted');
  return r;
}

export const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);

// ENS names, looked up once per address and kept for the visit
const names = new Map<string, string | null>();
const asking = new Set<string>();
let onName = () => {};
export const onNames = (f: () => void) => (onName = f);
/// The name for an address if ENS has already answered, without asking.
export function knownName(a: string): string {
  const n = names.get(a.toLowerCase());
  return n ? (n.length > 18 ? n.slice(0, 15) + '…' : n) : short(a);
}

/// The address's ENS name if it has one (cut down if long), else the short address; asks ENS the first time.
export function walletName(a: string): string {
  const k = a.toLowerCase();
  const n = names.get(k);
  if (n) return n.length > 18 ? n.slice(0, 15) + '…' : n;
  if (n === undefined && !asking.has(k)) {
    asking.add(k);
    pub.getEnsName({ address: a as Address })
      .then((got) => { names.set(k, got ?? null); if (got) onName(); })
      .catch(() => names.set(k, null))
      .finally(() => asking.delete(k));
  }
  return short(a);
}
