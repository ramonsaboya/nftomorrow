import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { generateWAMessageContent, normalizeMessageContent, proto } from '@whiskeysockets/baileys';
import { Store } from '../src/store.js';
import { WhatsApp, parseCommand } from '../src/whatsapp.js';
import { StickerAlbums, STICKER_BATCH } from '../src/sticker-album.js';
import { ImageStickerCommand } from '../src/image-sticker-command.js';
import { loadStickerInputs } from '../src/sticker-input.js';
import { generateSticker } from '../src/image-edit.js';

const owner = '447700900111@s.whatsapp.net';
const key = (id, chat = '123@g.us', sender = owner) => ({ id, remoteJid: chat, participant: sender });
function photo(id, parent = 'album', caption, index, chat, sender) {
  return { key: key(id, chat, sender), message: { associatedChildMessage: { message: {
    imageMessage: { caption, directPath: '/' + id },
  } }, ...(parent ? { messageContextInfo: { messageAssociation: { associationType: 1,
    parentMessageKey: key(parent, chat, sender), messageIndex: index } } } : {}) } };
}
const header = (id = 'album', count = 3) => ({ key: key(id), message: { albumMessage: { expectedImageCount: count } } });
function harness() {
  const store = new Store(':memory:'), emissions = [], timers = [];
  const collector = new StickerAlbums({ store, emit: (...args) => emissions.push(args),
    authorize: (m) => m.key.participant === owner,
    schedule: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    cancel: (timer) => { if (timer) timer.cancelled = true; } });
  const accept = (m) => { const content = normalizeMessageContent(m.message); return collector.accept(m, content, parseCommand(content)); };
  const tick = (ms) => { for (const t of [...timers]) if (!t.cancelled && t.ms === ms) { t.cancelled = true; t.fn(); } };
  return { store, collector, emissions, accept, tick, close: () => { collector.clear(); store.close(); } };
}

test('one album gathers out-of-order children, captions arriving last and duplicate deliveries', async () => {
  const h = harness();
  try {
    // Round-trip a genuine Baileys album header through the WhatsApp protobuf.
    const parent = header();
    parent.message = proto.Message.decode(proto.Message.encode(await generateWAMessageContent({ album: {
      expectedImageCount: 3, expectedVideoCount: 0,
    } }, {})).finish());
    h.accept(photo('third', 'album', undefined, 2));
    h.accept(parent);
    h.accept(photo('first', 'album', undefined, 0));
    h.accept(photo('first', 'album', undefined, 0));
    assert.equal(h.emissions.length, 0);
    h.accept(photo('second', 'album', '/sticker make a group portrait', 1));
    assert.equal(h.emissions.length, 1);
    const [, command, message, prompt] = h.emissions[0];
    assert.equal(command, '/sticker');
    assert.equal(prompt, 'make a group portrait');
    assert.deepEqual(message[STICKER_BATCH].sources.map((p) => p.directPath), ['/first', '/second', '/third']);
    h.accept(parent);
    h.accept(photo('second', 'album', '/sticker make a group portrait', 1));
    assert.equal(h.emissions.length, 1);
    assert.equal(h.collector.groups.size, 0);
  } finally { h.close(); }
});

test('incomplete, oversize, mixed-video and conflicting-prompt albums report errors without partial success', () => {
  for (const type of ['missing', 'oversize', 'video', 'prompts']) {
    const h = harness();
    try {
      const parent = header('album', type === 'oversize' ? 26 : 3);
      if (type === 'video') parent.message.albumMessage.expectedVideoCount = 1;
      h.accept(parent);
      h.accept(photo('first', 'album', '/sticker theme'));
      if (type === 'prompts') h.accept(photo('second', 'album', '/sticker another theme'));
      h.tick(90000);
      assert.equal(h.emissions.length, 1);
      assert.equal(h.emissions[0][2][STICKER_BATCH].error,
        type === 'missing' ? 'album_incomplete' : type === 'prompts' ? 'album_prompts' : 'album_size');
    } finally { h.close(); }
  }
});

test('separate albums, chats and senders cannot add photos to another request', () => {
  const h = harness();
  try {
    h.accept(header('album', 2));
    h.accept(photo('first', 'album', '/sticker theme'));
    h.accept(photo('other-album', 'other'));
    h.accept(photo('other-chat', 'album', undefined, 1, '999@g.us'));
    h.accept(photo('intruder', 'album', undefined, 1, '123@g.us', '999@s.whatsapp.net'));
    assert.equal(h.emissions.length, 0);
    h.accept(photo('second', 'album'));
    assert.deepEqual(h.emissions[0][2][STICKER_BATCH].sources.map((s) => s.directPath), ['/first', '/second']);
    assert.ok(!JSON.stringify(h.store.get('sticker-album-completed')).includes('theme'));
  } finally { h.close(); }
});

