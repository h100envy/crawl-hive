// Операторы и бабл-карта для EVM-сетей (BNB Chain, Base, Robinhood Chain). Держатели и создатель — из GoPlus
// (топ-10, с пометкой контрактов: пулы, локеры и сожжённое на карту не попадают), снайперы — из трейса первых
// секунд. Связи — переводы самого токена между этими кошельками и от создателя: дев раздал монеты по кошелькам или
// держатели перекидывают их друг другу. История кошельков (кто пополнил газом) на EVM без индексатора недоступна,
// поэтому склейка по спонсору — только на Solana.
import "server-only";
import { createPublicClient, http, parseAbi, parseAbiItem, type Hex, type PublicClient } from "viem";
import { bubbleMap, type Operator, type OperatorReport, type Role } from "./scan-operators";
import type { SniperReport } from "./scan-snipers";
import { evmLogsRpc, evmOwnLogs } from "./scan-snipers-evm";

const GOPLUS_CHAIN: Record<string, number> = { bsc: 56, base: 8453, robinhood: 4663 };
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const DEAD = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead", "0xdead000000000000000000000000000000000000"]);
// Сколько блоков узел отдаёт за один запрос логов и сколько запросов тратим на скан.
const CHUNK: Record<string, bigint> = { robinhood: 100_000n };
const PUBLIC_DEPTH = 8_000n; // publicnode BNB/Base: глубже без ключа не отдаёт
const MAX_CHUNKS = 10;
const MAX_LOGS = 30_000;
const ERC20 = parseAbi(["function totalSupply() view returns (uint256)"]);
const CACHE_MS = 10 * 60_000;

const g = globalThis as unknown as { __crawlhiveEvmMap?: Map<string, { at: number; r: OperatorReport | null }> };
const cache = () => (g.__crawlhiveEvmMap ??= new Map());

export const evmMapSupported = (chain: string) => chain in GOPLUS_CHAIN;

interface Holder {
  address: string;
  pct: number;
}

