import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { DisconnectReason, generateWAMessage } from '@whiskeysockets/baileys';
import { Store } from '../src/store.js';
import { sqliteAuth } from '../src/auth.js';
import { WhatsApp, parseCommand } from '../src/whatsapp.js';
import sharp from 'sharp';

test('reset alert transport permits only the allowlisted private phone account', async () => {
  const h = harness({ stickerOwnerJids: ['777@s.whatsapp.net', '888@lid'] });
  try {
    await h.wa.start();
    h.sockets[0].ev.emit('connection.update', { connection: 'open' });
    await h.wa.sendResetAlert('reset-1', 'Tibo posted about resets', '777@s.whatsapp.net');
    assert.equal(h.sends[0].group, '777@s.whatsapp.net');
    assert.equal(h.sends[0].message.linkPreview, null);
    for (const recipient of ['12345@g.us', '999@s.whatsapp.net', '888@lid']) {
      await assert.rejects(h.wa.sendResetAlert('bad', 'text', recipient));
    }
    assert.equal(h.sends.length, 1);
  } finally { await h.wa.stop(); h.store.close(); }
});

test('Baileys encodes four status images as children of one native media album', async () => {
  const h = harness();
  try {
    await h.wa.start();
    h.sockets[0].ev.emit('connection.update', { connection: 'open' });
    const encoded = [];
    h.sockets[0].sendMessage = async (group, content, options) => {
      const message = await generateWAMessage(group, content, { ...options, userJid: '999@s.whatsapp.net',
        upload: async () => ({ mediaUrl: 'https://example.invalid/image', directPath: '/image' }),
      });
      encoded.push(message);
      return message;
    };
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#b3a1ff' } }).png().toBuffer();
    await h.wa.replyStatus('album', '100.00  SOL to USD', '12345@g.us', [png, png, png, png]);
    assert.equal(encoded.length, 5);
    assert.equal(encoded[0].message.albumMessage.expectedImageCount, 4);
    for (const child of encoded.slice(1)) {
      assert.ok(child.message.imageMessage);
      const association = child.message.messageContextInfo.messageAssociation;
      assert.equal(association.associationType, 1);
      assert.equal(association.parentMessageKey.id, encoded[0].key.id);
      assert.equal(association.parentMessageKey.remoteJid, '12345@g.us');
      assert.equal(association.parentMessageKey.fromMe, true);
    }
    assert.equal(encoded[1].message.imageMessage.caption, '100.00  SOL to USD');
  } finally { await h.wa.stop(); h.store.close(); }
});

test('fresh plain replies route only for saved stickers in the same chat', async () => {
  const now = 1_800_000_000_000, commands = [];
  const h = harness({ now: () => now, onCommand: (...args) => commands.push(args) });
  try {
    h.store.saveSticker('generated', '12345@g.us', { source: {}, sticker: Buffer.from('saved') });
    await h.wa.start();
    const socket = h.sockets[0];
    socket.ev.emit('connection.update', { connection: 'open' });
    const reply = (id, target = 'generated', chat = '12345@g.us', text = 'Make it red') => ({
      key: { id, remoteJid: chat }, messageTimestamp: now / 1000,
      message: { ephemeralMessage: { message: { extendedTextMessage: {
        text, contextInfo: { stanzaId: target },
      } } } },
    });
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [
      reply('valid'), reply('unknown', 'other'), reply('other-chat', 'generated', '999@g.us'),
      reply('empty', 'generated', '12345@g.us', '  '),
      { ...reply('stale'), messageTimestamp: now / 1000 - 1 },
    ] });
    assert.equal(commands.length, 1);
    assert.equal(commands[0][1], 'sticker-revision');
    assert.equal(commands[0][3], 'Make it red');
  } finally { await h.wa.stop(); h.store.close(); }
});

