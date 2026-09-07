import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Monitor } from '../src/monitor.js';
import { dailySlot, HOUR_MS } from '../src/schedule.js';
import { COLLECTIONS } from '../src/collections.js';

const config = { groupId: '123@g.us', displayCurrency: 'USD', dailySummaryTime: '18:00',
  thresholds: [{ target: 'medallion', currency: 'USD', below: 6500 }] };
function harness({ at = '2026-09-07T15:00:00Z', path = ':memory:', settings = config } = {}) {
  const store = new Store(path);
  let now = Date.parse(at), total = 64, fxFailed = false, fetchFail = false, sendFail = false, fetches = 0;
  const sends = [], pings = [];
  const whatsapp = { connected: true, generation: 1, async send(id, text) {
    sends.push({ id, text });
    if (sendFail) throw new Error('Ambiguous send');
  } };
  const getSnapshot = async () => {
    fetches++;
    if (fetchFail) throw new Error('Upstream down');
    const lamports = Object.fromEntries(COLLECTIONS.map(({ id }, i) => [id, i === 0 ? Math.round(total * 1e9) - 2e9 : 1e9]));
    return { observedAt: now, lamports: { ...lamports, medallion: Math.round(total * 1e9) }, fxFailed,
      fx: fxFailed ? null : { rates: { USD: 100 }, updatedAt: now } };
  };
  const dependencies = { config: settings, store, whatsapp, getSnapshot, now: () => now,
    health: { async ping(...args) { pings.push(args); } } };
  return { store, whatsapp, sends, pings, dependencies, monitor: new Monitor(dependencies),
    advance: (ms) => { now += ms; }, setTotal: (value) => { total = value; },
    failFx: () => { fxFailed = true; }, failFetch: () => { fetchFail = true; },
    failSend: () => { sendFail = true; }, fetches: () => fetches,
    close: () => store.close() };
}

test('below 6500 alerts at startup and every hour, without recovery or duplicate same-hour attempts', async () => {
  const h = harness();
  try {
    await h.monitor.poll();
    assert.equal(h.sends.length, 1);
    assert.match(h.sends[0].text, /Below threshold: Medallion < 6,500 USD/);
    await h.monitor.poll();
    assert.equal(h.sends.length, 1);
    h.advance(HOUR_MS);
    await h.monitor.poll();
    assert.equal(h.sends.length, 2);
    h.setTotal(65); h.advance(HOUR_MS); await h.monitor.poll();
    assert.equal(h.sends.length, 2); // Exactly equal does not trigger.
    h.setTotal(64.99); h.advance(HOUR_MS); await h.monitor.poll();
    assert.equal(h.sends.length, 3); // No 1% recovery requirement.
  } finally { h.close(); }
});

test('daily summary at 18:00 London repeats next day and is suppressed after an alert', async () => {
  const h = harness();
  try {
    h.setTotal(70); await h.monitor.poll();
    assert.equal(h.sends.length, 0);
    h.advance(2 * HOUR_MS); await h.monitor.poll(); // 18:00 BST
    assert.equal(h.sends.length, 1);
    assert.equal(h.store.deliveries()[0].data.kind, 'summary');
    await h.monitor.poll(); assert.equal(h.sends.length, 1);
    h.advance(24 * HOUR_MS); await h.monitor.poll();
    assert.equal(h.sends.length, 2);
    h.advance(HOUR_MS); h.setTotal(64); await h.monitor.poll();
    assert.equal(h.sends.length, 3);
    h.advance(23 * HOUR_MS); h.setTotal(70); await h.monitor.poll();
    assert.equal(h.sends.length, 3);
  } finally { h.close(); }
});

test('simultaneous collection triggers and daily slot become one compact message', async () => {
  const h = harness({ settings: { ...config, thresholds: [...config.thresholds,
    { target: 'the_reflection_of_love', currency: 'SOL', below: 2 }] } });
  try {
    h.advance(2 * HOUR_MS); await h.monitor.poll();
    assert.equal(h.sends.length, 1);
    assert.equal(h.store.deliveries()[0].data.kind, 'alert-and-summary');
    assert.equal(h.store.deliveries()[0].data.triggered.length, 2);
  } finally { h.close(); }
});

