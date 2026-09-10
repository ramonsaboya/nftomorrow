import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { EventEmitter } from 'node:events';
import { makeAnimatedSticker, makeGeneratedSticker, validateGeneratedSticker } from '../src/generated-sticker.js';
import { generateSticker, editReference, imageErrorDetails } from '../src/image-edit.js';
import { WhatsApp, parseCommand } from '../src/whatsapp.js';
import { Store } from '../src/store.js';

// Every cell has a distinct shade; the transparent perimeter checks alpha too.
const pixels = Buffer.alloc(1024 * 1024 * 4);
for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) {
  const i = (y * 1024 + x) * 4;
  pixels[i] = (Math.floor(y / 256) * 4 + Math.floor(x / 256)) * 16;
  pixels[i + 1] = 80; pixels[i + 2] = 140;
  pixels[i + 3] = x % 256 > 15 && y % 256 > 15 && x % 256 < 240 && y % 256 < 240 ? 255 : 0;
}
const sheet = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 4 } }).png().toBuffer();
const animatedSticker = await makeAnimatedSticker(sheet);

test('animation sheet becomes a two-second loop with sixteen ordered frames and preserved transparency', async () => {
  const asset = await validateGeneratedSticker(animatedSticker, { requireAnimated: true });
  assert.equal(asset.animated, true); assert.equal(asset.frames, 16);
  assert.equal(asset.durationMs, 2000); assert.ok(asset.bytes <= 500_000);
  const meta = await sharp(animatedSticker, { animated: true }).metadata();
  assert.equal(meta.loop, 0); assert.equal(meta.width, 512); assert.equal(meta.pageHeight, 512);
  assert.deepEqual(meta.delay, Array(16).fill(125));
  const raw = await sharp(animatedSticker, { animated: true }).ensureAlpha().raw().toBuffer();
  for (let frame = 0; frame < 16; frame++) {
    const start = frame * 512 * 512 * 4;
    assert.equal(raw[start + 3], 0);
    const center = start + (256 * 512 + 256) * 4;
    assert.ok(Math.abs(raw[center] - frame * 16) < 6, `frame ${frame} must remain in order`);
    assert.equal(raw[center + 3], 255);
  }
});

async function animation({ count = 2, delay = 125, loop = 0, blankLast = false } = {}) {
  const frames = Buffer.alloc(512 * 512 * 4 * count);
  for (let frame = 0; frame < count; frame++) {
    for (let i = frame * 512 * 512 * 4; i < (frame + 1) * 512 * 512 * 4; i += 4) {
      frames[i] = frame * 10;
      frames[i + 3] = blankLast && frame === count - 1 ? 0 : 255;
    }
  }
  return sharp(frames, { raw: { width: 512, height: 512 * count, channels: 4, pageHeight: 512 } })
    .webp({ loop, delay: Array(count).fill(delay), lossless: true }).toBuffer();
}

test('validation rejects overlong, fast, non-looping, excessive-frame, blank and corrupt animations', async () => {
  // The encoder normalizes tiny delays; patch an ANMF timing to exercise the real file limit.
  const fast = Buffer.from(animatedSticker);
  for (let offset = 12; offset < fast.length; offset += 8 + fast.readUInt32LE(offset + 4) + (fast.readUInt32LE(offset + 4) % 2)) {
    if (fast.toString('ascii', offset, offset + 4) === 'ANMF') { fast.writeUIntLE(5, offset + 20, 3); break; }
  }
  for (const [index, input] of [await animation({ delay: 6000 }), fast,
    await animation({ loop: 1 }), await animation({ count: 17 }), await animation({ blankLast: true }),
    animatedSticker.subarray(0, animatedSticker.length - 30), Buffer.alloc(500_001)].entries()) {
    await assert.rejects(validateGeneratedSticker(input), `invalid animation case ${index}`);
  }
  await assert.rejects(validateGeneratedSticker(await makeGeneratedSticker(sheet), { requireAnimated: true }));
  // The original static converter must still reject animated source files.
  await assert.rejects(makeGeneratedSticker(animatedSticker));
});

