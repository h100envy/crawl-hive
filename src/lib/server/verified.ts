// Проверенные токены: списки Jupiter (verified) и CoinGecko. Адрес у каждого токена свой, поэтому подделка
// всегда живёт по другому адресу, но с тем же тикером и похожим именем. FDV и ликвидность на DexScreener
// подделка накручивает легко, а попасть в эти списки — нет: по ним и решаем, кто оригинал.
import "server-only";

export interface ListedToken {
  chain: string; // chainId DexScreener
  address: string;
  symbol: string;
  name: string;
  mcap?: number; // только у Jupiter
  source: "Core" | "Jupiter" | "CoinGecko";
}

const SOURCES: { chain: string; source: "Jupiter" | "CoinGecko"; url: string }[] = [
  { chain: "solana", source: "Jupiter", url: "https://lite-api.jup.ag/tokens/v2/tag?query=verified" },
  { chain: "solana", source: "CoinGecko", url: "https://tokens.coingecko.com/solana/all.json" },
  { chain: "bsc", source: "CoinGecko", url: "https://tokens.coingecko.com/binance-smart-chain/all.json" },
];
const TTL_MS = 12 * 3600_000;
const RETRY_MS = 10 * 60_000; // список не загрузился — повторяем не чаще, чем раз в 10 минут

// Базовые активы сканера (USDC, USDT, WBNB…) — оригиналы при любых списках, даже если те не загрузились.
const pinned: ListedToken[] = [];
export function pinCore(tokens: { chain: string; address: string; symbol: string; name: string }[]) {
  for (const t of tokens) if (!pinned.some((p) => p.chain === t.chain && p.address === t.address)) pinned.push({ ...t, symbol: sym(t.symbol), source: "Core" });
}
const RANK: Record<ListedToken["source"], number> = { Core: 3, Jupiter: 2, CoinGecko: 1 };
const byRank = (a: ListedToken, b: ListedToken) => RANK[b.source] - RANK[a.source] || (b.mcap ?? 0) - (a.mcap ?? 0);

type Lists = { byAddr: Map<string, ListedToken>; byTicker: Map<string, ListedToken[]>; raw: ListedToken[][]; at: number; ok: boolean };
const g = globalThis as unknown as { __crawlhiveVerified?: Lists; __crawlhiveVerifiedP?: Promise<Lists> };

// EVM-адреса сравниваем в нижнем регистре, адреса Solana чувствительны к регистру.
const key = (chain: string, address: string) => `${chain}:${address.startsWith("0x") ? address.toLowerCase() : address}`;
const sym = (s?: string) => (s ?? "").replace(/^\$/, "").toUpperCase();

