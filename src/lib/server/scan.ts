// Instant Crawl: бесплатный разовый скан токена без кошелька. Несколько краулеров разбегаются по одному
// адресу — рынок (DexScreener), права минта и держатели (Solana RPC; на Robinhood Chain — GeckoTerminal и
// владелец контракта), клоны тикера, упоминания в Telegram — и сводят всё в оценку 0–100 с одной строкой вывода.
import "server-only";
import { trackVerdict, type TrackEntry } from "./track";
import { PublicKey } from "@solana/web3.js";
import { bestPairs, searchPairs, type PairInfo } from "./crawl/dexscreener";
import { fetchChannel } from "./crawl/sources/telegram";
import { rpcConnection } from "./solana";
import { getMeta, setMeta } from "./store";
import { traceBundles, type BundleReport } from "./scan-bundles";
import { traceDev, type DevReport } from "./scan-dev";
import { EVM_SCAN, traceEvm, type EvmReport } from "./scan-evm";
import { BUZZ_TTL_MS, type XBuzz } from "./scan-x";
import { xrayEvm, xrayFactors, xrayLive, type XRayReport } from "./scan-xray";
import { t22Factors, xraySolana, type T22Report } from "./scan-t22";
import { siteFactors, xraySite, type SiteReport } from "./scan-site";
import { checkListing, listedByTicker, pinCore, type ListingCheck } from "./verified";
import type { XRayView } from "@/components/xray-panel";

export type Verdict = "CLEAN" | "OK" | "RISKY" | "DANGER" | "TOO_EARLY";

export interface ScanFactor {
  label: string;
  impact: number; // сколько очков сняло (отрицательное) или добавило
  note: string;
}

export interface ScanResult {
  id: string; // адрес токена
  chain: string;
  symbol: string;
  name: string;
  score: number | null; // null — слишком рано судить
  verdict: Verdict;
  reason: string;
  factors: ScanFactor[];
  market?: {
    priceUsd?: number;
    liquidityUsd?: number;
    fdv?: number;
    volume1h?: number;
    volume24h?: number;
    change1h?: number;
    ageHours?: number;
    buys1h?: number;
    sells1h?: number;
    url?: string;
    socials: number;
  };
  holders?: { top1: number; top10: number; mintAuthority: boolean; freezeAuthority: boolean };
  bundles?: BundleReport;
  dev?: DevReport;
  evm?: EvmReport; // Robinhood Chain: держатели, honeypot, владелец контракта
  xray?: XRayView; // Contract X-Ray: рычаги владельца из байткода (EVM) или расширений Token-2022 (Solana)
  core?: string; // базовый актив сети (SOL, USDC…): мем-проверки к нему не применяются
  clones: number;
  original?: boolean; // самый крупный из токенов с этим тикером
  telegram: { channel: string; url: string }[];
  x?: XBuzz; // догружается после вердикта, есть только в сохранённом скане
  scannedAt: number;
}

export interface ScanLog {
  crawler: string;
  text: string;
  tone?: "ok" | "warn" | "bad" | "info";
}

const TG_CHANNELS = ["pumpfun", "DexScreenerTrending"];

