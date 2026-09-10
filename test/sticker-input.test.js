import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { loadStickerInputs, stickerImageSources, MAX_INPUT_BYTES } from '../src/sticker-input.js';
import { parseCommand } from '../src/whatsapp.js';

const photo = { directPath: '/photo', caption: '/sticker turn me into a wizard' };
const message = { message: { imageMessage: photo } };
const jpeg = await sharp({ create: { width: 32, height: 48, channels: 3, background: 'red' } }).jpeg().toBuffer();

test('photo captions and actual mentions parse, ordinary captions do not', () => {
  assert.deepEqual(parseCommand(message.message), { command: '/sticker', prompt: 'turn me into a wizard' });
  assert.deepEqual(parseCommand({ imageMessage: { caption: '@123 euvousticker beach',
    contextInfo: { mentionedJid: ['123@s.whatsapp.net'] } } }, { id: '123:1@s.whatsapp.net' }),
  { command: '/euvousticker', prompt: 'beach' });
  assert.equal(parseCommand({ imageMessage: { caption: '@123 sticker beach' } }, { id: '123@s.whatsapp.net' }), null);
  assert.equal(parseCommand({ imageMessage: { caption: 'a photo' } }), null);
});

test('captioned and quoted images are collected in order, including disappearing messages', async () => {
  const second = { ...photo, directPath: '/second' };
  const msg = { message: { ephemeralMessage: { message: { imageMessage: {
    ...photo, contextInfo: { quotedMessage: { imageMessage: second } },
  } } } } };
  assert.equal(stickerImageSources(msg).length, 2);
  const paths = [];
  const images = await loadStickerInputs(msg, { download: async (source, type, options) => {
    paths.push(source.directPath);
    assert.equal(type, 'image');
    assert.equal(source.url, undefined);
    assert.equal(options.host, 'mmg.whatsapp.net');
    return Readable.from([jpeg]);
  } });
  assert.deepEqual(paths, ['/photo', '/second']);
  for (const image of images) assert.equal((await sharp(image).metadata()).format, 'png');
  assert.deepEqual(stickerImageSources({ message: { extendedTextMessage: { text: '/sticker wizard',
    contextInfo: { quotedMessage: { imageMessage: photo } } } } }), [photo]);
  assert.deepEqual(await loadStickerInputs({ message: { conversation: '/sticker dragon' } }), []);
});

test('invalid, oversized and aborted downloads fail without returning image inputs', async () => {
  let calls = 0;
  await assert.rejects(loadStickerInputs({ message: { imageMessage: { ...photo, fileLength: MAX_INPUT_BYTES + 1 } } },
    { download: async () => { calls++; } }));
  assert.equal(calls, 0);
  for (const buffer of [Buffer.from('broken'), Buffer.alloc(MAX_INPUT_BYTES + 1)]) {
    const stream = Readable.from([buffer]);
    await assert.rejects(loadStickerInputs(message, { download: async () => stream }));
    assert.equal(stream.destroyed, true);
  }
  const controller = new AbortController();
  const stream = new Readable({ read() {} });
  const pending = loadStickerInputs(message, { signal: controller.signal, download: async () => stream });
  await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(stream.destroyed, true);
});

test('download deadline releases the job and destroys a stream that arrives late', async () => {
  let resolve;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const pending = loadStickerInputs(message, { timeoutMs: 10,
      download: () => new Promise((done) => { resolve = done; }) });
    await assert.rejects(pending, { name: 'TimeoutError' });
    const stream = Readable.from([jpeg]);
    resolve(stream);
    await new Promise(setImmediate);
    assert.equal(stream.destroyed, true);
  } finally { clearTimeout(keepAlive); }
});