test('all commands accept slash or verified Dobby mentions and preserve theme and caption case', () => {
  const me = { id: '123:1@s.whatsapp.net', lid: '456:2@lid' };
  for (const name of ['status', 'sticker', 'euvousticker', 'sticker-test']) {
    const prompt = ['status', 'sticker-test'].includes(name) ? '' : 'Pirate theme\nCaption: EU VOU';
    const suffix = prompt ? ' ' + prompt : '';
    const expected = { command: '/' + name, prompt };
    assert.deepEqual(parseCommand({ conversation: `/${name.toUpperCase()}${suffix}` }, me), expected);
    for (const jid of ['123@s.whatsapp.net', '456@lid']) {
      assert.deepEqual(parseCommand({ extendedTextMessage: {
        text: `@${jid.split('@')[0]} ${name}${suffix}`, contextInfo: { mentionedJid: [jid] },
      } }, me), expected);
    }
    assert.equal(parseCommand({ extendedTextMessage: { text: `@789 ${name}${suffix}`,
      contextInfo: { mentionedJid: ['789@s.whatsapp.net'] } } }, me), null);
  }
  for (const text of ['/euvoustickers theme', '/stickers theme', 'sticker theme', '/status extra']) {
    assert.equal(parseCommand({ conversation: text }, me), null);
  }
});