test('photos without association metadata wait for the caption and quiet window; clearing drops pending work', () => {
  const h = harness();
  try {
    h.accept(photo('one', null));
    h.accept(photo('two', null, '/sticker use both'));
    assert.equal(h.emissions.length, 0);
    h.tick(5000);
    assert.equal(h.emissions[0][2][STICKER_BATCH].sources.length, 2);
    h.accept(photo('three', null, '/sticker next'));
    h.collector.clear();
    h.tick(5000);
    h.tick(90000);
    assert.equal(h.emissions.length, 1);
  } finally { h.close(); }
});

test('incomplete albums never download images or reserve paid work', async () => {
  const store = new Store(':memory:'), notices = [];
  let downloads = 0, generations = 0;
  try {
    const command = new ImageStickerCommand({ store, config: { groupId: '123@g.us', stickerOwnerJids: [owner] },
      whatsapp: { connected: true, generation: 1, async replyText(id, text) { notices.push(text); } },
      health: { async ping() {} }, apiKey: 'test',
      loadImages: async () => { downloads++; return []; }, generate: async () => { generations++; } });
    const msg = { ...photo('incomplete'), [STICKER_BATCH]: { error: 'album_incomplete', sources: [] } };
    assert.equal(command.request('incomplete', msg, 'theme'), true);
    await command.runPending();
    assert.equal(downloads, 0);
    assert.equal(generations, 0);
    assert.equal(store.get('image-sticker-budget'), null);
    assert.match(notices[0], /complete photo album/);
  } finally { store.close(); }
});

test('25 photos are included; a 26th photo is rejected instead of silently truncated', () => {
  for (const count of [25, 26]) {
    const h = harness();
    try {
      h.accept(header('album', count));
      for (let i = 0; i < count; i++) h.accept(photo('photo-' + i, 'album', i === 0 ? '/sticker everyone' : undefined));
      assert.equal(h.emissions.length, 1);
      const batch = h.emissions[0][2][STICKER_BATCH];
      if (count === 25) { assert.equal(batch.error, undefined); assert.equal(batch.sources.length, 25); }
      else assert.equal(batch.error, 'album_size');
    } finally { h.close(); }
  }
});

test('fresh WhatsApp album becomes one paid multipart request with all photos and one returned sticker', async () => {
  const store = new Store(':memory:');
  const socket = { ev: new EventEmitter(), end() {}, async sendMessage(chat, content, options) {
    sent.push(content); return { key: { id: options.messageId } };
  } };
  const sent = [], now = Date.now();
  let command, requests = 0;
  const wa = new WhatsApp({ store, groupId: '123@g.us', stickerOwnerJids: [owner], now: () => now,
    makeSocket: () => socket, onCommand: (id, name, msg, prompt) => command.request(id, msg, prompt) });
  const png = await readFile(new URL('../assets/stickers/sticker-test-source.png', import.meta.url));
  try {
    command = new ImageStickerCommand({ store, config: { groupId: '123@g.us', stickerOwnerJids: [owner] },
      whatsapp: wa, health: { async ping() {} }, apiKey: 'test', now: () => now,
      loadImages: (msg) => loadStickerInputs(msg, { download: async () => Readable.from([png]) }),
      generate: (args) => generateSticker({ ...args, fetchImpl: async (url, options) => {
        requests++;
        assert.match(url, /images\/edits$/);
        assert.equal(options.body.getAll('image[]').length, 4);
        assert.equal(options.body.get('prompt'), 'use everyone');
        return Response.json({ data: [{ b64_json: png.toString('base64') }] });
      } }) });
    wa.connect({ state: { creds: { me: { id: '999@s.whatsapp.net' } } }, saveCreds() {} });
    socket.ev.emit('connection.update', { connection: 'open' });
    const emit = (m) => socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ ...m, messageTimestamp: now / 1000 }] });
    emit(header('album', 4));
    emit(photo('a', 'album', '/sticker use everyone'));
    emit(photo('b'));
    await command.runPending();
    assert.equal(requests, 0);
    emit(photo('c'));
    emit(photo('d'));
    await command.runPending();
    assert.equal(requests, 1);
    assert.equal(store.get('image-sticker-budget').used, 1);
    assert.equal(sent.length, 2);
    assert.match(sent[0].text, /using 4 photos/);
    assert.ok(Buffer.isBuffer(sent[1].sticker));
    emit(photo('d'));
    await command.runPending();
    assert.equal(requests, 1);
    emit(header('incomplete', 2));
    emit(photo('x', 'incomplete', '/sticker next'));
    socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    assert.equal(wa.albums.groups.size, 0);
  } finally { await wa.stop(); store.close(); }
});
