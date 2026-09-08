import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { StickerCommand } from '../src/sticker-command.js';
import { loadSticker, validateSticker, STICKER_SHA256 } from '../src/sticker.js';
import { StatusCommand } from '../src/status-command.js';
import { Monitor } from '../src/monitor.js';
import { COLLECTIONS } from '../src/collections.js';
import { WhatsApp } from '../src/whatsapp.js';

const START = Date.parse('2026-09-08T12:00:00Z');
const fixture = await loadSticker();

function incoming(id = 'request-one', overrides = {}) {
  return { key: { id, remoteJid: '123@g.us', fromMe: false, ...overrides },
    message: { conversation: '/sticker-test' } };
}

function harness({ path = ':memory:', start = START } = {}) {
  const store = new Store(path);
  let now = start, fetches = 0, loads = 0;
  const stickers = [], texts = [], pings = [], logs = [];
  const config = { groupId: '123@g.us', displayCurrency: 'USD', dailySummaryTime: '18:00',
    thresholds: [{ target: 'medallion', currency: 'USD', below: 6500 }] };
  const whatsapp = { connected: true, generation: 1,
    async replyStatus(id, text) { return this.send(id, text); },
    async sendSticker(id, sticker, quoted) {
      const audit = store.deliveries().find((delivery) => delivery.id === id);
      assert.equal(audit?.status, 'attempting', 'reserve delivery before any media send');
      stickers.push({ id, sticker, quoted });
    },
    async send(id, text) { texts.push({ id, text }); } };
  const dependencies = { store, config, whatsapp, now: () => now,
    health: { async ping(...args) { pings.push(args); } },
    log: (...args) => logs.push(args),
    async getSticker() { loads++; return fixture; },
    async getSnapshot() {
      fetches++;
      return { observedAt: now,
        lamports: { ...Object.fromEntries(COLLECTIONS.map(({ id }) => [id, 1e9])), medallion: 3e9 },
        fx: { rates: { USD: 100 }, updatedAt: now }, fxFailed: false };
    } };
  return { store, config, whatsapp, dependencies, stickers, texts, pings, logs,
    command: new StickerCommand(dependencies), advance: (ms) => { now += ms; },
    now: () => now, fetches: () => fetches, loads: () => loads };
}

test('the shipped sticker loads as the pinned transparent static 512x512 WebP under 100 KB', async () => {
  const loaded = await loadSticker();
  assert.deepEqual(loaded, fixture);
  assert.deepEqual(validateSticker(loaded), {
    width: 512, height: 512, bytes: loaded.length, sha256: STICKER_SHA256,
  });
  assert.ok(loaded.length <= 100_000);
});

test('sticker validation rejects damaged bytes, malformed headers and incompatible media', () => {
  const changed = (edit) => { const buffer = Buffer.from(fixture); edit(buffer); return buffer; };
  for (const [name, value] of [
    ['non-buffer', new Uint8Array(fixture)],
    ['null', null],
    ['truncated', fixture.subarray(0, 29)],
    ['oversized', Buffer.alloc(100_001)],
    ['wrong container', changed((b) => b.write('JPEG', 0))],
    ['inconsistent length', changed((b) => b.writeUInt32LE(b.length, 4))],
    ['wrong format', changed((b) => b.write('PNG ', 8))],
    ['wrong extended header', changed((b) => b.writeUInt32LE(9, 16))],
    ['opaque', changed((b) => { b[20] &= ~0x10; })],
    ['animated', changed((b) => { b[20] |= 0x02; })],
    ['wrong width', changed((b) => b.writeUIntLE(510, 24, 3))],
    ['wrong height', changed((b) => b.writeUIntLE(510, 27, 3))],
    ['corrupt bitstream', changed((b) => { b[b.length - 1] ^= 1; })],
  ]) assert.throws(() => validateSticker(value), undefined, name);
});

test('sticker acceptance and delivery are durable before send; the native payload quotes the request', async () => {
  const h = harness();
  try {
    const request = incoming();
    h.command.getSticker = async () => {
      assert.equal(h.store.get(h.command.stateKey).recent[0].id, request.key.id);
      return fixture;
    };
    h.store.set('deliveryUncertain', true);
    assert.equal(h.command.request(request.key.id, request), true);
    await h.command.runPending();
    assert.equal(h.stickers.length, 1);
    assert.strictEqual(h.stickers[0].quoted, request);
    assert.strictEqual(h.stickers[0].sticker, fixture);
    assert.match(h.stickers[0].id, /^3EB0[A-F0-9]{28}$/);
    const [audit] = h.store.deliveries();
    assert.equal(audit.status, 'acknowledged');
    assert.equal(audit.finished_at, h.now());
    assert.deepEqual(audit.data, { kind: 'sticker-test', chatId: h.config.groupId,
      asset: 'sticker-test.webp', sha256: STICKER_SHA256 });
    assert.equal(h.store.get('deliveryUncertain'), false);
    assert.equal(h.fetches(), 0);
    assert.equal(h.texts.length, 0);
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS total FROM observations').get().total, 0);
    assert.deepEqual(h.pings, []);
  } finally { h.store.close(); }
});