function harness({ paired = true, registered = false, loggedOut = false, onCommand, now, stickerOwnerJids } = {}) {
  const store = new Store(':memory:');
  const auth = sqliteAuth(store);
  auth.state.creds.registered = registered;
  if (paired) auth.state.creds.me = { id: '123:1@s.whatsapp.net' };
  auth.saveCreds();
  store.set('whatsappLoggedOut', loggedOut);
  const sockets = [], timers = [], statuses = [], sends = [];
  let fresh = 0;
  const wa = new WhatsApp({ store, groupId: '12345@g.us',
      onCommand, now, stickerOwnerJids,
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

test('status range reaches the handler and image sequences stop on lost acknowledgement', async () => {
  const now = 1_800_000_000_000, commands = [];
  const h = harness({ now: () => now, onCommand: (...args) => commands.push(args) });
  try {
    await h.wa.start();
    const socket = h.sockets[0];
    socket.ev.emit('connection.update', { connection: 'open' });
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [{
      key: { id: 'range', remoteJid: '789@lid' }, messageTimestamp: now / 1000,
      message: { conversation: '/status 90d' },
    }] });
    assert.equal(commands[0][3], '90d');
    const images = [1, 2, 3, 4].map((n) => Buffer.from([n]));
    await h.wa.replyStatus('image', 'Prices', '789@lid', images);
    assert.deepEqual(h.sends.map((s) => s.opts.messageId), ['image', 'image1', 'image2', 'image3', 'image4']);
    assert.deepEqual(h.sends[0].message.album, { expectedImageCount: 4, expectedVideoCount: 0 });
    assert.ok(h.sends.slice(1).every((s) => s.group === '789@lid' && s.message.mimetype === 'image/png'
      && s.message.albumParentKey.id === 'image'));
    assert.equal(h.sends[1].message.caption, 'Prices');
    assert.equal(h.sends[2].message.caption, undefined);
    let attempts = 0;
    socket.sendMessage = async (_chat, _content, { messageId }) => {
      attempts++;
      return { key: { id: attempts === 2 ? 'wrong' : messageId } };
    };
    await assert.rejects(h.wa.send('partial', 'Prices', images), /acknowledgement/);
    assert.equal(attempts, 2);
    h.wa.groupId = '789@lid';
    await assert.rejects(h.wa.send('invalid', 'Prices', images), /configured group/);
  } finally { await h.wa.stop(); h.store.close(); }
});
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
test('accepts only fresh group status and sticker text commands, including disappearing text', async () => {
  let now = 1_800_000_000_000;
  const commands = [];
  const h = harness({ now: () => now, onCommand: (id, command, message) => commands.push({ id, command, message }) });
  try {
    await h.wa.start();
    const socket = h.sockets[0];
    socket.ev.emit('connection.update', { connection: 'open' });
    const message = (id, changes = {}) => ({ key: { remoteJid: '12345@g.us', id },
      messageTimestamp: now / 1000, message: { extendedTextMessage: { text: '@123 status', contextInfo: { mentionedJid: ['123@s.whatsapp.net'] } } }, ...changes });
    const stickerMessage = message('sticker', { message: { conversation: '/sticker-test' } });
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [
      message('plain'),
      message('extended', { message: { extendedTextMessage: { text: ' @123 STATUS ', contextInfo: { mentionedJid: ['123@s.whatsapp.net'] } } } }),
      message('ephemeral', { message: { ephemeralMessage: { message: { extendedTextMessage: { text: '@123 status', contextInfo: { mentionedJid: ['123@s.whatsapp.net'] } } } } } }),
      stickerMessage,
      message('sticker-extended', { message: { extendedTextMessage: { text: ' /STICKER-TEST ' } } }),
      message('sticker-ephemeral', { message: { ephemeralMessage: { message: { conversation: '/sticker-test' } } } }),
      message('other', { key: { remoteJid: '999@g.us', id: 'other' } }),
      message('dm', { key: { remoteJid: '123@s.whatsapp.net', id: 'dm' } }),
      message('own', { key: { remoteJid: '12345@g.us', id: 'own', fromMe: true } }),
      message('old', { messageTimestamp: now / 1000 - 1 }),
      message('future', { messageTimestamp: now / 1000 + 61 }),
      message('no-time', { messageTimestamp: undefined }),
      message('caption', { message: { imageMessage: { caption: '/status' } } }),
      message('quoted', { message: { extendedTextMessage: { text: 'hello', contextInfo: { quotedMessage: { conversation: '/status' } } } } }),
      message('extra', { message: { conversation: '/status please' } }),
      message('sticker-extra', { message: { conversation: '/sticker-test please' } }),
      message('sticker-caption', { message: { imageMessage: { caption: '/sticker-test' } } }),
      message('sticker-other', { key: { remoteJid: '999@g.us', id: 'sticker-other' }, message: { conversation: '/sticker-test' } }),
      message('sticker-own', { key: { remoteJid: '12345@g.us', id: 'sticker-own', fromMe: true }, message: { conversation: '/sticker-test' } }),
    ] });
    socket.ev.emit('messages.upsert', { type: 'append', messages: [message('history')] });
    assert.deepEqual(commands.map(({ id, command }) => [id, command]), [
      ['plain', '/status'], ['extended', '/status'], ['ephemeral', '/status'],
      ['sticker', '/sticker-test'], ['sticker-extended', '/sticker-test'], ['sticker-ephemeral', '/sticker-test'],
      ['other', '/status'], ['dm', '/status'], ['sticker-other', '/sticker-test'],
    ]);
    assert.equal(commands[3].message, stickerMessage);
    now += 301_000;
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('stale', { messageTimestamp: now / 1000 - 301 })] });
    socket.ev.emit('connection.update', { connection: 'close' });
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('offline')] });
    h.timers[0].fn();
    h.sockets[1].ev.emit('connection.update', { connection: 'open' });
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [message('old-socket')] });
    h.wa.stop();
    h.sockets[1].ev.emit('messages.upsert', { type: 'notify', messages: [message('stopped')] });
    assert.equal(commands.length, 9);
  } finally { await h.wa.stop(); h.store.close(); }
});
test('direct phone and LID chats accept fresh sticker and status commands and reject other destinations', async () => {
  const now = 1_800_000_000_000, commands = [];
  const h = harness({ now: () => now, onCommand: (id, command, message) => commands.push({ id, command, message }) });
  try {
    await h.wa.start();
    const socket = h.sockets[0];
    socket.ev.emit('connection.update', { connection: 'open' });
    const message = (id, remoteJid, changes = {}) => ({ key: { remoteJid, id },
      messageTimestamp: now / 1000, message: { conversation: '/sticker-test' }, ...changes });
    const directMessages = [message('phone', '123@s.whatsapp.net'), message('lid', '456@lid', {
      message: { ephemeralMessage: { message: { extendedTextMessage: { text: ' /STICKER-TEST ' } } } },
    })];
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [
      ...directMessages,
      ...['123@s.whatsapp.net', '456@lid'].flatMap((jid) => [
        message('status', jid, { message: { conversation: '/status' } }),
        message('own', jid, { key: { remoteJid: jid, id: 'own', fromMe: true } }),
        message('old', jid, { messageTimestamp: now / 1000 - 1 }),
        message('future', jid, { messageTimestamp: now / 1000 + 61 }),
        message('no-time', jid, { messageTimestamp: undefined }),
        message('caption', jid, { message: { imageMessage: { caption: '/sticker-test' } } }),
      ]),
      ...['invalid@g.us', 'status@broadcast', '123@broadcast', '123@newsletter',
        'invalid@s.whatsapp.net', 'invalid@lid', '', undefined].map((jid) => message('invalid', jid)),
    ] });
    socket.ev.emit('messages.upsert', { type: 'append', messages: [message('history', '123@s.whatsapp.net')] });
    assert.deepEqual(commands.slice(0, 2), directMessages.map((message) => ({ id: message.key.id,
      command: '/sticker-test', message })));
    assert.deepEqual(commands.slice(2).map(({ command, message }) => [command, message.key.remoteJid]),
      [['/status', '123@s.whatsapp.net'], ['/status', '456@lid']]);
  } finally { await h.wa.stop(); h.store.close(); }
});
test('malformed events and messages are skipped without dropping later valid commands', async () => {
  const now = 1_800_000_000_000, commands = [];
  const h = harness({ now: () => now, onCommand: (id) => commands.push(id) });
  try {
    await h.wa.start();
    const socket = h.sockets[0];
    socket.ev.emit('connection.update', { connection: 'open' });
    for (const event of [undefined, null, {}, { type: 'notify' }, { type: 'notify', messages: {} }]) {
      assert.doesNotThrow(() => socket.ev.emit('messages.upsert', event));
    }
    const message = (changes = {}) => ({ key: { remoteJid: '12345@g.us', id: 'valid' },
      messageTimestamp: now / 1000, message: { conversation: '/sticker-test' }, ...changes });
    assert.doesNotThrow(() => socket.ev.emit('messages.upsert', { type: 'notify', messages: [
      null, undefined, false, '/sticker-test', {},
      message({ key: null }), message({ key: { remoteJid: '12345@g.us', id: 42 } }),
      message({ key: { remoteJid: '12345@g.us', id: ' ' } }),
      message({ messageTimestamp: Symbol('invalid') }),
      message({ message: null }), message({ message: { conversation: 42 } }),
      message({ message: { ephemeralMessage: { message: null } } }),
      message(),
    ] }));
    assert.deepEqual(commands, ['valid']);
  } finally { await h.wa.stop(); h.store.close(); }
});
test('status mentions match the bot phone or LID identity and require an actual tag', async () => {
  const now = 1_800_000_000_000, commands = [];
  const h = harness({ now: () => now, onCommand: (id) => commands.push(id) });
  try {
    const auth = sqliteAuth(h.store);
    auth.state.creds.me.lid = '456:2@lid';
    auth.saveCreds();
    await h.wa.start();
    const socket = h.sockets[0];
    socket.ev.emit('connection.update', { connection: 'open' });
    const emit = (id, text, mentions, { ephemeral = false, group = '12345@g.us', fromMe = false } = {}) => {
      const content = { extendedTextMessage: { text, contextInfo: { mentionedJid: mentions } } };
      socket.ev.emit('messages.upsert', { type: 'notify', messages: [{
        key: { id, remoteJid: group, fromMe }, messageTimestamp: now / 1000,
        message: ephemeral ? { ephemeralMessage: { message: content } } : content,
      }] });
    };
    emit('phone', '@123 status', ['123@s.whatsapp.net']);
    emit('lid', '  @456 STATUS  ', ['456@lid'], { ephemeral: true });
    emit('group-slash', '/status', []);
    emit('tagged-slash', '@123 /status', ['123@s.whatsapp.net']);
    emit('private-slash', '/STATUS', [], { group: '789@s.whatsapp.net' });
    emit('private-lid', '/status', [], { group: '789@lid' });
    emit('no-tag', '@123 status', []);
    emit('literal-name', '@Dobby status', []);
    emit('other-person', '@789 status', ['789@s.whatsapp.net']);
    emit('wrong-token', '@789 status', ['123@s.whatsapp.net']);
    emit('wrong-domain', '@123 status', ['123@lid']);
    emit('extra-text', '@123 status please', ['123@s.whatsapp.net']);
    emit('bare', 'status', ['123@s.whatsapp.net']);
    emit('other-group', '@123 status', ['123@s.whatsapp.net'], { group: '999@g.us' });
    emit('dm', '@123 status', ['123@s.whatsapp.net'], { group: '123@s.whatsapp.net' });
    emit('own', '@123 status', ['123@s.whatsapp.net'], { fromMe: true });
    assert.deepEqual(commands, ['phone', 'lid', 'group-slash', 'tagged-slash', 'private-slash', 'private-lid', 'other-group', 'dm']);
  } finally { await h.wa.stop(); h.store.close(); }
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
  assert.deepEqual(h.sends[0].message, { text: 'Prices', linkPreview: null });
  h.wa.groupId = '12345@s.whatsapp.net';
  await assert.rejects(h.wa.send('invalid', 'Prices'), /Invalid configured group/);
  assert.equal(h.sends.length, 1);
  h.wa.stop(); h.store.close();
});