async function fetchList(src: (typeof SOURCES)[number]): Promise<ListedToken[]> {
  const r = await fetch(src.url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${src.source} ${src.chain} ${r.status}`);
  const j = (await r.json()) as unknown;
  if (src.source === "Jupiter") {
    const rows = j as { id: string; symbol: string; name: string; mcap?: number }[];
    return rows.map((t) => ({ chain: src.chain, address: t.id, symbol: sym(t.symbol), name: t.name ?? "", mcap: t.mcap, source: src.source }));
  }
  const rows = (j as { tokens?: { address: string; symbol: string; name: string }[] }).tokens ?? [];
  return rows.map((t) => ({ chain: src.chain, address: t.address, symbol: sym(t.symbol), name: t.name ?? "", source: src.source }));
}

async function load(prev?: Lists): Promise<Lists> {
  const results = await Promise.allSettled(SOURCES.map(fetchList));
  // Источник не ответил при обновлении — оставляем его прошлую копию, а не теряем сеть целиком.
  const raw = results.map((r, i) => (r.status === "fulfilled" ? r.value : (prev?.raw[i] ?? [])));
  const byAddr = new Map<string, ListedToken>();
  const byTicker = new Map<string, ListedToken[]>();
  const add = (t: ListedToken) => {
    const k = key(t.chain, t.address);
    // Первым пишется самый надёжный источник: базовый актив, потом Jupiter (знает капитализацию), потом CoinGecko.
    if (byAddr.has(k)) return;
    byAddr.set(k, t);
    const list = byTicker.get(t.symbol) ?? [];
    list.push(t);
    byTicker.set(t.symbol, list);
  };
  pinned.forEach(add);
  for (const [i, r] of results.entries()) if (r.status === "rejected") console.error("[verified]", SOURCES[i].url, (r.reason as Error).message);
  for (const list of raw) list.forEach(add);
  return { byAddr, byTicker, raw, at: Date.now(), ok: results.every((r) => r.status === "fulfilled") };
}

// Списки грузятся один раз и живут 12 часов; пока идёт обновление, работаем со старой копией.
export async function verifiedLists(): Promise<Lists | undefined> {
  const cur = g.__crawlhiveVerified;
  const stale = !cur || Date.now() - cur.at > (cur.ok ? TTL_MS : RETRY_MS);
  if (stale && !g.__crawlhiveVerifiedP) {
    g.__crawlhiveVerifiedP = load(cur)
      .then((l) => (g.__crawlhiveVerified = l))
      .finally(() => (g.__crawlhiveVerifiedP = undefined));
  }
  if (cur) return cur;
  return g.__crawlhiveVerifiedP?.catch(() => undefined);
}

export async function listedToken(chain: string, address: string) {
  return (await verifiedLists())?.byAddr.get(key(chain, address));
}

// Проверенные токены с этим тикером в сети: базовый актив, потом Jupiter, потом CoinGecko; внутри — по капитализации.
export async function listedByTicker(chain: string, ticker: string) {
  const lists = await verifiedLists();
  const all = lists ? (lists.byTicker.get(sym(ticker)) ?? []) : pinned.filter((t) => t.symbol === sym(ticker));
  return all.filter((t) => t.chain === chain).sort(byRank);
}

// «Bonk Coin» против «Bonk», «Jupiter Price» против «Jupiter»: подделка берёт имя оригинала и дописывает слово
// в конце. Совпадение в середине («AnyCode» и «CODE») — просто похожие слова, не копия.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export function similarName(a: string, b: string) {
  const x = norm(a);
  const y = norm(b);
  if (x.length < 3 || y.length < 3) return x === y && x.length > 0;
  if (x.startsWith(y) || y.startsWith(x)) return true;
  // Опечатка нарочно: «Pudgy Penguines», «Dogeccoin». Для коротких имён две буквы — уже другое слово.
  return Math.min(x.length, y.length) >= 8 && editDistance(x, y) <= 2;
}

function editDistance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

export type ListingCheck =
  | { kind: "listed"; token: ListedToken }
  | { kind: "impersonator"; real: ListedToken } // тот же тикер и похожее имя в этой же сети
  | { kind: "ticker-squat"; real: ListedToken } // имя своё, но тикер крупного проверенного токена
  | { kind: "ticker-taken"; real: ListedToken } // тикер занят проверенным токеном, имя другое
  | { kind: "copy-elsewhere"; real: ListedToken } // в этой сети проверенного нет, но есть в другой с тем же именем
  | { kind: "unknown" };

const BIG_MCAP = 10_000_000; // тикер такого токена чужим не занимают случайно

export async function checkListing(chain: string, address: string, symbol: string, name: string): Promise<ListingCheck> {
  const lists = await verifiedLists();
  if (!lists || !symbol) return { kind: "unknown" };
  const ticker = sym(symbol);
  const twins = (lists.byTicker.get(ticker) ?? []).filter((t) => key(t.chain, t.address) !== key(chain, address));
  const here = twins.filter((t) => t.chain === chain).sort(byRank);
  const namesake = (t: ListedToken) => similarName(t.name, name);
  // Имя, равное тикеру («USDT», «CAKE»): у оригинала в списке полное имя, так что это не копия имени,
  // но и не своё название — по смыслу то же, что занять тикер крупного токена.
  const bareTicker = norm(name) === norm(ticker);
  const own = lists.byAddr.get(key(chain, address));
  if (own) {
    // CoinGecko заводит страницы и копиям («Wif - SecondChance», «PepeSol»). Если Jupiter проверил другой токен
    // с этим тикером и именем или крупный токен с этим тикером, запись только в CoinGecko оригиналом не считаем.
    const jup = own.source === "CoinGecko" && here.find((t) => t.source === "Core" || (t.source === "Jupiter" && (namesake(t) || (t.mcap ?? 0) >= BIG_MCAP)));
    if (!jup) return { kind: "listed", token: own };
    return { kind: "ticker-taken", real: jup };
  }
  // Чужой токен с тикером USDT, USDC, SOL… — подделка базового актива, как бы он ни назывался.
  const real = here.find((t) => t.source === "Core") ?? here.find(namesake);
  // Для сети без списков (Robinhood Chain) остальное судить нечем: там работает проверка по возрасту клонов.
  if (!real && !SOURCES.some((s) => s.chain === chain)) return { kind: "unknown" };
  if (real) return { kind: "impersonator", real };
  const big = here.find((t) => (t.mcap ?? 0) >= BIG_MCAP) ?? (bareTicker ? here[0] : undefined);
  if (big) return { kind: "ticker-squat", real: big };
  if (here[0]) return { kind: "ticker-taken", real: here[0] };
  const elsewhere = twins.find((t) => t.chain !== chain && similarName(t.name, name));
  if (elsewhere) return { kind: "copy-elsewhere", real: elsewhere };
  return { kind: "unknown" };
}
