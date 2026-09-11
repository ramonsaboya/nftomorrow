import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, loadConfig } from '../src/config.js';
import { formatPrices } from '../src/message.js';
import { fetchSnapshot } from '../src/prices.js';
import { Health } from '../src/health.js';

test('currency and target validation fail closed on configuration mistakes', () => {
  const config = { groupId: null, displayCurrency: 'GBP', thresholds: [{ target: 'medallion', currency: 'SOL', below: 5 }] };
  assert.equal(validateConfig(config), config);
  for (const patch of [{ displayCurrency: 'CAD' }, { groupId: '123@s.whatsapp.net' },
    { thresholds: [{ target: 'typo', currency: 'SOL', below: 5 }] },
    { thresholds: [{ target: 'medallion', currency: 'GBP', below: '5' }] },
    { thresholds: [config.thresholds[0], config.thresholds[0]] }, { sendEnabled: true }]) {
    assert.throws(() => validateConfig({ ...config, ...patch }));
  }
  assert.throws(() => loadConfig({ CONFIG_PATH: 'config.example.json', HEALTHCHECK_PRICES_URL: 'http://bad' }));
});
test('compact USD message converts the total and shows the matching fresh SOL rate', async () => {
  const now = Date.parse('2026-09-07T18:05:00Z');
  const snapshot = await fetchSnapshot({ displayCurrency: 'USD', thresholds: [] }, {
    now: () => now, request: async (url) => url.includes('coingecko')
      ? { solana: { usd: 150.25, last_updated_at: now / 1000 } }
      : { floorPrice: 1_000_000_000 },
  });
  validateConfig({ groupId: null, displayCurrency: 'USD', thresholds: [] });
  const text = formatPrices(snapshot, { displayCurrency: 'USD', now });
  assert.equal(text, 'Medallion:\n  450.75 USD\n  3.00 SOL\n\n1 SOL = 150.25 USD\n\n\nLetter: 1.00 SOL\nReflection: 1.00 SOL\nSymbol: 1.00 SOL\n\n07 Sept 2026, 19:05 BST');
  assert.match(text, /Reflection: 1.00 SOL/);
  assert.match(text, /1 SOL = 150\.25 USD/);
  assert.match(text, /19:05 BST$/);
  assert.doesNotMatch(text, /https:|TEST|Fees|changes since/);
  snapshot.fx.updatedAt -= 300_001;
  const stale = formatPrices(snapshot, { displayCurrency: 'USD', now });
  assert.match(stale, /Medallion:\n  USD unavailable\n  3.00 SOL/);
  assert.match(stale, /1 SOL = unavailable/);
  assert.doesNotMatch(stale, /150\.25|450\.75/);
});
test('health failure signals email integration without revealing ping secrets in logs', async () => {
  const calls = [], logs = [];
  const health = new Health({ whatsapp: 'https://hc-ping.com/secret' }, {
    fetchImpl: async (url) => { calls.push(url); throw new Error(url); }, log: (...args) => logs.push(args),
  });
  await health.ping('whatsapp', false);
  assert.equal(calls[0], 'https://hc-ping.com/secret/fail');
  assert.doesNotMatch(JSON.stringify(logs), /secret/);
  await health.ping('prices', true);
  assert.equal(calls.length, 1);
});
