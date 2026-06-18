type Cache = { usd: number; fetchedAt: number };
let cache: Cache | null = null;
const TTL_MS = 60_000;

export async function getBtcUsd(): Promise<number> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.usd;
  try {
    const res = await fetch("https://mempool.space/api/v1/prices", { cache: "no-store" });
    if (!res.ok) throw new Error(`mempool ${res.status}`);
    const data = (await res.json()) as { USD?: number };
    if (typeof data.USD !== "number") throw new Error("no USD price");
    cache = { usd: data.USD, fetchedAt: Date.now() };
    return data.USD;
  } catch {
    if (cache) return cache.usd;
    return 100_000;
  }
}

export function usdToSats(usd: number, btcUsd: number): number {
  if (btcUsd <= 0) return 0;
  return Math.round((usd / btcUsd) * 100_000_000);
}
