import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { packStickerReferences } from '../src/sticker-reference-sheets.js';
import { generateSticker, editReference } from '../src/image-edit.js';

const makePhoto = (n) => sharp({ create: { width: 32, height: 32, channels: 3,
  background: { r: n * 10, g: 50, b: 100 } } }).png().toBuffer();
const photos = await Promise.all(Array.from({ length: 25 }, (_, i) => makePhoto(i)));

test('25 photos are retained in order in 13 sheets, including the final unpaired photo', async () => {
  const sheets = await packStickerReferences(photos, 16);
  assert.equal(sheets.length, 13);
  for (let i = 0; i < 25; i++) {
    const pixel = await sharp(sheets[Math.floor(i / 2)]).extract({ left: (i % 2) * 1024 + 512,
      top: 552, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.deepEqual([...pixel], [i * 10, 50, 100]);
  }
  assert.equal((await sharp(sheets[12]).metadata()).width, 1024);
  assert.equal(await packStickerReferences(photos.slice(0, 16), 16).then((x) => x.length), 16);
});

test('both sticker modes fit 25 photos within provider slots in one paid request', async () => {
  for (const generate of [generateSticker, editReference]) {
    let calls = 0;
    await generate({ prompt: 'Use all 25 people', apiKey: 'test', images: photos,
      readReference: async () => photos[0], convert: async () => Buffer.from('converted'),
      fetchImpl: async (url, options) => {
        calls++;
        assert.match(url, /images\/edits$/);
        assert.equal(options.body.getAll('image[]').length, generate === editReference ? 14 : 13);
        assert.match(options.body.get('prompt'), /all 25 user photos/);
        return Response.json({ data: [{ b64_json: photos[0].toString('base64') }] });
      } });
    assert.equal(calls, 1);
  }
});