const sticker = () => readFileSync(new URL('../assets/stickers/sticker-test.webp', import.meta.url));
const quoted = (remoteJid = '12345@g.us') => ({ key: { remoteJid, id: 'incoming' },
  message: { conversation: '/sticker-test' } });

test('native WebP sticker replies follow their group, direct phone or LID command', async () => {
  const h = harness();
  try {
    await h.wa.start();
    h.sockets[0].ev.emit('connection.update', { connection: 'open' });
    const buffer = sticker();
    for (const destination of ['12345@g.us', '123@s.whatsapp.net', '456@lid', '999@g.us']) {
      const command = quoted(destination);
      const result = await h.wa.sendSticker('sticker-reply', buffer, command);
      assert.equal(result.key.id, 'sticker-reply');
      assert.deepEqual(h.sends.at(-1), { group: destination,
        message: { sticker: buffer, mimetype: 'image/webp' },
        opts: { messageId: 'sticker-reply', quoted: command } });
      assert.equal(h.sends.at(-1).message.sticker, buffer);
      assert.equal(h.sends.at(-1).opts.quoted, command);
    }
    assert.equal(h.sends.length, 4);
  } finally { await h.wa.stop(); h.store.close(); }
});

test('Baileys builds the actual sticker protocol message and quote without a live upload', async () => {
  const h = harness();
  try {
    await h.wa.start();
    h.sockets[0].ev.emit('connection.update', { connection: 'open' });
    const uploads = [];
    h.sockets[0].sendMessage = (group, content, options) => generateWAMessage(group, content, {
      ...options, userJid: '999@s.whatsapp.net',
      upload: async (_path, { mediaType }) => {
        uploads.push(mediaType);
        return { mediaUrl: 'https://example.invalid/sticker', directPath: '/sticker' };
      },
    });
    const buffer = sticker();
    for (const destination of ['12345@g.us', '123@s.whatsapp.net', '456@lid']) {
      const command = quoted(destination);
      if (destination.endsWith('@g.us')) command.key.participant = '111@s.whatsapp.net';
      const result = await h.wa.sendSticker('protocol-reply', buffer, command);
      assert.equal(result.key.remoteJid, destination);
      assert.equal(result.message.imageMessage, null);
      const payload = result.message.stickerMessage;
      assert.equal(payload.mimetype, 'image/webp');
      assert.equal(Number(payload.fileLength), buffer.length);
      assert.equal(payload.contextInfo.stanzaId, 'incoming');
      assert.equal(payload.contextInfo.participant, command.key.participant ?? destination);
      assert.equal(payload.contextInfo.quotedMessage.conversation, '/sticker-test');
    }
    assert.deepEqual(uploads, ['sticker', 'sticker', 'sticker']);
  } finally { await h.wa.stop(); h.store.close(); }
});

