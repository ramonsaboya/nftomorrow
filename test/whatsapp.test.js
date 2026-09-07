import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { Store } from '../src/store.js';
import { sqliteAuth } from '../src/auth.js';
import { WhatsApp } from '../src/whatsapp.js';

function harness({ paired = true, registered = false, loggedOut = false } = {}) {
  const store = new Store(':memory:');
  const auth = sqliteAuth(store);
  auth.state.creds.registered = registered;
  if (paired) auth.state.creds.me = { id: '123:1@s.whatsapp.net' };
  auth.saveCreds();
  store.set('whatsappLoggedOut', loggedOut);
  const sockets = [], timers = [], statuses = [], sends = [];
  let fresh = 0;
  const wa = new WhatsApp({ store, groupId: '12345@g.us',
    onStatus: (status) => statuses.push(status), onFresh: () => fresh++,
    schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, cancel: () => {},
    makeSocket: (options) => {
      const socket = { options, ev: new EventEmitter(), end() {},
        sendMessage: async (group, message, opts) => {
          sends.push({ group, message, opts }); return { key: { id: opts.messageId } };
        } };
      sockets.push(socket); return socket;
    },
  });
  return { wa, store, sockets, timers, statuses, sends, fresh: () => fresh };
}
test('temporary outage backs off, reconnects and requests fresh observation', async () => {
  const h = harness();
  await h.wa.start();
  h.sockets[0].ev.emit('connection.update', { connection: 'open' });
  assert.equal(h.fresh(), 1);
  h.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
  assert.equal(h.wa.connected, false);
  await assert.rejects(h.wa.send('id', 'text'));
  assert.equal(h.timers[0].delay, 1000);
  h.timers[0].fn();
  h.sockets[1].ev.emit('connection.update', { connection: 'open' });
  assert.equal(h.fresh(), 2);
  // Events from old sockets cannot overwrite the active connection.
  h.sockets[0].ev.emit('connection.update', { connection: 'close' });
  assert.equal(h.wa.connected, true);
  h.wa.stop(); h.store.close();
});
test('logout persists, pauses reconnects and signals need for pairing', async () => {
  const h = harness();
  await h.wa.start();
  h.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: {
    error: { output: { statusCode: DisconnectReason.loggedOut } },
  } });
  assert.equal(h.store.get('whatsappLoggedOut'), true);
  assert.equal(h.statuses.at(-1), 'needs_pairing');
  assert.equal(h.timers.length, 0);
  await assert.rejects(h.wa.send('id', 'message'));
  h.wa.stop(); h.store.close();
});
test('unpaired daemon never creates a socket or prints a QR', async () => {
  const h = harness({ paired: false });
  await h.wa.start();
  assert.equal(h.sockets.length, 0);
  assert.equal(h.statuses.at(-1), 'needs_pairing');
  h.wa.stop(); h.store.close();
});
test('persisted QR identity reconnects even though registered is false', async () => {
  const h = harness();
  try {
    // start reloads the SQLite auth, as a separate groups invocation does.
    await h.wa.start();
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0].options.auth.creds.registered, false);
    assert.equal(h.sockets[0].options.auth.creds.me.id, '123:1@s.whatsapp.net');
    h.sockets[0].ev.emit('connection.update', { connection: 'open' });
    assert.equal(h.wa.connected, true);
    assert.equal(h.statuses.at(-1), 'connected');
  } finally { h.wa.stop(); h.store.close(); }
});
test('saved identity with explicit logout still requires pairing', async () => {
  const h = harness({ loggedOut: true });
  try {
    await h.wa.start();
    assert.equal(h.sockets.length, 0);
    assert.equal(h.statuses.at(-1), 'needs_pairing');
  } finally { h.wa.stop(); h.store.close(); }
});
test('registered flag alone cannot bypass a missing account identity', async () => {
  const h = harness({ paired: false, registered: true });
  try {
    await h.wa.start();
    assert.equal(h.sockets.length, 0);
    assert.equal(h.statuses.at(-1), 'needs_pairing');
  } finally { h.wa.stop(); h.store.close(); }
});
test('sends only to configured group with caller-reserved ID; no send retry', async () => {
  const h = harness();
  await h.wa.start();
  h.sockets[0].ev.emit('connection.update', { connection: 'open' });
  await h.wa.send('unique', 'Prices');
  assert.equal(h.sends[0].group, '12345@g.us');
  assert.equal(h.sends[0].opts.messageId, 'unique');
  h.wa.groupId = '12345@s.whatsapp.net';
  await assert.rejects(h.wa.send('invalid', 'Prices'), /Invalid configured group/);
  assert.equal(h.sends.length, 1);
  h.wa.stop(); h.store.close();
});
