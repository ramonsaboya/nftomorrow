import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { StatusCommand } from '../src/status-command.js';
import { Monitor } from '../src/monitor.js';
import { COLLECTIONS } from '../src/collections.js';

function harness() {
  const store = new Store(':memory:');
  let now = Date.parse('2026-09-08T12:00:00Z'), fetches = 0;
  const sends = [], pings = [];
  const config = { groupId: '123@g.us', displayCurrency: 'USD', dailySummaryTime: '18:00',
    thresholds: [{ target: 'medallion', currency: 'USD', below: 6500 }] };
  const whatsapp = { connected: true, generation: 1, async send(id, text) {
    assert.equal(store.deliveries().at(-1).status, 'attempting');
    sends.push({ id, text });
  } };
  whatsapp.replyStatus = async (id, text, chatId) => { await whatsapp.send(id, text); sends.at(-1).chatId = chatId; };
  const dependencies = { store, config, whatsapp, now: () => now,
    health: { async ping(...args) { pings.push(args); } },
    async getSnapshot() {
      fetches++;
      return { observedAt: now, lamports: { ...Object.fromEntries(COLLECTIONS.map(({ id }) => [id, 1e9])), medallion: 3e9 },
        fx: { rates: { USD: 100 }, updatedAt: now }, fxFailed: false };
    } };
  return { store, whatsapp, sends, pings, dependencies, command: new StatusCommand(dependencies),
    advance: (ms) => { now += ms; }, fetches: () => fetches };
}

test('status cooldown and reply destination are independent across unregistered groups', async () => {
  const h = harness();
  try {
    const destinations = [];
    h.whatsapp.replyStatus = async (_id, text, chatId) => {
      assert.match(text, /Medallion USD/); destinations.push(chatId);
    };
    for (const chat of ['999@g.us', '888-777@g.us']) {
      assert.equal(h.command.request('same-id', chat), true);
      await h.command.runPending();
      assert.equal(h.command.request('another-id', chat), false);
    }
    assert.deepEqual(destinations, ['999@g.us', '888-777@g.us']);
  } finally { h.store.close(); }
});

test('fresh status replies are audited and leave automatic alert and summary scheduling intact', async () => {
  const h = harness();
  try {
    const monitor = new Monitor(h.dependencies);
    const before = h.store.get(monitor.stateKey);
    assert.equal(h.command.request('request-1'), true);
    await h.command.runPending();
    assert.equal(h.fetches(), 1);
    assert.match(h.sends[0].text, /300.00  Medallion USD\n  3.00  Medallion SOL\n100.00  SOL to USD/);
    assert.match(h.sends[0].text, /08 Sept 2026, 13:00 BST$/);
    assert.equal(h.store.deliveries()[0].data.kind, 'status');
    assert.equal(h.store.deliveries()[0].status, 'acknowledged');
    assert.deepEqual(h.store.get(monitor.stateKey), before);
    await monitor.poll();
    assert.equal(h.sends.length, 2);
    assert.equal(h.store.deliveries()[1].data.kind, 'alert');
  } finally { h.store.close(); }
});

test('cooldown, duplicate suppression and acceptance persist across handler restarts', async () => {
  const h = harness();
  try {
    h.command.request('one');
    assert.equal(h.command.request('two'), false);
    await Promise.all([h.command.runPending(), h.command.runPending()]);
    assert.equal(h.sends.length, 1);
    const restarted = new StatusCommand(h.dependencies);
    await restarted.runPending(); // No pending request restored.
    assert.equal(restarted.request('two'), false);
    h.advance(60_000);
    assert.equal(restarted.request('one'), false);
    assert.equal(restarted.request('two'), true);
    await restarted.runPending();
    assert.equal(h.fetches(), 2);
  } finally { h.store.close(); }
});

test('requests during a fetch are dropped, and concurrent drains share one reply', async () => {
  const h = harness();
  try {
    let resolve;
    const original = h.command.getSnapshot;
    h.command.getSnapshot = () => new Promise((done) => { resolve = done; });
    h.command.request('one');
    const first = h.command.runPending();
    h.advance(60_000);
    assert.equal(h.command.request('two'), false);
    const second = h.command.runPending();
    resolve(await original());
    await Promise.all([first, second]);
    assert.equal(h.sends.length, 1);
  } finally { h.store.close(); }
});

test('failed prices report unavailable; failed FX still returns SOL with no cached fiat', async () => {
  for (const failure of ['prices', 'fx']) {
    const h = harness();
    try {
      const original = h.command.getSnapshot;
      h.command.getSnapshot = async () => {
        if (failure === 'prices') throw new Error('private upstream details');
        return { ...await original(), fx: null, fxFailed: true };
      };
      h.command.request('one'); await h.command.runPending();
      assert.match(h.sends[0].text, failure === 'prices' ? /Current prices are unavailable/ : /unavailable  Medallion USD\n +3.00  Medallion SOL/);
      assert.doesNotMatch(h.sends[0].text, /private upstream details/);
      assert.deepEqual(h.pings[0], ['prices', false]);
    } finally { h.store.close(); }
  }
});

test('disconnect, reconnect and expiry discard requests before sending', async () => {
  for (const when of ['pending', 'fetching']) {
    for (const reason of ['disconnect', 'reconnect', 'expiry']) {
      const h = harness();
      try {
        const invalidate = () => {
          if (reason === 'disconnect') h.whatsapp.connected = false;
          if (reason === 'reconnect') h.whatsapp.generation++;
          if (reason === 'expiry') h.advance(301_000);
        };
        h.command.request('one');
        if (when === 'pending') invalidate();
        else {
          const original = h.command.getSnapshot;
          h.command.getSnapshot = async () => { const value = await original(); invalidate(); return value; };
        }
        await h.command.runPending();
        assert.equal(h.sends.length, 0);
        assert.equal(h.store.deliveries().length, 0);
      } finally { h.store.close(); }
    }
  }
});

test('uncertain delivery is recorded and never automatically retried', async () => {
  const h = harness();
  try {
    h.whatsapp.send = async () => { throw new Error('Lost acknowledgement'); };
    h.command.request('one'); await h.command.runPending();
    assert.equal(h.store.deliveries()[0].status, 'uncertain');
    assert.equal(h.store.get('deliveryUncertain'), true);
    assert.deepEqual(h.pings.at(-1), ['whatsapp', false]);
    h.advance(60_000);
    assert.equal(h.command.request('one'), false);
    await h.command.runPending();
    assert.equal(h.store.deliveries().length, 1);
  } finally { h.store.close(); }
});

test('private status replies stay in the requesting chat', async () => {
  const h = harness();
  try {
    h.command.request('private', '789@lid');
    await h.command.runPending();
    assert.equal(h.sends[0].chatId, '789@lid');
    assert.equal(h.store.deliveries()[0].data.chatId, '789@lid');
  } finally { h.store.close(); }
});

test('custom status range is audited with four album images', async () => {
  const h = harness();
  try {
    let images;
    h.whatsapp.replyStatus = async (_id, _text, _chat, buffers) => { images = buffers; };
    assert.equal(h.command.request('invalid', '789@lid', '400d'), false);
    assert.equal(h.command.request('range', '789@lid', '7d'), true);
    await h.command.runPending();
    assert.equal(images.length, 4);
    assert.equal(h.store.deliveries()[0].data.days, 7);
    assert.doesNotMatch(h.store.deliveries()[0].data.text, /\(1 SOL\)/);
    assert.equal(h.store.deliveries()[0].data.imageCount, 4);
  } finally { h.store.close(); }
});