async function goplus(chain: string, token: string): Promise<{ holders: Holder[]; creator?: string } | null> {
  const res = await fetch(`https://api.gopluslabs.io/api/v1/token_security/${GOPLUS_CHAIN[chain]}?contract_addresses=${token}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res?.ok) return null;
  const j = (await res.json().catch(() => null)) as {
    result?: Record<string, { holders?: { address: string; percent?: string; is_contract?: number }[]; creator_address?: string }>;
  } | null;
  const t = Object.values(j?.result ?? {})[0];
  if (!t) return null;
  const holders = (t.holders ?? [])
    .filter((h) => !h.is_contract && !DEAD.has(h.address.toLowerCase()))
    .map((h) => ({ address: h.address.toLowerCase(), pct: Math.round(Number(h.percent ?? 0) * 10_000) / 100 }))
    .filter((h) => h.pct > 0);
  return { holders, creator: t.creator_address?.toLowerCase() || undefined };
}

export async function buildEvmMap(chain: string, token: string, opts: { snipers?: SniperReport; pairCreatedAt?: number; pair?: string }): Promise<OperatorReport | undefined> {
  if (!evmMapSupported(chain)) return undefined;
  const key = `${chain}:${token.toLowerCase()}`;
  const hit = cache().get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.r ?? undefined;
  const r = await read(chain, token as Hex, opts).catch((e) => {
    console.error("[scan] evm map:", (e as Error).message);
    return null;
  });
  if (cache().size > 3000) cache().clear();
  cache().set(key, { at: Date.now(), r });
  return r ?? undefined;
}

// Окно логов: свой узел или Robinhood — от рождения пары вперёд, publicnode — только последние блоки.
async function logWindow(c: PublicClient, chain: string, pairCreatedAt?: number) {
  const head = await c.getBlockNumber();
  // Свой узел (dRPC и подобные) отдаёт до 10 000 блоков за запрос, publicnode — меньше.
  const chunk = CHUNK[chain] ?? (evmOwnLogs(chain) ? 9_999n : 5_000n);
  let from = head - PUBLIC_DEPTH;
  if (evmOwnLogs(chain) && pairCreatedAt) {
    const now = await c.getBlock();
    const past = await c.getBlock({ blockNumber: head - 10_000n });
    const blockSec = Number(now.timestamp - past.timestamp) / 10_000;
    from = head - BigInt(Math.ceil((Number(now.timestamp) - pairCreatedAt / 1000 + 600) / blockSec));
  }
  return { head, chunk, from: from < 0n ? 0n : from };
}

type TLog = { from: string; to: string; value: bigint; tx: Hex; block: bigint };

async function transfers(c: PublicClient, token: Hex, w: { head: bigint; chunk: bigint; from: bigint }, args?: { to: Hex[] }): Promise<TLog[]> {
  const out: TLog[] = [];
  // Ошибку страницы логов не глушим: пропущенная страница дала бы неверные балансы и связи. Временные сбои (429, 5xx)
  // повторяет транспорт viem; если страница так и не пришла (у Robinhood — «exceeds limit of 10000»), карту не строим.
  for (let b = w.from, n = 0; b <= w.head && n < MAX_CHUNKS && out.length < MAX_LOGS; b += w.chunk, n++) {
    const logs = await c.getLogs({ address: token, event: TRANSFER, ...(args ? { args } : {}), fromBlock: b, toBlock: b + w.chunk - 1n > w.head ? w.head : b + w.chunk - 1n });
    for (const l of logs) out.push({ from: (l.args.from ?? "").toLowerCase(), to: (l.args.to ?? "").toLowerCase(), value: l.args.value ?? 0n, tx: l.transactionHash, block: l.blockNumber });
  }
  return out;
}

// Держатели из переводов, когда GoPlus токен ещё не видит (свежие токены): балансы с момента выпуска, топ без контрактов.
async function holdersFromLogs(c: PublicClient, token: Hex, logs: TLog[], pair?: string): Promise<{ holders: Holder[]; creator?: string } | null> {
  const mint = logs.find((l) => DEAD.has(l.from));
  if (!mint) return null; // выпуск не попал в окно: балансы не восстановить
  const bal = new Map<string, bigint>();
  for (const l of logs) {
    bal.set(l.from, (bal.get(l.from) ?? 0n) - l.value);
    bal.set(l.to, (bal.get(l.to) ?? 0n) + l.value);
  }
  const supply = await c.readContract({ address: token, abi: ERC20, functionName: "totalSupply" }).catch(() => 0n);
  if (!supply) return null;
  const top = [...bal].filter(([w, v]) => v > 0n && !DEAD.has(w) && w !== pair && w !== token.toLowerCase()).sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 20);
  const codes = await Promise.all(top.map(([w]) => c.getCode({ address: w as Hex }).catch(() => undefined)));
  const holders = top
    .filter((_, i) => !codes[i] || codes[i] === "0x")
    .slice(0, 10)
    .map(([w, v]) => ({ address: w, pct: Number((v * 1_000_000n) / supply) / 10_000 }));
  const creator = (await c.getTransaction({ hash: mint.tx }).catch(() => null))?.from.toLowerCase();
  return { holders, creator };
}

async function read(chain: string, token: Hex, opts: { snipers?: SniperReport; pairCreatedAt?: number; pair?: string }): Promise<OperatorReport | null> {
  const pair = opts.pair?.toLowerCase();
  const url = evmLogsRpc(chain);
  const c = url ? (createPublicClient({ transport: http(url, { timeout: 12_000 }) }) as PublicClient) : undefined;
  let gp = await goplus(chain, token);
  let all: TLog[] | undefined;
  if (c && !gp?.holders.length) {
    all = await transfers(c, token, await logWindow(c, chain, opts.pairCreatedAt));
    gp = await holdersFromLogs(c, token, all, pair);
  }
  if (!gp) return null;
  const creator = gp.creator;
  const held = new Map<string, number>();
  const roles = new Map<string, Set<Role>>();
  const role = (w: string, r: Role) => roles.set(w, (roles.get(w) ?? new Set()).add(r));
  for (const h of gp.holders) if (h.address !== pair) held.set(h.address, h.pct);
  for (const b of opts.snipers?.buyers ?? []) {
    const w = b.wallet.toLowerCase();
    role(w, "sniper");
    if (!held.has(w)) held.set(w, b.leftPct);
  }
  if (creator) role(creator, "dev");
  const wallets = [...new Set([...held.keys(), ...(creator ? [creator] : [])])];
  if (wallets.length < 2) return null;

  // Все входящие переводы этим кошелькам: из них и связи внутри круга, и первые покупки.
  const inSet = new Set(wallets);
  const edges: [string, string][] = [];
  const logs = all ?? (c ? await transfers(c, token, await logWindow(c, chain, opts.pairCreatedAt), { to: wallets as Hex[] }) : []);
  for (const l of logs) if (l.from !== l.to && inSet.has(l.from) && inSet.has(l.to)) edges.push([l.to, l.from]);
  // Бандл, как его видят GMGN и другие: кошельки получили первые токены одной транзакцией или в одном блоке
  // почти одинаковыми суммами (до 2%) — это одна покупка, раскиданная по кошелькам.
  const first = new Map<string, TLog>();
  for (const l of logs) if (inSet.has(l.to) && !DEAD.has(l.from) && l.from !== l.to && !first.has(l.to)) first.set(l.to, l);
  const firsts = [...first.entries()];
  for (let i = 0; i < firsts.length; i++)
    for (let j = i + 1; j < firsts.length; j++) {
      const [wa, a] = firsts[i];
      const [wb, b] = firsts[j];
      const big = a.value > b.value ? a.value : b.value;
      const close = big > 0n && (a.value > b.value ? a.value - b.value : b.value - a.value) * 50n <= big;
      if (a.tx === b.tx || (a.block === b.block && close)) {
        edges.push([wb, wa]);
        role(wa, "bundle");
        role(wb, "bundle");
      }
    }

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  for (const [a, b] of edges) {
    parent.set(find(a), find(b));
    if (b === creator) role(a, "dev");
  }
  const groups = new Map<string, string[]>();
  for (const w of wallets) {
    const r = find(w);
    groups.set(r, [...(groups.get(r) ?? []), w]);
  }
  const ops: (Operator & { root: string })[] = [];
  for (const [root, ws] of groups) {
    const members = ws.filter((w) => held.has(w));
    const rs = new Set<Role>();
    for (const w of ws) for (const x of roles.get(w) ?? []) rs.add(x);
    if (members.length >= 2 && !rs.has("sniper")) rs.add("bundle");
    const devLinked = !!creator && ws.includes(creator);
    const pct = Math.round(members.reduce((a, w) => a + (held.get(w) ?? 0), 0) * 100) / 100;
    if ((members.length >= 2 || devLinked) && pct > 0) ops.push({ wallets: members.length, pct, roles: [...rs], devLinked, root });
  }
  ops.sort((a, b) => b.pct - a.pct);
  const devGroup = creator ? find(creator) : undefined;
  const devSnipers = (opts.snipers?.buyers ?? []).filter((b) => devGroup && find(b.wallet.toLowerCase()) === devGroup && b.wallet.toLowerCase() !== creator).length;
  const map = bubbleMap({ ops, held, roles, edges, find, creator });
  return { operators: ops.slice(0, 5).map((o) => ({ wallets: o.wallets, pct: o.pct, roles: o.roles, devLinked: o.devLinked })), devSnipers, ...(map ? { map } : {}) };
}