// Базовые активы Solana: у них нет «создателя-разработчика», а тикер SOL/USDC носят сотни копий,
// поэтому проверки держателей, клонов и связанных кошельков для них дают ложную тревогу.
const CORE: Record<string, string> = {
  So11111111111111111111111111111111111111112: "Wrapped SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "Jupiter",
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "JitoSOL",
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "Marinade SOL",
  // Robinhood Chain (адреса EVM в нижнем регистре)
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73": "Wrapped ETH",
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "USDG",
  "0x80e0e24718dbfcad49ecaa6f1e6c89a190586ca8": "USDC",
  // BNB Chain
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": "Wrapped BNB",
  "0x55d398326f99059ff775485246999027b3197955": "USDT",
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "USDC",
  "0xe9e7cea3dedca5984780bafc599bd69add087d56": "BUSD",
};
// Тикеры базовых активов: копию USDT или USDC ловим даже тогда, когда в списках CoinGecko у оригинала
// другой символ (USDT на BNB Chain там записан как BSC-USD).
const CORE_TICKERS: { chain: string; address: string; symbol: string }[] = [
  { chain: "solana", address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
  { chain: "solana", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC" },
  { chain: "solana", address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT" },
  { chain: "solana", address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP" },
  { chain: "solana", address: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", symbol: "JITOSOL" },
  { chain: "solana", address: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", symbol: "MSOL" },
  { chain: "robinhood", address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", symbol: "WETH" },
  { chain: "robinhood", address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", symbol: "USDG" },
  { chain: "robinhood", address: "0x80e0e24718dbfcad49ecaa6f1e6c89a190586ca8", symbol: "USDC" },
  { chain: "bsc", address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", symbol: "WBNB" },
  { chain: "bsc", address: "0x55d398326f99059ff775485246999027b3197955", symbol: "USDT" },
  { chain: "bsc", address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", symbol: "USDC" },
  { chain: "bsc", address: "0xe9e7cea3dedca5984780bafc599bd69add087d56", symbol: "BUSD" },
];
pinCore(CORE_TICKERS.map((c) => ({ ...c, name: CORE[c.address] ?? c.symbol })));
// Сети, которые умеет сканер. Ключ — chainId DexScreener.
export const SCAN_CHAINS: Record<string, string> = { solana: "Solana", robinhood: "Robinhood Chain", bsc: "BNB Chain" };
const chainName = (c: string) => SCAN_CHAINS[c] ?? c;
const RECENT_KEY = "recentScans";
const SAVED_KEY = "scanResults";
const SAVED_MAX = 200;
const CACHE_MS = 2 * 60_000;
const OLDER_TWIN_MS = 30 * 86_400_000; // на сколько раньше должен появиться «оригинал», чтобы мы ему поверили

// Символы бывают записаны как «$WIF»: сравниваем без знака доллара и регистра.
const sym = (s?: string) => (s ?? "").replace(/^\$/, "").toUpperCase();

// DexScreener ищет «WIF» и «$WIF» по-разному (у dogwifhat символ записан со знаком доллара),
// поэтому спрашиваем оба варианта и склеиваем.
async function searchTicker(t: string): Promise<PairX[]> {
  const [a, b] = await Promise.all([searchPairs(t), searchPairs(`$${t}`).catch(() => [])]);
  const seen = new Set<string>();
  return ([...a, ...b] as PairX[]).filter((p) => !seen.has(p.pairAddress) && !!seen.add(p.pairAddress));
}

type PairX = PairInfo & {
  dexId?: string;
  txns?: { h1?: { buys?: number; sells?: number } };
  info?: { websites?: unknown[]; socials?: unknown[] };
  boosts?: { active?: number };
};

const g = globalThis as unknown as { __crawlhiveScan?: { cache: Map<string, { result: ScanResult; logs: ScanLog[] }>; hits: Map<string, number[]> } };
function mem() {
  g.__crawlhiveScan ??= { cache: new Map(), hits: new Map() };
  return g.__crawlhiveScan;
}

// Скользящее окно на ключ (IP, кошелёк плательщика): не больше max событий за windowMs.
// Ключи разных лимитов разводятся префиксом, окно у одного ключа всегда одно и то же.
export function allowHit(key: string, max: number, windowMs: number) {
  const m = mem();
  const now = Date.now();
  // Старые записи выбрасываем, иначе карта ключей растёт без конца.
  if (m.hits.size > 20_000) for (const [k, v] of m.hits) if (!v.some((t) => now - t < windowMs)) m.hits.delete(k);
  const list = (m.hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) return false;
  list.push(now);
  m.hits.set(key, list);
  return true;
}

// Не больше 8 сканов за 10 минут с одного адреса: краулеры ходят во внешние API.
export const allowScan = (ip: string) => allowHit(ip, 8, 10 * 60_000);

function isSolanaMint(s: string) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

const pct = (n: number) => `${n.toFixed(n < 10 ? 1 : 0)}%`;
const usd = (n?: number) =>
  n === undefined ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${Math.round(n)}`;

// Разбор ввода: адрес Solana, адрес EVM или $ТИКЕР (самая ликвидную пару в выбранной сети: Solana или Robinhood Chain).
async function resolve(q: string, log: (l: ScanLog) => void, hint = "solana"): Promise<{ chain: string; address: string; pair?: PairX }> {
  const net = SCAN_CHAINS[hint] ? hint : "solana";
  let s = q.trim();
  // Ссылка на DexScreener, pump.fun или Solscan: достаём из неё адрес.
  if (/^https?:\/\//i.test(s)) s = s.match(/0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/g)?.pop() ?? s;
  if (isSolanaMint(s)) return { chain: "solana", address: s };
  if (/^0x[a-fA-F0-9]{40}$/.test(s)) {
    const pairs = ((await searchPairs(s)) as PairX[]).filter((p) => p.baseToken.address.toLowerCase() === s.toLowerCase());
    // Один адрес бывает в нескольких EVM-сетях: сначала сеть, выбранная пользователем, потом поддерживаемые
    // сканером (Robinhood Chain, BNB Chain), внутри — самая ликвидная пара.
    const rank = (p: PairX) => (p.chainId === hint ? 2 : SCAN_CHAINS[p.chainId] ? 1 : 0);
    pairs.sort((a, b) => rank(b) - rank(a) || (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const best = pairs[0];
    if (!best) throw new Error("No trading pair found for this address");
    return { chain: best.chainId, address: best.baseToken.address, pair: best };
  }
  const ticker = s.replace(/^\$/, "").toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(ticker)) throw new Error("Paste a token contract address or a $TICKER");
  log({ crawler: "resolver", text: `looking up $${ticker} on ${chainName(net)}…` });
  const [found, listed] = await Promise.all([searchTicker(ticker), listedByTicker(net, ticker).catch(() => [])]);
  const pairs = found.filter((p) => p.chainId === net && sym(p.baseToken.symbol) === ticker);
  // Ликвидность подделка накручивает, поэтому порядок такой: базовый актив, проверенный Jupiter, есть в CoinGecko,
  // и только потом самый ликвидный.
  const RANK = { Core: 3, Jupiter: 2, CoinGecko: 1 } as const;
  const rankOf = (address: string) => {
    const t = listed.find((x) => x.address === address || x.address.toLowerCase() === address.toLowerCase());
    return t ? RANK[t.source] : 0;
  };
  pairs.sort((a, b) => rankOf(b.baseToken.address) - rankOf(a.baseToken.address) || (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const others = new Set(pairs.map((p) => p.baseToken.address)).size - 1;
  const best = listed[0];
  if (best && RANK[best.source] > (pairs[0] ? rankOf(pairs[0].baseToken.address) : 0)) {
    // Поиск DexScreener не вернул лучший проверенный токен (его забили копии) — берём адрес прямо из списка.
    log({ crawler: "resolver", text: `picked the verified $${ticker} (${best.source === "Core" ? "core asset" : `${best.source} list`})${pairs.length ? `, not the ${others + 1} lookalike${others ? "s" : ""} in search` : ""}`, tone: "info" });
    return { chain: net, address: best.address };
  }
  if (!pairs[0]) throw new Error(`No ${chainName(net)} token with ticker $${ticker}`);
  log({
    crawler: "resolver",
    text: rankOf(pairs[0].baseToken.address)
      ? `picked the verified $${ticker}${others ? ` (${others} more share this ticker)` : ""}`
      : `picked the most liquid $${ticker}${others ? ` (${others} more share this ticker)` : ""}`,
    tone: others ? "warn" : "info",
  });
  return { chain: net, address: pairs[0].baseToken.address, pair: pairs[0] };
}

async function holdersOf(mint: string) {
  const conn = rpcConnection();
  const key = new PublicKey(mint);
  const [info, supply, largest] = await Promise.all([
    conn.getParsedAccountInfo(key),
    conn.getTokenSupply(key),
    conn.getTokenLargestAccounts(key),
  ]);
  const parsed = (info.value?.data as { parsed?: { info?: { mintAuthority?: string | null; freezeAuthority?: string | null } } })?.parsed?.info;
  const total = Number(supply.value.amount) || 1;
  const amounts = largest.value.map((a) => Number(a.amount));
  return {
    supplyRaw: Number(supply.value.amount) || 0,
    top1: (amounts[0] ?? 0) / total * 100,
    top2to11: amounts.slice(1, 11).reduce((s, x) => s + x, 0) / total * 100,
    top10: amounts.slice(0, 10).reduce((s, x) => s + x, 0) / total * 100,
    mintAuthority: !!parsed?.mintAuthority,
    freezeAuthority: !!parsed?.freezeAuthority,
    accounts: largest.value.map((a) => ({ account: a.address.toBase58(), pct: Number(a.amount) / total * 100 })),
  };
}

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

// record=false — скан для внутренних нужд (краулеры, Grok Bot): в публичную ленту «recently scanned» не попадает.
export async function runScan(
  q: string,
  emit: (l: ScanLog) => void,
  hint?: string,
  opts: { record?: boolean; src?: TrackEntry["src"] } = {},
): Promise<ScanResult> {
  const logs: ScanLog[] = [];
  const log = (l: ScanLog) => {
    logs.push(l);
    emit(l);
  };
  const { chain, address, pair: pre } = await resolve(q, log, hint);
  const cached = mem().cache.get(address);
  if (cached && Date.now() - cached.result.scannedAt < CACHE_MS) {
    // Свежий скан этого токена уже есть: проигрываем его лог, чтобы было видно, что нашли краулеры.
    emit({ crawler: "cache", text: `fresh scan from ${Math.round((Date.now() - cached.result.scannedAt) / 1000)}s ago`, tone: "info" });
    for (const l of cached.logs) {
      await new Promise((r) => setTimeout(r, 120));
      emit(l);
    }
    return cached.result;
  }
  const factors: ScanFactor[] = [];
  const hit = (label: string, impact: number, note: string) => factors.push({ label, impact, note });
  const core = CORE[address] ?? CORE[address.toLowerCase()];
  if (core) log({ crawler: "resolver", text: `${core} is a core ${chainName(chain)} asset: memecoin checks are skipped`, tone: "info" });

  // Краулеры работают параллельно, каждый пишет в лог по готовности.
  log({ crawler: "swarm", text: `${core ? 2 : chain === "solana" ? 6 : EVM_SCAN[chain] ? 4 : 3} crawlers dispatched to ${address.slice(0, 6)}…${address.slice(-4)} on ${chainName(chain)}` });

  const marketP = (async () => {
    const pair = (pre ?? (await bestPairs(chain, [address])).get(address)) as PairX | undefined;
    if (!pair) {
      log({ crawler: "crawler_market", text: "no trading pair on DexScreener yet", tone: "warn" });
      return undefined;
    }
    const ageHours = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3600_000 : undefined;
    log({
      crawler: "crawler_market",
      text: `$${sym(pair.baseToken.symbol)} · ${pair.liquidity?.usd === undefined ? "no pool yet (bonding curve)" : `liquidity ${usd(pair.liquidity.usd)}`}${pair.liquidity?.usd === undefined && (pair.fdv ?? 0) < 1_000 ? "" : ` · FDV ${usd(pair.fdv)}`} · ${ageHours !== undefined ? `${ageHours < 48 ? `${ageHours.toFixed(1)}h` : `${Math.round(ageHours / 24)}d`} old` : "age unknown"}`,
      tone: (pair.liquidity?.usd ?? 0) < 10_000 ? "warn" : "ok",
    });
    return { pair, ageHours };
  })();

  const holdersP =
    chain === "solana" && !core
      ? holdersOf(address)
          .then((h) => {
            // У некоторых минтов supply в аккаунте не отражает реальную эмиссию — доли выходят за 100%.
            if (h.top1 > 100 || h.top10 > 100) {
              log({ crawler: "crawler_holders", text: "supply data is inconsistent, holder shares skipped", tone: "warn" });
              return undefined;
            }
            log({
              crawler: "crawler_holders",
              text: `top holder ${pct(h.top1)} · next 10 hold ${pct(h.top2to11)} · mint ${h.mintAuthority ? "OPEN" : "renounced"} · freeze ${h.freezeAuthority ? "ON" : "off"}`,
              tone: h.mintAuthority || h.freezeAuthority ? "bad" : h.top2to11 > 40 ? "warn" : "ok",
            });
            return h;
          })
          .catch(() => {
            log({ crawler: "crawler_holders", text: "holder data unavailable right now", tone: "warn" });
            return undefined;
          })
      : Promise.resolve(undefined);

  // Robinhood Chain: держатели и honeypot (GeckoTerminal), владелец контракта (RPC).
  const evmP: Promise<EvmReport | undefined> =
    EVM_SCAN[chain] && !core
      ? withTimeout(traceEvm(address, chain), 15_000)
          .then((e) => {
            log({
              crawler: "crawler_holders",
              text: `${e.holders !== undefined ? `${e.holders.toLocaleString("en-US")} holders` : "holder count unknown"}${e.top10 !== undefined ? ` · top 10 hold ${pct(e.top10)}` : ""} · owner ${e.owner ? `${e.owner.slice(0, 6)}…${e.owner.slice(-4)} (active)` : "renounced"}${e.honeypot ? " · HONEYPOT" : e.honeypot === false ? " · sellable" : ""}`,
              tone: e.honeypot ? "bad" : e.owner || (e.top10 ?? 0) > 90 || (e.holders ?? 999) < 50 ? "warn" : "ok",
            });
            return e;
          })
          .catch(() => {
            log({ crawler: "crawler_holders", text: "holder data unavailable right now", tone: "warn" });
            return undefined;
          })
      : Promise.resolve(undefined);

  // Contract X-Ray: что владелец может сделать с держателями. На EVM читаем байткод (работает и без
  // опубликованного исходника), на Solana — расширения Token-2022.
  const xrayP: Promise<XRayReport | T22Report | undefined> = core
    ? Promise.resolve(undefined)
    : EVM_SCAN[chain]
      ? xrayEvm(address, chain)
      : chain === "solana"
        ? withTimeout(xraySolana(rpcConnection(), address), 10_000).catch(() => undefined)
        : Promise.resolve(undefined);

  // Связанные кошельки: кто профинансировал топ-держателей. Идёт после держателей, ему нужен их список.
  const bundlesP: Promise<BundleReport | undefined> = holdersP.then((h) =>
    h
      ? withTimeout(traceBundles(rpcConnection(), h.accounts), 15_000)
          .then((b) => {
            const big = b.clusters[0];
            log({
              crawler: "crawler_bundles",
              text: big
                ? `${big.wallets} top wallets share one funder and hold ${pct(big.pct)}${b.clusters.length > 1 ? ` · ${b.clusters.length - 1} more linked group${b.clusters.length > 2 ? "s" : ""}` : ""}`
                : `traced funding of ${b.checked} top wallets: no linked groups${b.fresh.wallets ? ` · ${b.fresh.wallets} fresh wallet${b.fresh.wallets > 1 ? "s" : ""} hold ${pct(b.fresh.pct)}` : ""}`,
              tone: big && (big.pct >= 4 || big.wallets >= 3) ? "bad" : b.fresh.pct >= 15 || big ? "warn" : "ok",
            });
            return b;
          })
          .catch((e) => {
            console.error("[scan] bundles:", (e as Error).message);
            log({ crawler: "crawler_bundles", text: "could not trace wallet funding right now", tone: "warn" });
            return undefined;
          })
      : undefined,
  );

  // История разработчика: создатель, его прошлые запуски на pump.fun, возраст кошелька, сколько держит.
  const devP: Promise<DevReport | undefined> =
    chain === "solana" && !core
      ? holdersP.then((h) =>
          withTimeout(traceDev(rpcConnection(), address, h?.supplyRaw), 15_000)
            .then((d) => {
              if (!d) {
                log({ crawler: "crawler_dev", text: "creator not found: an old token or one minted outside launchpads", tone: "info" });
                return undefined;
              }
              const age = d.walletAgeHours === undefined ? `${d.walletTxs}+ txs` : d.walletAgeHours < 48 ? `wallet ${d.walletAgeHours.toFixed(1)}h old` : `wallet ${Math.round(d.walletAgeHours / 24)}d old`;
              const others = d.launched - 1;
              log({
                crawler: "crawler_dev",
                text: `creator ${d.creator.slice(0, 4)}…${d.creator.slice(-4)} · ${d.platform === "other" ? "found from the first transaction" : others ? `${others} earlier pump.fun launch${others > 1 ? "es" : ""}, ${d.graduated} graduated` : "first launch"} · ${age}${d.holdsPct !== undefined ? ` · holds ${pct(d.holdsPct)}` : ""}`,
                tone: devTone(d),
              });
              return d;
            })
            .catch((e) => {
              console.error("[scan] dev:", (e as Error).message);
              log({ crawler: "crawler_dev", text: "could not trace the creator right now", tone: "warn" });
              return undefined;
            }),
        )
      : Promise.resolve(undefined);

  const market = await marketP;
  const symbol = sym(market?.pair.baseToken.symbol);

  // Сайт проекта: у мем-лендинга нет причин просить у кошелька апрувы — так прячутся дрейнеры.
  const site = (market?.pair.info?.websites ?? []).map((w) => (typeof w === "string" ? w : (w as { url?: string })?.url)).find((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u));
  const siteP: Promise<SiteReport | undefined> =
    site && !core
      ? withTimeout(xraySite(site), 20_000)
          .then((r) => {
            if (r)
              log({
                crawler: "crawler_site",
                text: r.error ? `${r.host}: site unreachable, not checked` : r.findings.length ? `${r.host}: ${r.findings.map((f) => f.label.toLowerCase()).join(", ")}` : `${r.host}: ${r.scripts} scripts read, no drainer code`,
                tone: r.findings.some((f) => f.severity === "high") ? "bad" : r.findings.some((f) => f.severity === "medium") ? "warn" : r.error ? "info" : "ok",
              });
            return r;
          })
          .catch(() => undefined)
      : Promise.resolve(undefined);

  // Списки Jupiter / CoinGecko: оригинал там есть, подделка с тем же тикером — нет.
  const listingP: Promise<ListingCheck> =
    symbol && !core
      ? checkListing(chain, address, symbol, market?.pair.baseToken.name ?? "")
          .then((c) => {
            const real = "real" in c ? `${c.real.name} (${c.real.address.slice(0, 4)}…${c.real.address.slice(-4)}${c.real.chain !== chain ? ` on ${chainName(c.real.chain)}` : ""})` : "";
            if (c.kind !== "unknown")
              log({
                crawler: "crawler_clones",
                text:
                  c.kind === "listed"
                    ? `on the ${c.token.source} verified list: the real $${symbol}`
                    : c.kind === "impersonator"
                      ? `not on the verified lists, but the real $${symbol} is: ${real}. This looks like an impersonator`
                      : c.kind === "copy-elsewhere"
                        ? `not on the verified lists; a verified token with this name lives elsewhere: ${real}`
                        : c.kind === "ticker-squat"
                          ? `uses the ticker of a bigger verified token: ${real}`
                          : `the verified $${symbol} is a different token: ${real}`,
                tone: c.kind === "listed" ? "ok" : c.kind === "impersonator" ? "bad" : "warn",
              });
            return c;
          })
          .catch((): ListingCheck => ({ kind: "unknown" }))
      : Promise.resolve<ListingCheck>({ kind: "unknown" });

  // Клоны: другие токены с тем же тикером. Если у кого-то из них ликвидность больше, этот, скорее всего, копия.
  const clonesP: Promise<{ n: number; biggerTwin?: number; original?: boolean }> = symbol && !core
    ? Promise.all([searchTicker(sym(symbol)), listingP])
        .then(([pairs, listing]) => {
          const same = pairs.filter((p) => p.chainId === chain && sym(p.baseToken.symbol) === sym(symbol));
          // Сравниваем по капитализации: у копии она на порядки меньше, даже если в одном пуле много ликвидности.
          const others = new Map<string, { fdv: number; liq: number; born: number }>();
          // Когда появилась первая пара нашего токена: копия всегда моложе оригинала.
          let mineBorn = market?.pair.pairCreatedAt ?? Infinity;
          for (const p of same) {
            const born = p.pairCreatedAt ?? Infinity;
            if (p.baseToken.address === address) {
              mineBorn = Math.min(mineBorn, born);
              continue;
            }
            const prev = others.get(p.baseToken.address) ?? { fdv: 0, liq: 0, born: Infinity };
            others.set(p.baseToken.address, { fdv: Math.max(prev.fdv, p.fdv ?? 0), liq: Math.max(prev.liq, p.liquidity?.usd ?? 0), born: Math.min(prev.born, born) });
          }
          const n = others.size;
          const mineFdv = market?.pair.fdv ?? 0;
          // Без FDV (так бывает у wrapped-активов) сравниваем по ликвидности пула.
          const mineLiq = market?.pair.liquidity?.usd ?? 0;
          // FDV копия накручивает, а возраст подделать нельзя: живой токен с тем же тикером, торгующийся
          // на месяц дольше нашего, — скорее оригинал, даже если «наш» показывает FDV больше.
          const older = (o: { fdv: number; born: number }) => Number.isFinite(mineBorn) && o.born + OLDER_TWIN_MS < mineBorn && o.fdv >= 1_000_000;
          let twin: { fdv: number; liq: number; born: number } | undefined = [...others.values()]
            // Крупный «двойник», запущенный позже нашего токена, — сам копия с накрученной FDV, а не оригинал.
            .filter((o) => o.liq > 20_000 && !(o.born > mineBorn) && ((mineFdv ? o.fdv > Math.max(mineFdv * 5, 100_000) : o.liq > mineLiq * 5) || older(o)))
            .sort((x, y) => x.born - y.born)[0];
          // Проверенный токен не копия; токен, у которого проверенный двойник, — не оригинал.
          if (listing.kind === "listed") twin = undefined;
          const canBeOriginal = !["impersonator", "ticker-squat", "ticker-taken", "copy-elsewhere"].includes(listing.kind);
          const biggerTwin = twin?.fdv;
          const top = Math.max(0, ...[...others.values()].filter((o) => !(o.born > mineBorn)).map((o) => o.fdv));
          const mine = mineFdv;
          log({
            crawler: "crawler_clones",
            text: twin
              ? `${older(twin) ? `an older token (${Math.round((mineBorn - twin.born) / 86_400_000)}d earlier)` : "a bigger token"} already uses $${sym(symbol)} (${usd(twin.fdv)} FDV): this may be a copy`
              : n > 0 && mine >= top && canBeOriginal
                ? `the original $${sym(symbol)}: the biggest of ${n + 1} tokens with this ticker`
                : n > 0
                ? `${n} other token${n > 1 ? "s use" : " uses"} the ticker $${sym(symbol)}`
                : `ticker $${sym(symbol)} is unique on ${chainName(chain)}`,
            tone: biggerTwin ? "bad" : n > 2 ? "warn" : "ok",
          });
          return { n, biggerTwin, original: n > 0 && mine >= top && canBeOriginal };
        })
        .catch(() => ({ n: 0 }))
    : Promise.resolve({ n: 0 });

  const tgP = Promise.all(
    TG_CHANNELS.map(async (ch) => {
      try {
        const msgs = await fetchChannel(ch);
        // Символ задаёт создатель токена: регулярку из него не строим (ReDoS), ищем подстроку и проверяем границу.
        const tag = symbol ? `$${symbol}` : "";
        const hasTag = (t: string) => {
          if (!tag) return false;
          const up = t.toUpperCase();
          for (let i = up.indexOf(tag); i >= 0; i = up.indexOf(tag, i + 1)) if (!/[A-Z0-9_]/.test(up[i + tag.length] ?? "")) return true;
          return false;
        };
        const m = msgs.reverse().find((x) => x.text.includes(address) || hasTag(x.text));
        return m ? { channel: `t.me/${ch}`, url: m.url ?? `https://t.me/${ch}` } : null;
      } catch {
        return null;
      }
    }),
  ).then((r) => {
    const found = r.filter(Boolean) as { channel: string; url: string }[];
    log({ crawler: "crawler_telegram", text: found.length ? `mentioned in ${found.map((f) => f.channel).join(", ")}` : `no mentions in ${TG_CHANNELS.length} tracked channels`, tone: found.length ? "ok" : "info" });
    return found;
  });

  const [holders, clonesRaw, telegram, bundles, dev, evm, xr, siteR, listing] = await Promise.all([holdersP, clonesP, tgP, bundlesP, devP, evmP, xrayP, siteP, listingP]);
  // Токен из проверенного списка и есть оригинал, какие бы цифры ни показывали его копии.
  const cloneInfo: { n: number; biggerTwin?: number; original?: boolean } = listing.kind === "listed" ? { n: clonesRaw.n, original: true } : clonesRaw;
  let xray = xr && "program" in xr ? xrayViewSol(xr) : xr ? xrayViewEvm(xr, !!evm?.owner) : undefined;
  if (siteR) {
    const siteView = { host: siteR.host, wallet: siteR.wallet, error: siteR.error, findings: siteR.findings.map((f) => ({ label: f.label, note: f.note, severity: f.severity, detail: f.evidence })) };
    xray = xray ? { ...xray, site: siteView } : { kind: chain === "solana" ? "solana" : "evm", summary: "token contract not read", findings: [], site: siteView };
  }
  if (xray) log({ crawler: "crawler_xray", text: `${xray.summary}${xray.findings.length ? ` · ${xray.findings.filter((f) => f.severity !== "low").map((f) => f.label.toLowerCase()).join(", ") || "only launch mechanics"}` : " · nothing the owner can pull"}`, tone: xray.findings.some((f) => f.severity === "high") ? "bad" : xray.findings.some((f) => f.severity === "medium") ? "warn" : "ok" });
  const clones = cloneInfo.n;

  // ---------- оценка ----------
  let score = 100;
  const p = market?.pair;
  const liq = p?.liquidity?.usd ?? 0;
  // Пара без ликвидности — токен ещё на bonding curve лаунчпада (pump.fun, Meteora DBC, Raydium LaunchLab,
  // Moonshot, Boop…): у кривой нет пула, и «$0 ликвидности» здесь неправда.
  const onCurve = !!p && p.liquidity?.usd === undefined;
  const launchpad = !p ? "" : /pump/i.test(p.dexId ?? "") ? "pump.fun" : /dbc|meteora/i.test(p.dexId ?? "") ? "Meteora DBC" : /launchlab/i.test(p.dexId ?? "") ? "Raydium LaunchLab" : /four/i.test(p.dexId ?? "") ? "four.meme" : p.dexId ?? "launchpad";
  if (!p) hit("No market", -35, "no trading pair found");
  else if (onCurve) hit("Bonding curve", -10, `still on the ${launchpad} curve, not graduated to a pool`);
  else if (liq < 5_000) hit("Thin liquidity", -25, `only ${usd(liq)} in the pool`);
  else if (liq < 20_000) hit("Low liquidity", -10, `${usd(liq)} in the pool`);
  if (holders?.mintAuthority) hit("Mint open", -30, "the creator can still mint new tokens");
  if (holders?.freezeAuthority) hit("Freeze on", -25, "the creator can freeze holders' tokens");
  // Крупнейший держатель — обычно пул ликвидности, поэтому концентрацию считаем по следующим десяти.
  if (holders && holders.top2to11 > 50) hit("Concentrated", -20, `the next 10 wallets hold ${pct(holders.top2to11)}`);
  else if (holders && holders.top2to11 > 30) hit("Top-heavy", -10, `the next 10 wallets hold ${pct(holders.top2to11)}`);
  const cluster = bundles?.clusters[0];
  // Пять и больше топ-кошельков под одним хозяином — бандл, даже если доля пока небольшая.
  if (cluster && (cluster.pct >= 10 || cluster.wallets >= 5)) hit("Bundled", -25, `${cluster.wallets} linked wallets hold ${pct(cluster.pct)}`);
  else if (cluster && (cluster.pct >= 4 || cluster.wallets >= 3)) hit("Linked wallets", -10, `${cluster.wallets} top wallets share a funder (${pct(cluster.pct)})`);
  if (bundles && bundles.fresh.pct >= 15) hit("Fresh wallets", -10, `${bundles.fresh.wallets} wallets under 3 days old hold ${pct(bundles.fresh.pct)}`);
  if (dev) {
    const prior = dev.launched - 1;
    if (prior >= 10 && dev.graduated === 0) hit("Serial launcher", -25, `the creator launched ${prior} other tokens on pump.fun, none graduated`);
    else if (prior >= 3 && dev.graduated / prior < 0.1) hit("Weak dev record", -10, `${dev.graduated} of ${prior} earlier launches by this creator graduated`);
    else if (dev.graduated >= 2 && dev.graduated / prior >= 0.3) hit("Dev track record", 5, `${dev.graduated} of ${prior} earlier launches by this creator graduated`);
    if (dev.walletAgeHours !== undefined && dev.walletAgeHours < 24) hit("Fresh dev wallet", -5, `the creator wallet is ${dev.walletAgeHours.toFixed(1)}h old`);
    // Создатель с половиной эмиссии может в любой момент обрушить цену сам: это не «немного много».
    if (dev.holdsPct !== undefined && dev.holdsPct > 50) hit("Dev holds most", -30, `the creator still holds ${pct(dev.holdsPct)}`);
    else if (dev.holdsPct !== undefined && dev.holdsPct > 10) hit("Dev holds a lot", -10, `the creator still holds ${pct(dev.holdsPct)}`);
  }
  if (evm) {
    if (evm.honeypot) hit("Honeypot", -60, "GeckoTerminal flags it: you can buy but not sell");
    if (evm.owner) hit("Owner active", -10, "the deployer still controls the contract (fees, pausing, minting may be possible)");
    // Топ-10 на EVM включает пул ликвидности, поэтому порог выше, чем у Solana.
    if ((evm.top10 ?? 0) > 90) hit("Concentrated", -15, `the top 10 wallets (pool included) hold ${pct(evm.top10!)}`);
    if (evm.holders !== undefined && evm.holders < 50) hit("Few holders", -10, `only ${evm.holders} wallets hold it`);
  }
  if (xr && "program" in xr) for (const f of t22Factors(xr)) hit(f.label, f.impact, f.note);
  else if (xr) for (const f of xrayFactors(xr, !!evm?.owner)) hit(f.label, f.impact, f.note);
  if (siteR) for (const f of siteFactors(siteR)) hit(f.label, f.impact, f.note);
  const realAt = (t: { address: string; chain: string }) => `${t.address.slice(0, 4)}…${t.address.slice(-4)}${t.chain !== chain ? ` on ${chainName(t.chain)}` : ""}`;
  if (listing.kind === "impersonator") hit("Impersonator", -60, `the verified $${symbol} is a different token (${realAt(listing.real)}): this one copies its name`);
  else if (cloneInfo.biggerTwin) hit("Possible copy", -45, `a token worth ${usd(cloneInfo.biggerTwin)} already uses this ticker`);
  else if (listing.kind === "copy-elsewhere") hit("Possible copy", -30, `the verified ${listing.real.name} is ${realAt(listing.real)}, not this token`);
  else if (listing.kind === "ticker-squat") hit("Ticker squat", -25, `$${symbol} belongs to the verified ${listing.real.name} (${realAt(listing.real)})`);
  else if (listing.kind === "ticker-taken") hit("Ticker taken", -10, `the verified $${symbol} is a different token (${realAt(listing.real)})`);
  else if (clones > 2 && !cloneInfo.original) hit("Copycats", -10, `${clones} other tokens share the ticker`);
  const buys = p?.txns?.h1?.buys ?? 0;
  const sells = p?.txns?.h1?.sells ?? 0;
  if (sells > 20 && sells > buys * 2) hit("Sell pressure", -10, `${sells} sells vs ${buys} buys in the last hour`);
  const socials = (p?.info?.websites?.length ?? 0) + (p?.info?.socials?.length ?? 0);
  if (p && !socials && !core) hit("No socials", -5, "no website or socials listed");
  if (p && (p.priceChange?.h1 ?? 0) < -40) hit("Dumping", -10, `${Math.round(p.priceChange?.h1 ?? 0)}% in the last hour`);
  if (telegram.length) hit("On the radar", 5, `mentioned in ${telegram.map((t) => t.channel).join(", ")}`);
  for (const f of factors) score += f.impact;
  score = Math.max(0, Math.min(100, score));
  // Подделка под проверенный токен — DANGER при любых остальных цифрах: она и выглядит хорошо, чтобы обмануть.
  if (listing.kind === "impersonator") score = Math.min(score, 35);
  // Жёсткое правило по данным Track Record (13.10): молодые токены со связанными или свежими кошельками
  // в первые часы массово рушились на 60–98% при вердикте OK/CLEAN. Взвешенная сумма тут обманывает:
  // такой токен не выше RISKY, сколько бы баллов он ни набрал.
  const YOUNG_RISK = ["Bundled", "Linked wallets", "Fresh dev wallet", "Fresh wallets", "Owner active", "Dev holds a lot", "Dev holds most"];
  const youngFlag = market?.ageHours !== undefined && market.ageHours < 24 ? factors.find((f) => YOUNG_RISK.includes(f.label)) : undefined;
  if (youngFlag && score >= 60) {
    hit("Young and linked", -(score - 59), `under a day old with "${youngFlag.label.toLowerCase()}": such launches often dump in the first hours`);
    score = 59;
  }

  // «Слишком рано» — только если явных красных флагов нет: связанные кошельки или серийного создателя видно
  // уже в первые минуты, и молчать о них нельзя.
  const SERIOUS = ["Bundled", "Linked wallets", "Fresh wallets", "Serial launcher", "Possible copy", "Impersonator", "Ticker squat", "Dev holds a lot", "Dev holds most", "Concentrated"];
  const tooEarly =
    !!market && market.ageHours !== undefined && market.ageHours < 0.5 && !holders?.mintAuthority && !holders?.freezeAuthority && !evm?.honeypot && !xray?.findings.some((f) => f.severity === "high") && !factors.some((f) => SERIOUS.includes(f.label));
  const verdict: Verdict = tooEarly ? "TOO_EARLY" : score >= 80 ? "CLEAN" : score >= 60 ? "OK" : score >= 40 ? "RISKY" : "DANGER";
  const worst = [...factors].sort((a, b) => a.impact - b.impact)[0];
  const reason = tooEarly
    ? "Pair is under 30 minutes old: too early to judge"
    : worst && worst.impact < 0
      ? `${worst.label}: ${worst.note}`
      : core
        ? `${core}: a core ${chainName(chain)} asset, not a memecoin`
        : "No red flags found by the crawlers";

  const result: ScanResult = {
    id: address,
    chain,
    symbol: symbol || address.slice(0, 4),
    name: p?.baseToken.name ?? "",
    score: tooEarly ? null : score,
    verdict,
    reason,
    factors,
    market: p
      ? {
          priceUsd: p.priceUsd ? Number(p.priceUsd) : undefined,
          liquidityUsd: p.liquidity?.usd,
          // На кривой DexScreener часто отдаёт FDV в центах — такое не показываем.
          fdv: onCurve && (p.fdv ?? 0) < 1_000 ? undefined : p.fdv,
          volume1h: p.volume?.h1,
          volume24h: p.volume?.h24,
          change1h: p.priceChange?.h1,
          ageHours: market?.ageHours,
          buys1h: buys,
          sells1h: sells,
          url: p.url,
          socials,
        }
      : undefined,
    holders: holders && { top1: holders.top1, top10: holders.top10, mintAuthority: holders.mintAuthority, freezeAuthority: holders.freezeAuthority },
    bundles,
    dev,
    evm,
    xray,
    core,
    clones,
    original: !!cloneInfo.original,
    telegram,
    scannedAt: Date.now(),
  };
  log({
    crawler: "verdict",
    text: `${result.score ?? "—"} ${verdict.replace("_", " ")} · ${reason}`,
    tone: verdict === "CLEAN" || verdict === "OK" ? "ok" : verdict === "TOO_EARLY" ? "info" : "bad",
  });
  const cache = mem().cache;
  cache.delete(address);
  cache.set(address, { result, logs: logs.filter((l) => l.crawler !== "resolver") });
  // Кэш свежих сканов ограничен: Map хранит порядок вставки, самые старые уходят первыми.
  while (cache.size > 2_000) cache.delete(cache.keys().next().value!);
  if (opts.record !== false) remember(result);
  // Каждый вердикт попадает в Track Record: через сутки видно, сбылся ли он.
  trackVerdict(result, opts.src ?? (opts.record === false ? "crawler" : "scan"));
  return result;
}

// Отчёты X-Ray в общий вид для интерфейса: одинаковые строки для EVM и Solana.
function xrayViewEvm(x: XRayReport, ownerActive: boolean): XRayView {
  const live = xrayLive(x, ownerActive);
  const dead = x.powers.length - live.filter((p) => p.key !== "selfdestruct").length;
  const proxy = x.proxy ? ` · proxy (${x.proxy.kind})` : "";
  return {
    kind: "evm",
    summary: `read ${x.selectors} functions from the bytecode${x.unknown ? `, ${x.unknown} unknown` : ""}${x.engine ? " · storage traced (evmole)" : ""}${proxy}${dead > 0 ? ` · ${dead} owner power${dead > 1 ? "s" : ""} dead (ownership renounced)` : ""}`,
    findings: live.map((p) => ({ label: p.label, note: p.note, severity: p.severity, detail: p.fns.length ? p.fns.slice(0, 4).join(", ") : undefined })),
  };
}

function xrayViewSol(r: T22Report): XRayView {
  return {
    kind: "solana",
    summary: r.program === "spl" ? "classic SPL token: no extensions" : `Token-2022 · ${r.extensions.length ? `${r.extensions.length} extension${r.extensions.length > 1 ? "s" : ""} of note` : "metadata only"}`,
    findings: r.extensions.map((e) => ({ label: e.label, note: e.note, severity: e.severity, detail: e.detail })),
  };
}

function devTone(d: DevReport): ScanLog["tone"] {
  const prior = d.launched - 1;
  if ((prior >= 10 && d.graduated === 0) || (d.holdsPct ?? 0) > 10) return "bad";
  if ((prior >= 3 && d.graduated / prior < 0.1) || (d.walletAgeHours ?? 99) < 24) return "warn";
  return "ok";
}

// Лента «recently scanned»: последние 30 сканов, переживают перезапуск.
export interface RecentScan {
  id: string;
  chain: string;
  symbol: string;
  score: number | null;
  verdict: Verdict;
  at: number;
}

function remember(r: ScanResult) {
  const list = recentScans().filter((x) => x.id !== r.id);
  list.unshift({ id: r.id, chain: r.chain, symbol: r.symbol, score: r.score, verdict: r.verdict, at: r.scannedAt });
  setMeta(RECENT_KEY, JSON.stringify(list.slice(0, 30)));
  // Новый скан не затирает свежую сводку из X: за неё уже заплачено.
  const x = savedBuzz(r.id);
  save(x ? { ...r, x } : r);
}

// Полные результаты последних сканов: по ним строится страница /scan/<адрес> и картинка для X.
function savedScans(): ScanResult[] {
  try {
    return JSON.parse(getMeta(SAVED_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function save(r: ScanResult) {
  const list = savedScans().filter((x) => x.id !== r.id);
  list.unshift(r);
  setMeta(SAVED_KEY, JSON.stringify(list.slice(0, SAVED_MAX)));
}

export function savedScan(id: string): ScanResult | undefined {
  return savedScans().find((x) => x.id === id);
}

// Сводка из X, сохранённая с прошлого скана, если она ещё свежая: переживает перезапуск, повторно не платим.
export function savedBuzz(id: string): XBuzz | null {
  const x = savedScan(id)?.x;
  return x && Date.now() - x.at < BUZZ_TTL_MS ? x : null;
}

// Сводка из X пришла позже вердикта — дописываем её в сохранённый скан.
export function attachBuzz(id: string, x: XBuzz) {
  const r = savedScan(id);
  if (r) save({ ...r, x });
}

export function recentScans(): RecentScan[] {
  try {
    return JSON.parse(getMeta(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}
