import { COLLECTIONS, LAMPORTS_PER_SOL } from './collections.js';
import { getJson } from './http.js';

export const MAX_AGE_MS = 5 * 60_000;

export function parseFloor(data, symbol) {
  if (!data || (data.symbol !== undefined && data.symbol !== symbol)
      || !Number.isSafeInteger(data.floorPrice) || data.floorPrice <= 0
      || (data.listedCount !== undefined
        && (!Number.isSafeInteger(data.listedCount) || data.listedCount <= 0))) {
    throw new Error(`Invalid floor for ${symbol}`);
  }
  return data.floorPrice;
}

export function parseRates(data, currencies, now) {
  const row = data?.solana;
  const updatedAt = row?.last_updated_at * 1000;
  if (typeof row?.last_updated_at !== 'number' || !Number.isFinite(updatedAt)
      || updatedAt > now + 60_000 || now - updatedAt > MAX_AGE_MS) {
    throw new Error('Exchange rates missing or stale');
  }
  const rates = {};
  for (const currency of currencies) {
    const rate = row[currency.toLowerCase()];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new Error('Invalid exchange rate');
    }
    rates[currency] = rate;
  }
  return { rates, updatedAt };
}

export function validateSnapshot(snapshot, now = Date.now()) {
  if (!snapshot || !Number.isFinite(snapshot.observedAt)
      || now - snapshot.observedAt > MAX_AGE_MS || snapshot.observedAt > now + 60_000) {
    throw new Error('Stale or invalid observation');
  }
  let total = 0;
  for (const { id } of COLLECTIONS) {
    const floor = snapshot.lamports?.[id];
    if (!Number.isSafeInteger(floor) || floor <= 0) throw new Error('Incomplete observation');
    total += floor;
  }
  if (!Number.isSafeInteger(total) || total !== snapshot.lamports.medallion) {
    throw new Error('Invalid Medallion total');
  }
}

export function priceIn(snapshot, target, currency, now = Date.now()) {
  validateSnapshot(snapshot, now);
  const sol = snapshot.lamports[target] / LAMPORTS_PER_SOL;
  if (currency === 'SOL') return sol;
  const rate = snapshot.fx?.rates[currency];
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(snapshot.fx?.updatedAt)
      || now - snapshot.fx.updatedAt > MAX_AGE_MS || snapshot.fx.updatedAt > now + 60_000) return null;
  const converted = sol * rate;
  return Number.isFinite(converted) ? converted : null;
}

export async function fetchSnapshot(config, { request = getJson, now = Date.now, apiKey = '' } = {}) {
  const startedAt = now();
  const results = await Promise.allSettled(COLLECTIONS.map(async ({ id }) => {
    const data = await request(`https://api-mainnet.magiceden.dev/v2/collections/${id}/stats?listingAggMode=true`);
    return [id, parseFloor(data, id)];
  }));
  if (results.some((r) => r.status === 'rejected')) throw new Error('Incomplete Magic Eden price check');
  const lamports = Object.fromEntries(results.map((r) => r.value));
  lamports.medallion = Object.values(lamports).reduce((a, b) => a + b, 0);
  const currencies = [...new Set(['USD', config.displayCurrency, ...config.thresholds.map((t) => t.currency)])]
    .filter((c) => c && c !== 'SOL');
  let fx = null;
  let fxFailed = false;
  if (currencies.length) {
    try {
      const data = await request(`https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=${currencies.map((c) => c.toLowerCase()).join(',')}&include_last_updated_at=true`, {
        headers: apiKey ? { 'x-cg-demo-api-key': apiKey } : {},
      });
      fx = parseRates(data, currencies, now());
    } catch { fxFailed = true; }
  }
  const snapshot = { observedAt: startedAt, lamports, fx, fxFailed };
  validateSnapshot(snapshot, now());
  return snapshot;
}