test('London daily slots respect both DST changes and repeated local times', () => {
  assert.equal(dailySlot(Date.parse('2026-03-28T17:59:00Z'), '18:00'), '2026-03-27');
  assert.equal(dailySlot(Date.parse('2026-03-28T18:00:00Z'), '18:00'), '2026-03-28');
  assert.equal(dailySlot(Date.parse('2026-03-29T17:00:00Z'), '18:00'), '2026-03-29');
  assert.equal(dailySlot(Date.parse('2026-10-24T17:00:00Z'), '18:00'), '2026-10-24');
  assert.equal(dailySlot(Date.parse('2026-10-25T17:59:00Z'), '18:00'), '2026-10-24');
  assert.equal(dailySlot(Date.parse('2026-10-25T18:00:00Z'), '18:00'), '2026-10-25');
});

test('price checks and history continue offline; reconnect fetches current prices without a backlog', async () => {
  const h = harness();
  try {
    h.whatsapp.connected = false;
    await h.monitor.poll(); h.advance(HOUR_MS); await h.monitor.poll();
    assert.equal(h.sends.length, 0);
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS count FROM observations').get().count, 2);
    h.setTotal(70); h.whatsapp.connected = true; h.whatsapp.generation++;
    await h.monitor.poll(); assert.equal(h.sends.length, 0);
    assert.equal(h.fetches(), 3);
  } finally { h.close(); }
});

test('socket generation change while fetching discards that observation for sending', async () => {
  const h = harness();
  try {
    const original = h.monitor.getSnapshot;
    h.monitor.getSnapshot = async (...args) => {
      const snapshot = await original(...args); h.whatsapp.generation++; return snapshot;
    };
    await h.monitor.poll(); assert.equal(h.sends.length, 0);
    h.monitor.getSnapshot = original;
    await h.monitor.poll(); assert.equal(h.sends.length, 1);
  } finally { h.close(); }
});

test('failed prices or missing fresh FX never trigger a USD alert', async () => {
  for (const kind of ['fx', 'prices']) {
    const h = harness();
    try {
      if (kind === 'fx') h.failFx(); else h.failFetch();
      await h.monitor.poll();
      assert.equal(h.sends.length, 0);
      assert.deepEqual(h.pings[0], ['prices', false]);
    } finally { h.close(); }
  }
});

test('disk restart preserves delivery deduplication; next hour still repeats after an uncertain send', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nftomorrow-monitor-'));
  const path = join(dir, 'monitor.sqlite');
  try {
    const first = harness({ path });
    first.failSend(); await first.monitor.poll();
    assert.equal(first.store.deliveries()[0].status, 'uncertain');
    assert.equal(first.store.get('deliveryUncertain'), true);
    first.close();
    const second = harness({ path });
    try {
      await second.monitor.poll(); assert.equal(second.sends.length, 0);
      second.advance(HOUR_MS); await second.monitor.poll();
      assert.equal(second.sends.length, 1);
      assert.equal(second.store.get('deliveryUncertain'), false);
    } finally { second.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent polling coalesces into one check and one send', async () => {
  const h = harness();
  try {
    await Promise.all([h.monitor.poll(), h.monitor.poll()]);
    assert.equal(h.fetches(), 1);
    assert.equal(h.sends.length, 1);
  } finally { h.close(); }
});

test('missed daily slots after downtime produce at most one fresh summary', async () => {
  const h = harness();
  try {
    h.setTotal(70); h.whatsapp.connected = false;
    h.advance(3 * 24 * HOUR_MS); await h.monitor.poll();
    assert.equal(h.sends.length, 0);
    h.whatsapp.connected = true; h.whatsapp.generation++;
    await h.monitor.poll(); await h.monitor.poll();
    assert.equal(h.sends.length, 1);
  } finally { h.close(); }
});
