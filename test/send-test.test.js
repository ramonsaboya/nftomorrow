import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { COLLECTIONS } from '../src/collections.js';
import { sendPriceTest } from '../src/manual-send.js';

const now = Date.now();
const snapshot = { observedAt: now,
  lamports: { ...Object.fromEntries(COLLECTIONS.map(({ id }) => [id, 1_000_000_000])), medallion: 3_000_000_000 },
  fx: null, fxFailed: false };
const config = { groupId: '123@g.us', displayCurrency: 'SOL', thresholds: [] };

test('test command reserves a single fresh message before sending and records acknowledgement', async () => {
  const store = new Store(':memory:');
  let count = 0;
  try {
    const id = await sendPriceTest({ config, store, now: () => now,
      getSnapshot: async () => snapshot,
      whatsapp: { groupId: config.groupId, connected: true, send: async (id, text) => {
        count++;
        const record = store.deliveries()[0];
        assert.equal(record.id, id);
        assert.equal(record.status, 'attempting');
        assert.match(text, /^Medallion:/);
        assert.match(text, /Medallion: 3 SOL/);
      } },
    });
    assert.equal(count, 1);
    assert.equal(store.deliveries()[0].id, id);
    assert.equal(store.deliveries()[0].status, 'acknowledged');
  } finally { store.close(); }
});

test('ambiguous test send is marked uncertain and never automatically retried', async () => {
  const store = new Store(':memory:');
  let count = 0;
  try {
    await assert.rejects(sendPriceTest({ config, store, now: () => now,
      getSnapshot: async () => snapshot,
      whatsapp: { groupId: config.groupId, connected: true, send: async () => {
        count++; throw new Error('network disconnected');
      } },
    }), /uncertain/);
    assert.equal(count, 1);
    assert.equal(store.deliveries()[0].status, 'uncertain');
  } finally { store.close(); }
});

test('invalid recipient, incomplete prices or disconnect prevents a test send', async () => {
  for (const failure of ['recipient', 'prices', 'disconnected']) {
    const store = new Store(':memory:');
    let sent = false;
    try {
      await assert.rejects(sendPriceTest({ config: failure === 'recipient' ? { ...config, groupId: null } : config,
        store, now: () => now,
        getSnapshot: async () => {
          if (failure === 'prices') throw new Error('Incomplete prices');
          return snapshot;
        },
        whatsapp: { groupId: config.groupId, connected: failure !== 'disconnected', send: async () => { sent = true; } },
      }));
      assert.equal(sent, false);
      assert.equal(store.deliveries().length, 0);
    } finally { store.close(); }
  }
});