test('sheet conversion rejects wrong dimensions, empty artwork, still frames and animated inputs', async () => {
  const blank = await sharp({ create: { width: 1024, height: 1024, channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const still = await sharp({ create: { width: 1024, height: 1024, channels: 3,
    background: 'red' } }).png().toBuffer();
  for (const input of [blank, still, animatedSticker, Buffer.from('broken'), Buffer.alloc(12 * 1024 * 1024 + 1),
    await sharp(sheet).resize(512, 512).png().toBuffer()]) await assert.rejects(makeAnimatedSticker(input));
});

test('animated text, photo and reference requests use one image API attempt and return animation', async () => {
  for (const [generate, images] of [[generateSticker, []], [generateSticker, [sheet]], [editReference, [sheet]]]) {
    let attempts = 0;
    const result = await generate({ apiKey: 'test', prompt: 'A dragon waving', animated: true, images,
      readReference: async () => sheet,
      fetchImpl: async (url, options) => {
        attempts++;
        const editing = images.length > 0;
        assert.equal(url, `https://api.openai.com/v1/images/${editing ? 'edits' : 'generations'}`);
        const params = editing ? Object.fromEntries(options.body) : JSON.parse(options.body);
        assert.match(params.prompt, /16 consecutive animation frames in a 4 by 4 grid/);
        assert.match(params.prompt, /A dragon waving$/);
        assert.equal(params.output_format, 'png');
        assert.equal(Number(params.n), 1);
        if (generate === editReference) {
          assert.equal(options.body.getAll('image[]').length, 2);
          assert.equal(params.background, 'opaque');
        }
        return Response.json({ data: [{ b64_json: sheet.toString('base64') }] });
      } });
    assert.equal(attempts, 1);
    assert.equal((await validateGeneratedSticker(result.sticker)).animated, true);
  }
});

test('invalid generated animation fails with a sanitized conversion error and never retries', async () => {
  let attempts = 0;
  const invalid = await sharp(sheet).resize(512, 512).png().toBuffer();
  await assert.rejects(generateSticker({ apiKey: 'test', prompt: 'Dance', animated: true,
    fetchImpl: async () => { attempts++; return Response.json({ data: [{ b64_json: invalid.toString('base64') }] }); },
  }), (error) => imageErrorDetails(error).code === 'conversion_failed');
  assert.equal(attempts, 1);
});

test('animated captions and mentions preserve the flag; transport sends a native animated sticker', async () => {
  assert.deepEqual(parseCommand({ imageMessage: { caption: '/sticker --gif a waving dragon' } }),
    { command: '/sticker', prompt: '--gif a waving dragon' });
  assert.deepEqual(parseCommand({ extendedTextMessage: { text: '@999 euvousticker --animated waving',
    contextInfo: { mentionedJid: ['999@s.whatsapp.net'] } } }, { id: '999@s.whatsapp.net' }),
  { command: '/euvousticker', prompt: '--animated waving' });
  const store = new Store(':memory:'), sends = [];
  const socket = { ev: new EventEmitter(), end() {}, async sendMessage(chat, content, options) {
    sends.push({ chat, content, options }); return { key: { id: options.messageId } };
  } };
  const wa = new WhatsApp({ store, makeSocket: () => socket });
  try {
    wa.connect({ state: { creds: { me: { id: '999@s.whatsapp.net' } } }, saveCreds() {} });
    socket.ev.emit('connection.update', { connection: 'open' });
    const quote = { key: { id: 'request', remoteJid: '123@g.us', participant: '456@s.whatsapp.net' },
      message: { conversation: '/sticker --animated waving' } };
    await wa.sendGeneratedSticker('animated', animatedSticker, quote);
    assert.equal(sends.length, 1); assert.equal(sends[0].chat, '123@g.us');
    assert.equal(sends[0].content.isAnimated, true);
    assert.equal(sends[0].content.mimetype, 'image/webp');
    assert.deepEqual(sends[0].content.sticker, animatedSticker);
    assert.deepEqual(sends[0].options.quoted, quote);
  } finally { await wa.stop(); store.close(); }
});