test('sticker replies leave automatic hourly alerts and daily summary scheduling intact', async () => {
  for (const kind of ['alert', 'summary']) {
    const h = harness();
    try {
      if (kind === 'summary') h.config.thresholds = [];
      const monitor = new Monitor(h.dependencies);
      if (kind === 'summary') h.advance(5 * 60 * 60_000); // 18:00 London.
      const before = h.store.get(monitor.stateKey);
      assert.equal(h.command.request('one', incoming('one')), true);
      await h.command.runPending();
      assert.deepEqual(h.store.get(monitor.stateKey), before);
      assert.equal(h.fetches(), 0);
      await monitor.poll();
      assert.equal(h.fetches(), 1);
      assert.equal(h.texts.length, 1);
      assert.equal(h.store.deliveries()[1].data.kind, kind);
    } finally { h.store.close(); }
  }
});

test('acceptance survives SQLite reopen, suppressing duplicates and cooldown without replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nftomorrow-sticker-restart-'));
  const path = join(directory, 'state.sqlite');
  const first = harness({ path });
  let restarted;
  try {
    assert.equal(first.command.request('accepted-before-crash', incoming('accepted-before-crash')), true);
    first.store.close();
    restarted = harness({ path, start: START + 30_000 });
    await restarted.command.runPending();
    assert.equal(restarted.stickers.length, 0);
    assert.equal(restarted.command.request('new', incoming('new')), false);
    restarted.advance(30_000);
    assert.equal(restarted.command.request('accepted-before-crash', incoming('accepted-before-crash')), false);
    assert.equal(restarted.command.request('new', incoming('new')), true);
    await restarted.command.runPending();
    assert.equal(restarted.stickers.length, 1);
    assert.equal(restarted.store.deliveries().length, 1);
  } finally {
    if (restarted) restarted.store.close();
    else { try { first.store.close(); } catch {} }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('one queued or loading sticker bounds work and concurrent drains share the same send', async () => {
  const h = harness();
  try {
    let release, loads = 0;
    h.command.getSticker = () => {
      loads++;
      return new Promise((resolve) => { release = resolve; });
    };
    assert.equal(h.command.request('one', incoming('one')), true);
    h.advance(60_000);
    assert.equal(h.command.request('two', incoming('two')), false, 'pending request cannot be replaced');
    const first = h.command.runPending();
    h.advance(60_000);
    assert.equal(h.command.request('two', incoming('two')), false, 'loading request cannot be replaced');
    const second = h.command.runPending();
    assert.equal(loads, 1);
    release(fixture);
    await Promise.all([first, second]);
    assert.equal(h.stickers.length, 1);
    assert.equal(h.stickers[0].quoted.key.id, 'one');
    assert.equal(h.command.request('two', incoming('two')), true);
  } finally { h.store.close(); }
});

test('a pending WhatsApp acknowledgement also prevents additional accepted requests', async () => {
  const h = harness();
  try {
    let release, started;
    const sending = new Promise((resolve) => { started = resolve; });
    h.whatsapp.sendSticker = async () => {
      started();
      await new Promise((resolve) => { release = resolve; });
    };
    h.command.request('one', incoming('one'));
    const run = h.command.runPending();
    await sending;
    h.advance(60_000);
    assert.equal(h.command.request('two', incoming('two')), false);
    assert.equal(h.store.deliveries()[0].status, 'attempting');
    release();
    await run;
    assert.equal(h.store.deliveries()[0].status, 'acknowledged');
    assert.equal(h.command.request('two', incoming('two')), true);
  } finally { h.store.close(); }
});

test('disconnect, a different connection generation or expiry discard queued and loading requests', async () => {
  for (const when of ['queued', 'loading']) {
    for (const reason of ['disconnect', 'generation', 'expiry']) {
      const h = harness();
      try {
        const invalidate = () => {
          if (reason === 'disconnect') h.whatsapp.connected = false;
          if (reason === 'generation') h.whatsapp.generation++;
          if (reason === 'expiry') h.advance(300_001);
        };
        h.command.request('one', incoming('one'));
        if (when === 'queued') invalidate();
        else h.command.getSticker = async () => { invalidate(); return fixture; };
        await h.command.runPending();
        assert.equal(h.stickers.length, 0, `${when}: ${reason}`);
        assert.equal(h.store.deliveries().length, 0, `${when}: ${reason}`);
        if (when === 'queued') assert.equal(h.loads(), 0);
        h.whatsapp.connected = true;
        await h.command.runPending();
        assert.equal(h.stickers.length, 0, 'discarded requests never replay on reconnect');
      } finally { h.store.close(); }
    }
  }
});

test('missing or corrupt optional assets do not send, expose error details or stop price monitoring', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nftomorrow-sticker-missing-'));
  try {
    for (const reason of ['missing', 'corrupt']) {
      const h = harness();
      try {
        const monitor = new Monitor(h.dependencies);
        h.command.getSticker = reason === 'missing'
          ? () => readFile(join(directory, 'missing-private-asset.webp'))
          : async () => Buffer.from('invalid image');
        h.command.request('one', incoming('one'));
        await assert.doesNotReject(h.command.runPending());
        assert.equal(h.stickers.length, 0);
        assert.equal(h.store.deliveries().length, 0);
        assert.deepEqual(h.logs, [['sticker_unavailable']]);
        await assert.doesNotReject(monitor.poll());
        assert.equal(h.fetches(), 1);
        assert.equal(h.texts.length, 1);
        assert.equal(h.store.deliveries()[0].data.kind, 'alert');
        h.advance(60_000);
        h.command.getSticker = async () => fixture;
        assert.equal(h.command.request('two', incoming('two')), true);
        await h.command.runPending();
        assert.equal(h.stickers.length, 1);
      } finally { h.store.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('uncertain sticker delivery is audited and never automatically retried', async () => {
  const h = harness();
  let attempts = 0;
  try {
    h.whatsapp.sendSticker = async (id) => {
      attempts++;
      assert.equal(h.store.deliveries().find((entry) => entry.id === id).status, 'attempting');
      throw new Error('private transport failure');
    };
    h.command.request('one', incoming('one'));
    await h.command.runPending();
    assert.equal(h.store.deliveries()[0].status, 'uncertain');
    assert.equal(h.store.get('deliveryUncertain'), true);
    assert.deepEqual(h.pings, [['whatsapp', false]]);
    assert.deepEqual(h.logs, [['delivery_uncertain', { kind: 'sticker-test' }]]);
    h.advance(60_000);
    const restarted = new StickerCommand(h.dependencies);
    assert.equal(restarted.request('one', incoming('one')), false);
    await Promise.all([h.command.runPending(), restarted.runPending()]);
    assert.equal(attempts, 1);
    assert.equal(h.store.deliveries().length, 1);
  } finally { h.store.close(); }
});

test('invalid identifiers, missing messages, other groups, own requests and offline requests are ignored', async () => {
  const h = harness();
  try {
    for (const [id, message] of [
      ['', incoming('')], [undefined, incoming()], [42, incoming(42)],
      ['one', undefined], ['one', {}], ['one', { key: {} }],
      ['one', incoming('different')],
      ['one', incoming('one', { remoteJid: '999@g.us' })],
      ['one', incoming('one', { remoteJid: 'status@broadcast' })],
      ['one', incoming('one', { remoteJid: '123@newsletter' })],
      ['one', incoming('one', { remoteJid: 'malformed@s.whatsapp.net' })],
      ['one', incoming('one', { fromMe: true })],
    ]) assert.equal(h.command.request(id, message), false);
    h.whatsapp.connected = false;
    assert.equal(h.command.request('one', incoming('one')), false);
    await h.command.runPending();
    assert.equal(h.store.get(h.command.stateKey), null);
    assert.equal(h.loads(), 0);
    assert.equal(h.stickers.length, 0);
    h.whatsapp.connected = true;
    assert.equal(h.command.request('one', incoming('one')), true);
  } finally { h.store.close(); }
});

test('status and sticker commands have independent cooldowns and do not consume each other\'s work', async () => {
  for (const first of ['status', 'sticker']) {
    const h = harness();
    try {
      const status = new StatusCommand(h.dependencies);
      const stickerRequest = () => h.command.request('sticker-one', incoming('sticker-one'));
      if (first === 'status') {
        assert.equal(status.request('status-one'), true);
        assert.equal(stickerRequest(), true);
      } else {
        assert.equal(stickerRequest(), true);
        assert.equal(status.request('status-one'), true);
      }
      await h.command.runPending();
      assert.equal(h.fetches(), 0);
      await status.runPending();
      assert.equal(h.fetches(), 1);
      assert.equal(h.stickers.length, 1);
      assert.equal(h.texts.length, 1);
      assert.equal(status.request('status-two'), false);
      assert.equal(h.command.request('sticker-two', incoming('sticker-two')), false);
      assert.equal(h.store.get(status.stateKey).recent[0].id, 'status-one');
      assert.equal(h.store.get(h.command.stateKey).recent[0].id, 'sticker-one');
    } finally { h.store.close(); }
  }
});

test('phone-number and LID direct chats preserve the request quote and have independent cooldowns', async () => {
  const h = harness();
  try {
    const chats = [h.config.groupId, '447700900111@s.whatsapp.net', '1234567890@lid'];
    // The same request ID in different chats must not collide in persistent acceptance.
    for (const chatId of chats) {
      const request = incoming('same-id', { remoteJid: chatId });
      assert.equal(h.command.request('same-id', request), true);
      await h.command.runPending();
      assert.strictEqual(h.stickers.at(-1).quoted, request);
      assert.equal(h.store.deliveries().at(-1).data.chatId, chatId);
      assert.equal(h.store.get(`sticker-command:${chatId}`).recent[0].id, 'same-id');
    }
    assert.equal(h.stickers.length, 3);
    for (const chatId of chats) {
      assert.equal(h.command.request('new-id', incoming('new-id', { remoteJid: chatId })), false);
    }
    h.advance(60_000);
    const restarted = new StickerCommand(h.dependencies);
    for (const chatId of chats) {
      assert.equal(restarted.request('same-id', incoming('same-id', { remoteJid: chatId })), false);
      assert.equal(restarted.request('new-id', incoming('new-id', { remoteJid: chatId })), true);
      await restarted.runPending();
    }
    assert.equal(h.stickers.length, 6);
    assert.equal(h.fetches(), 0);
    assert.equal(h.texts.length, 0);
  } finally { h.store.close(); }
});

test('one queued or loading request bounds work globally across group and direct chats', async () => {
  const h = harness();
  try {
    const direct = incoming('direct', { remoteJid: '447700900111@s.whatsapp.net' });
    let release;
    h.command.getSticker = () => new Promise((resolve) => { release = resolve; });
    assert.equal(h.command.request('group', incoming('group')), true);
    assert.equal(h.command.request('direct', direct), false);
    const run = h.command.runPending();
    assert.equal(h.command.request('direct', direct), false);
    assert.equal(h.store.get(`sticker-command:${direct.key.remoteJid}`), null);
    release(fixture);
    await run;
    h.command.getSticker = async () => fixture;
    assert.equal(h.command.request('direct', direct), true);
    await h.command.runPending();
    assert.equal(h.stickers.length, 2);
    assert.strictEqual(h.stickers[1].quoted, direct);
  } finally { h.store.close(); }
});

test('socket events route group and direct commands to quoted native stickers and private status replies stay private', async () => {
  const h = harness();
  const sent = [], accepted = [];
  let stickerCommand, statusCommand;
  const socket = { ev: new EventEmitter(), end() {}, async sendMessage(group, content, options) {
    assert.equal(h.store.deliveries().find((entry) => entry.id === options.messageId).status, 'attempting');
    sent.push({ group, content, options });
    return { key: { id: options.messageId } };
  } };
  const whatsapp = new WhatsApp({ store: h.store, groupId: h.config.groupId, now: h.now,
    onQr() {}, makeSocket: () => socket,
    onCommand: (id, command, message) => {
      if (command === '/status') statusCommand.request(id, message.key.remoteJid);
      else if (command === '/sticker-test') accepted.push({ id, accepted: stickerCommand.request(id, message) });
    } });
  stickerCommand = new StickerCommand({ ...h.dependencies, whatsapp });
  statusCommand = new StatusCommand({ ...h.dependencies, whatsapp });
  const message = (id, overrides = {}) => ({ ...incoming(id), messageTimestamp: h.now() / 1000, ...overrides });
  const emit = (messages, type = 'notify') => socket.ev.emit('messages.upsert', { type, messages });
  try {
    await whatsapp.start();
    socket.ev.emit('connection.update', { connection: 'open' });
    const request = message('valid-sticker');
    assert.doesNotThrow(() => emit([
      null, {}, message('missing-key', { key: null }),
      message('invalid-id', { key: { remoteJid: h.config.groupId, id: ' ' } }),
      message('other-group', { key: { id: 'other-group', remoteJid: '999@g.us' } }),
      message('own', { key: { id: 'own', remoteJid: h.config.groupId, fromMe: true } }),
      message('old', { messageTimestamp: h.now() / 1000 - 1 }),
      message('invalid-time', { messageTimestamp: Symbol('invalid') }),
      message('caption', { message: { imageMessage: { caption: '/sticker-test' } } }),
      message('extra', { message: { conversation: '/sticker-test please' } }),
      request, request,
      message('status', { key: { id: 'status', remoteJid: '789@lid' }, message: { conversation: '/status' } }),
    ]));
    emit([message('history')], 'append');
    await stickerCommand.runPending();
    assert.equal(h.fetches(), 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].group, h.config.groupId);
    assert.deepEqual(sent[0].content, { sticker: fixture, mimetype: 'image/webp' });
    assert.strictEqual(sent[0].options.quoted, request);
    assert.equal(h.store.deliveries()[0].status, 'acknowledged');
    assert.deepEqual(accepted, [{ id: 'valid-sticker', accepted: true }, { id: 'valid-sticker', accepted: false }]);
    await statusCommand.runPending();
    assert.equal(h.fetches(), 1);
    assert.equal(sent.length, 2);
    assert.match(sent[1].content.text, /Medallion:/);
    h.advance(61_000);
    emit([request]); // Even after cooldown, the same incoming ID remains suppressed.
    await stickerCommand.runPending();
    assert.equal(sent.length, 2);
    assert.deepEqual(accepted.at(-1), { id: 'valid-sticker', accepted: false });
    const ephemeral = message('fresh-sticker', { message: {
      ephemeralMessage: { message: { extendedTextMessage: { text: ' /STICKER-TEST ' } } },
    } });
    emit([ephemeral]);
    await stickerCommand.runPending();
    assert.equal(sent.length, 3);
    assert.strictEqual(sent[2].options.quoted, ephemeral);
    assert.deepEqual(sent[2].content, { sticker: fixture, mimetype: 'image/webp' });
    for (const chatId of ['447700900111@s.whatsapp.net', '1234567890@lid']) {
      const direct = message(`direct-${chatId}`, { key: { id: `direct-${chatId}`, remoteJid: chatId } });
      emit([direct]);
      await stickerCommand.runPending();
      assert.equal(sent.at(-1).group, chatId);
      assert.strictEqual(sent.at(-1).options.quoted, direct);
      assert.deepEqual(sent.at(-1).content, { sticker: fixture, mimetype: 'image/webp' });
      assert.equal(h.store.deliveries().at(-1).data.chatId, chatId);
      h.advance(61_000);
      emit([message(`status-${chatId}`, { key: { id: `status-${chatId}`, remoteJid: chatId },
        message: { conversation: '/status' } })]);
      await statusCommand.runPending();
    }
    assert.equal(sent.at(-1).group, '1234567890@lid');
    assert.equal(sent.length, 7);
    assert.equal(h.fetches(), 3, 'each private status request fetches current prices');
  } finally { await whatsapp.stop(); h.store.close(); }
});

test('a future-dated incoming request remains deduplicated after five minutes while the parser still admits it', async () => {
  const h = harness();
  let command, parserCalls = 0, sends = 0;
  const socket = { ev: new EventEmitter(), end() {}, async sendMessage(_chat, _content, options) {
    sends++;
    return { key: { id: options.messageId } };
  } };
  const whatsapp = new WhatsApp({ store: h.store, groupId: h.config.groupId, now: h.now,
    onQr() {}, makeSocket: () => socket,
    onCommand: (id, name, message) => {
      if (name === '/sticker-test') { parserCalls++; command.request(id, message); }
    } });
  command = new StickerCommand({ ...h.dependencies, whatsapp });
  try {
    await whatsapp.start();
    socket.ev.emit('connection.update', { connection: 'open' });
    const request = { ...incoming('skewed-request'), messageTimestamp: (h.now() + 60_000) / 1000 };
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [request] });
    await command.runPending();
    assert.equal(sends, 1);
    h.advance(301_000);
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [request] });
    await command.runPending();
    assert.equal(parserCalls, 2, 'the original future timestamp is still less than five minutes old');
    assert.equal(sends, 1, 'persistent deduplication must include the accepted clock-skew window');
    assert.equal(h.store.deliveries().length, 1);
  } finally { await whatsapp.stop(); h.store.close(); }
});
