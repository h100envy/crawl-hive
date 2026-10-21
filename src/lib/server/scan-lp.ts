// LP (crawler_lp): кто держит ликвидность и когда её можно вытащить. «Чистый контракт с LP, который
// разлочится через неделю, — это руг с датой». Solana — по отчёту RugCheck (доля сожжённого или залоченного LP
// в главном пуле, локеры с датами), BNB Chain и Base — по GoPlus (держатели LP-токена, отметка лока и дата окончания).
// Монеты на кривой лаунчпада LP ещё не имеют — вытащить нечего. Для Robinhood Chain источника пока нет.
import "server-only";
import { goplusEndTimeMs } from "./goplus-time";

export interface LpReport {
  status: "burned" | "locked" | "partly" | "unlocked" | "curve" | "unknown";
  lockedPct: number | null; // сожжено + залочено, % LP главного пула
  unlockAt?: number; // ближайший анлок залоченной части, мс
  locker?: string; // название локера, если известно
  pool?: string; // тип пула (pump_fun_amm, raydium, meteoraDlmm…)
  source: "rugcheck" | "goplus";
}

const CACHE_MS = 10 * 60_000;
// chainId GoPlus для сетей, где он знает держателей LP.
const GOPLUS_CHAIN: Record<string, number> = { bsc: 56, base: 8453 };
export const lpSupported = (chain: string) => chain in GOPLUS_CHAIN;
const g = globalThis as unknown as { __crawlhiveLp?: Map<string, { at: number; r: LpReport | null }> };
const cache = () => (g.__crawlhiveLp ??= new Map());

// pool — главный пул токена по DexScreener: GoPlus знает держателей LP только у пулов типа v2, и если главная
// ликвидность в другом пуле (v3, Aerodrome), его цифры про мелкий пул вводили бы в заблуждение.
export async function traceLp(chain: string, token: string, onCurve: boolean, pool?: string): Promise<LpReport | null> {
  if (onCurve) return { status: "curve", lockedPct: null, source: chain === "solana" ? "rugcheck" : "goplus" };
  const key = `${chain}:${token.toLowerCase()}:${pool?.toLowerCase() ?? ""}`;
  const hit = cache().get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.r;
  const r = chain === "solana" ? await fromRugcheck(token) : lpSupported(chain) ? await fromGoplus(token, GOPLUS_CHAIN[chain], pool) : null;
  if (cache().size > 5000) cache().clear();
  cache().set(key, { at: Date.now(), r });
  return r;
}

const statusOf = (pct: number): LpReport["status"] => (pct >= 99 ? "locked" : pct >= 50 ? "partly" : "unlocked");

async function fromRugcheck(mint: string): Promise<LpReport | null> {
  const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res?.ok) return null;
  const j = (await res.json().catch(() => null)) as {
    markets?: { marketType?: string; lp?: { lpLockedPct?: number; quoteUSD?: number; lpMint?: string; lpTotalSupply?: number } }[];
    lockers?: Record<string, { unlockDate?: number; usdcLocked?: number; type?: string; programID?: string }>;
  } | null;
  // Пулы с позициями вместо LP-токена (Meteora DLMM, CLMM, Orca): у них lpMint — системная программа и нулевой
  // выпуск, «0% locked» там ничего не значит. Судим только пулы, где LP-токен есть (PumpSwap, Raydium и подобные).
  const SYSTEM = "11111111111111111111111111111111";
  const market = (j?.markets ?? [])
    .filter((m) => m.lp && m.lp.lpMint && m.lp.lpMint !== SYSTEM && (m.lp.lpTotalSupply ?? 0) > 0)
    .sort((a, b) => (b.lp?.quoteUSD ?? 0) - (a.lp?.quoteUSD ?? 0))[0];
  if (!market?.lp) return null;
  const pct = Math.round((market.lp.lpLockedPct ?? 0) * 10) / 10;
  const lockers = Object.values(j?.lockers ?? {}).filter((l) => (l.unlockDate ?? 0) > Date.now() / 1000);
  const next = lockers.sort((a, b) => (a.unlockDate ?? 0) - (b.unlockDate ?? 0))[0];
  // Пулы PumpSwap сжигают LP при миграции с кривой: 100% «залочено» там значит «сожжено навсегда».
  const burnedPool = /pump_fun_amm|pumpswap/i.test(market.marketType ?? "") && pct >= 99 && !next;
  return {
    status: burnedPool ? "burned" : statusOf(pct),
    lockedPct: pct,
    ...(next?.unlockDate ? { unlockAt: next.unlockDate * 1000, locker: next.type ?? undefined } : {}),
    pool: market.marketType,
    source: "rugcheck",
  };
}

const DEAD = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead", "0xdead000000000000000000000000000000000000"]);

async function fromGoplus(token: string, chainId: number, pool?: string): Promise<LpReport | null> {
  const res = await fetch(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${token}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res?.ok) return null;
  const j = (await res.json().catch(() => null)) as {
    result?: Record<string, { lp_holders?: { address: string; tag?: string; percent?: string; is_locked?: number; locked_detail?: { end_time?: string }[] }[]; dex?: { pair?: string; liquidity_type?: string }[] }>;
  } | null;
  const t = Object.values(j?.result ?? {})[0];
  const main = pool && t?.dex?.find((d) => d.pair?.toLowerCase() === pool.toLowerCase());
  if (!main || !/v2/i.test(main.liquidity_type ?? "")) return null;
  const holders = t?.lp_holders ?? [];
  if (!holders.length) return null;
  // Свежий пул GoPlus индексирует не сразу: держатели в сумме дают меньше половины LP — данных ещё нет.
  if (holders.reduce((s, h) => s + Number(h.percent ?? 0), 0) < 0.5) return null;
  let burned = 0;
  let locked = 0;
  let unlockAt: number | undefined;
  let locker: string | undefined;
  for (const h of holders) {
    const p = Number(h.percent ?? 0) * 100;
    if (DEAD.has(h.address.toLowerCase())) burned += p;
    else if (h.is_locked === 1) {
      locked += p;
      for (const d of h.locked_detail ?? []) {
        const end = goplusEndTimeMs(d.end_time);
        if (end !== undefined && end > Date.now() && (!unlockAt || end < unlockAt)) {
          unlockAt = end;
          locker = h.tag || undefined;
        }
      }
    }
  }
  const pct = Math.round((burned + locked) * 10) / 10;
  return { status: burned >= 99 ? "burned" : statusOf(pct), lockedPct: pct, ...(unlockAt ? { unlockAt, locker } : {}), source: "goplus" };
}
