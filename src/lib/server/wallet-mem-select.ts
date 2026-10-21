// Чистый выбор по памяти кошельков (walletMem из scan-operators.ts), без "server-only", чтобы было легко
// тестировать отдельно: нужные /dev/<кошелёк> страницы для sitemap.xml — кошельки, которых память видела
// в роли "dev", самые недавно обновлённые первыми (ключи объекта хранятся в порядке вставки — старые первые,
// см. rememberWallets: delete+переприсвоение переставляет кошелёк в конец при каждом новом сигнале о нём).
export interface MemEntryLike {
  t: string;
  c: string;
  r: string;
}
export type MemLike = Record<string, (string | MemEntryLike)[]>;

const toEntries = (list: (string | MemEntryLike)[] | undefined): MemEntryLike[] =>
  (list ?? []).map((e) => (typeof e === "string" ? { t: e, c: "solana", r: "linked" } : e));

export function recentDevWalletsFrom(mem: MemLike, limit: number): string[] {
  if (limit <= 0) return [];
  const out: string[] = [];
  const keys = Object.keys(mem);
  for (let i = keys.length - 1; i >= 0 && out.length < limit; i--) {
    const w = keys[i];
    if (toEntries(mem[w]).some((e) => e.r === "dev")) out.push(w);
  }
  return out;
}