test('sticker delivery rejects unavailable sockets, invalid groups, quotes and artwork before sending', async () => {
  const h = harness();
  try {
    const buffer = sticker();
    await assert.rejects(h.wa.sendSticker('offline', buffer, quoted()), /WhatsApp unavailable/);
    await h.wa.start();
    h.sockets[0].ev.emit('connection.update', { connection: 'open' });
    for (const invalid of [undefined, 'not a buffer', Buffer.from('not WebP'), buffer.subarray(0, 20)]) {
      await assert.rejects(h.wa.sendSticker('invalid', invalid, quoted()));
    }
    for (const command of [undefined, null, {},
      { key: { remoteJid: '12345@g.us', id: '' } },
      { key: { remoteJid: '12345@g.us', id: ' ' } },
      { key: { remoteJid: '12345@g.us', id: 123 } },
      ...['12345@g.us', '123@s.whatsapp.net', '456@lid'].map((remoteJid) => ({
        key: { remoteJid, id: 'own', fromMe: true },
      })),
      ...['invalid@g.us', 'status@broadcast', '123@broadcast', '123@newsletter',
        'invalid@s.whatsapp.net', 'invalid@lid'].map(quoted)]) {
      await assert.rejects(h.wa.sendSticker('invalid-quote', buffer, command), /Invalid quoted sticker command/);
    }
    h.wa.groupId = '12345@s.whatsapp.net';
    await assert.rejects(h.wa.sendSticker('invalid-group', buffer, quoted('invalid@g.us')), /Invalid quoted sticker command/);
    assert.equal(h.sends.length, 0);
  } finally { await h.wa.stop(); h.store.close(); }
});

