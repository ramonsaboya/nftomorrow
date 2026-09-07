import test from 'node:test';
import assert from 'node:assert/strict';
import { COLLECTIONS } from '../src/collections.js';
import { parseFloor, parseRates, fetchSnapshot, priceIn, validateSnapshot, MAX_AGE_MS } from '../src/prices.js';
import { getJson } from '../src/http.js';

const now = 1_800_000_000_000;
const config = { displayCurrency: 'GBP', thresholds: [] };
test('parses integer lamports and rejects absent, zero, negative, unsafe and mismatched prices', () => {
  assert.equal(parseFloor({ floorPrice: 1_230_000_000 }, 'example'), 1_230_000_000);
  for (const floorPrice of [null, undefined, '100', 0, -1, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseFloor({ floorPrice }, 'example'));
  }
  assert.throws(() => parseFloor({ floorPrice: 100, listedCount: 0 }, 'example'));
  assert.throws(() => parseFloor({ floorPrice: 100, symbol: 'different' }, 'example'));
});
test('fetches complete aggregate floors and fresh optional conversion', async () => {
  const calls = [];
  const snapshot = await fetchSnapshot(config, { now: () => now, request: async (url) => {
    calls.push(url);
    return url.includes('coingecko') ? { solana: { gbp: 100, last_updated_at: now / 1000 } }
      : { floorPrice: 2_000_000_000 };
  } });
  assert.equal(snapshot.lamports.medallion, 6_000_000_000);
  assert.equal(priceIn(snapshot, 'medallion', 'SOL', now), 6);
  assert.equal(priceIn(snapshot, 'medallion', 'GBP', now), 600);
  assert.equal(calls.filter((url) => url.endsWith('listingAggMode=true')).length, 3);
  assert.throws(() => validateSnapshot(snapshot, now + MAX_AGE_MS + 1));
  for (const { id } of COLLECTIONS) assert.equal(snapshot.lamports[id], 2_000_000_000);
});
test('failed collection invalidates the entire check instead of using cached/zero floors', async () => {
  await assert.rejects(fetchSnapshot(config, { now: () => now, request: async (url) => {
    if (url.includes('tomorrowland_winter')) throw new Error('outage');
    return { floorPrice: 2_000_000_000 };
  } }), /Incomplete/);
});
test('stale or invalid FX disables fiat but preserves SOL', async () => {
  for (const row of [{}, { solana: { gbp: 100, last_updated_at: (now - MAX_AGE_MS - 1) / 1000 } },
    { solana: { gbp: 0, last_updated_at: now / 1000 } },
    { solana: { gbp: 100, last_updated_at: (now + 120_000) / 1000 } }]) {
    assert.throws(() => parseRates(row, ['GBP'], now));
  }
  const snapshot = await fetchSnapshot(config, { now: () => now, request: async (url) =>
    url.includes('coingecko') ? {} : { floorPrice: 1_000_000_000 } });
  assert.equal(snapshot.fxFailed, true);
  assert.equal(priceIn(snapshot, 'medallion', 'GBP', now), null);
  assert.equal(priceIn(snapshot, 'medallion', 'SOL', now), 3);
});
test('HTTP retries are bounded and do not retry permanent client errors', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 503 }; };
  await assert.rejects(getJson('https://example.test', { fetchImpl, pause: async () => {} }));
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(getJson('https://example.test', { fetchImpl: async () => {
    calls++; return { ok: false, status: 404 };
  }, pause: async () => {} }));
  assert.equal(calls, 1);
});