test('text and sticker sends require matching acknowledgements and never retry failures', async () => {
  const h = harness();
  try {
    await h.wa.start();
    h.sockets[0].ev.emit('connection.update', { connection: 'open' });
    const buffer = sticker();
    let attempts = 0;
    for (const send of [() => h.wa.send('reserved', 'Prices'),
      () => h.wa.sendSticker('reserved', buffer, quoted())]) {
      for (const response of [undefined, {}, { key: { id: 'different' } }]) {
        h.sockets[0].sendMessage = async () => { attempts++; return response; };
        const before = attempts;
        await assert.rejects(send(), /Missing WhatsApp send acknowledgement/);
        assert.equal(attempts, before + 1);
      }
      h.sockets[0].sendMessage = async () => { attempts++; throw new Error('connection lost'); };
      const before = attempts;
      await assert.rejects(send(), /connection lost/);
      assert.equal(attempts, before + 1);
    }
    assert.equal(h.timers.length, 0);
  } finally { await h.wa.stop(); h.store.close(); }
});

test('an unacknowledged sticker send times out once without retrying', async (t) => {
  const h = harness();
  try {
    await h.wa.start();
    h.sockets[0].ev.emit('connection.update', { connection: 'open' });
    let attempts = 0;
    h.sockets[0].sendMessage = () => { attempts++; return new Promise(() => {}); };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const rejected = assert.rejects(h.wa.sendSticker('reserved', sticker(), quoted()), /Operation timed out/);
    t.mock.timers.tick(30_000);
    await rejected;
    assert.equal(attempts, 1);
    assert.equal(h.timers.length, 0);
  } finally { t.mock.timers.reset(); await h.wa.stop(); h.store.close(); }
});

test('status transport replies to any group or DM and rejects broadcasts', async () => {
  const h = harness();
  try {
    await h.wa.start();
    h.sockets[0].ev.emit('connection.update', { connection: 'open' });
    for (const chatId of ['123@s.whatsapp.net', '456@lid', '12345@g.us', '999@g.us']) {
      await h.wa.replyStatus('reply', 'Prices', chatId);
      assert.equal(h.sends.at(-1).group, chatId);
    }
    for (const chatId of ['invalid@g.us', 'status@broadcast', undefined]) {
      await assert.rejects(h.wa.replyStatus('bad', 'Prices', chatId));
    }
    assert.equal(h.sends.length, 4);
  } finally { await h.wa.stop(); h.store.close(); }
});
