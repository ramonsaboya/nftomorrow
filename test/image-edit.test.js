import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { editReference, generateSticker, imageErrorDetails, REFERENCE_URL } from '../src/image-edit.js';
import { makeGeneratedSticker, validateGeneratedSticker } from '../src/generated-sticker.js';
import { loadConfig } from '../src/config.js';

async function artwork({ transparent = true, blank = false, width = 128, height = 128 } = {}) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    data[i] = x % 256; data[i + 1] = y % 256; data[i + 2] = 170;
    data[i + 3] = blank ? 0 : (!transparent || (x > 16 && y > 16 && x < width - 16 && y < height - 16) ? 255 : 0);
  }
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
const png = await artwork();

test('revisions upload the current sticker and original photos with ordered edit context', async () => {
  const sticker = await makeGeneratedSticker(png);
  for (const generate of [generateSticker, editReference]) {
    await generate({ prompt: 'Make the hat red', apiKey: 'test', images: [png],
      referenceImage: png,
      readReference: () => { throw new Error('Must use the saved original'); },
      revision: { originalPrompt: 'A DJ', edits: ['Add a hat'], sticker },
      fetchImpl: async (url, options) => {
        assert.match(url, /\/edits$/);
        const files = options.body.getAll('image[]');
        assert.equal(files.length, generate === editReference ? 3 : 2);
        assert.equal(files.at(-2).name, 'current-sticker.png');
        assert.deepEqual(Buffer.from(await files.at(-1).arrayBuffer()), png);
        const prompt = options.body.get('prompt');
        assert.match(prompt, /Original prompt: A DJ/);
        assert.match(prompt, /Earlier edits in order: \["Add a hat"\]/);
        assert.match(prompt, /Latest change request: Make the hat red/);
        assert.match(prompt, /Preserve its background and framing unless asked to change them/);
        assert.match(prompt, /use the original photos to restore it/);
        return Response.json({ data: [{ b64_json: png.toString('base64') }] });
      } });
  }
});

test('attached photos get preservation defaults and user text; Eu Vou keeps the original first', async () => {
  for (const generate of [generateSticker, editReference]) {
    await generate({ prompt: 'Use these photos together', apiKey: 'test', images: [png, png],
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://api.openai.com/v1/images/edits');
        assert.equal(options.headers['Content-Type'], undefined);
        const files = options.body.getAll('image[]');
        assert.equal(files.length, generate === editReference ? 3 : 2);
        assert.deepEqual(Buffer.from(await files.at(-1).arrayBuffer()), png);
        if (generate === generateSticker) {
          assert.match(options.body.get('prompt'), /preserve the original background, surroundings, framing and subject identity/);
          assert.match(options.body.get('prompt'), /User request: Use these photos together$/);
        }
        else assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), await readFile(REFERENCE_URL));
        return Response.json({ data: [{ b64_json: png.toString('base64') }] });
      } });
  }
});

test('photo edits preserve the scene by default while allowing explicit cutouts, also in animation', async () => {
  for (const animated of [false, true]) {
    for (const prompt of ['make a sticker of this girl with hearts in front of the eyes',
      'Remove the background and make a transparent cutout']) {
      await generateSticker({ prompt, animated, apiKey: 'test', images: [png], convert: async (image) => image,
        fetchImpl: async (_url, options) => {
          const sent = options.body.get('prompt');
          assert.match(sent, /not a request to remove or replace the background/);
          assert.match(sent, /Do not isolate the subject, add a white or solid-color backdrop/);
          assert.match(sent, /Explicit requests.*take precedence over these defaults/);
          assert.ok(sent.endsWith('User request: ' + prompt));
          assert.equal(sent.includes('Create a sprite sheet'), animated);
          assert.equal(options.body.get('background'), 'auto');
          return Response.json({ data: [{ b64_json: png.toString('base64') }] });
        } });
    }
  }
});

test('freeform generation sends the exact user prompt without a reference or style instructions', async () => {
  const prompt = 'A purple dragon, wildly creative, caption OLÁ in ornate gold lettering';
  const result = await generateSticker({ prompt, apiKey: 'test',
    readReference: () => { throw new Error('Must not read or upload a reference'); },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/images/generations');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(options.body), { model: 'gpt-image-2.5-sunburst', prompt,
        n: 1, size: '1024x1024', quality: 'max', background: 'auto', output_format: 'png' });
      return Response.json({ data: [{ b64_json: (await artwork({ transparent: false })).toString('base64') }] });
    } });
  await validateGeneratedSticker(result.sticker);
});

test('opaque reference artwork stays square and opaque, including RGB images without an alpha channel', async () => {
  for (const input of [await artwork({ transparent: false }),
    await sharp(await artwork({ transparent: false })).removeAlpha().png().toBuffer()]) {
    const result = await makeGeneratedSticker(input);
    await validateGeneratedSticker(result);
    const { data, info } = await sharp(result).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 512); assert.equal(info.height, 512);
    for (let i = 3; i < data.length; i += 4) assert.equal(data[i], 255);
  }
});

test('generated artwork becomes a decodable static transparent 512px sticker under 100 KB', async () => {
  const sticker = await makeGeneratedSticker(png);
  const info = await validateGeneratedSticker(sticker);
  assert.equal(info.width, 512); assert.equal(info.height, 512);
  assert.ok(info.bytes <= 100_000);
  const decoded = await sharp(sticker).ensureAlpha().raw().toBuffer();
  assert.equal(decoded[3], 0);
  assert.ok(decoded.some((value, index) => index % 4 === 3 && value > 0));
  await assert.rejects(validateGeneratedSticker(sticker.subarray(0, 45)));
});

test('blank, animated/invalid, oversized and excessive-pixel images fail closed', async () => {
  for (const invalid of [Buffer.from('broken'), Buffer.alloc(12 * 1024 * 1024 + 1),
    await artwork({ blank: true }), await sharp({ create: { width: 4096, height: 4096,
      channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()]) {
    await assert.rejects(makeGeneratedSticker(invalid));
  }
  await assert.rejects(validateGeneratedSticker(Buffer.alloc(100_001)));
});

test('premium reference edit uploads the original and requests opaque square artwork', async () => {
  const requests = [];
  const result = await editReference({ prompt: 'Make him a DJ saying OLÁ', apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ data: [{ b64_json: png.toString('base64') }],
        usage: { input_tokens: 20, output_tokens: 30, total_tokens: 50, secret: 'omit' } });
    } });
  assert.equal(requests.length, 1);
  const { url, options } = requests[0];
  assert.equal(url, 'https://api.openai.com/v1/images/edits');
  assert.equal(options.headers.Authorization, 'Bearer test-key');
  assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
  for (const [name, value] of Object.entries({ model: 'gpt-image-2.5-sunburst', n: '1', size: '1024x1024',
    quality: 'max', background: 'opaque', output_format: 'png' })) {
    assert.equal(options.body.get(name), value);
  }
  assert.equal(options.body.has('input_fidelity'), false);
  assert.match(options.body.get('prompt'), /Make him a DJ saying OLÁ$/);
  assert.deepEqual(Buffer.from(await options.body.get('image[]').arrayBuffer()), await readFile(REFERENCE_URL));
  assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 30, total_tokens: 50 });
  await validateGeneratedSticker(result.sticker);
});

test('API rejection, malformed output and uncertain network failure each make only one attempt', async () => {
  for (const response of [() => new Response('private provider details', { status: 429 }),
    () => new Response('private provider details', { status: 500 }),
    () => Response.json({ data: [] }), () => Response.json({ data: [{ b64_json: '$bad' }] }),
    () => Response.json({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] }),
    () => { throw new Error('uncertain connection'); }]) {
    let calls = 0;
    await assert.rejects(editReference({ prompt: 'Edit', apiKey: 'test', readReference: async () => png,
      fetchImpl: async () => { calls++; return response(); } }));
    assert.equal(calls, 1);
  }
});

test('missing key, bad prompt, missing reference and pre-aborted work never call the API', async () => {
  let calls = 0;
  const base = { prompt: 'Edit', apiKey: 'test', readReference: async () => png,
    fetchImpl: async () => { calls++; throw new Error('unexpected'); } };
  for (const changes of [{ apiKey: '' }, { prompt: '' }, { prompt: 'a'.repeat(4001) },
    { quality: 'invalid' }, { readReference: async () => { throw new Error('private filepath'); } },
    { signal: AbortSignal.abort() }]) await assert.rejects(editReference({ ...base, ...changes }));
  assert.equal(calls, 0);
});

test('shutdown aborts an active API request and never retries it', async () => {
  const controller = new AbortController();
  let calls = 0, started;
  const ready = new Promise((resolve) => { started = resolve; });
  const run = editReference({ prompt: 'Edit', apiKey: 'test', signal: controller.signal,
    readReference: async () => png, fetchImpl: async (_url, { signal }) => {
      calls++; started();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
  const rejected = assert.rejects(run);
  await ready; controller.abort(); await rejected;
  assert.equal(calls, 1);
});

test('an oversized API response is cancelled before decoding or converting image data', async () => {
  let cancelled = false, converted = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(editReference({ prompt: 'Edit', apiKey: 'test', readReference: async () => png,
    fetchImpl: async () => response, convert: async () => { converted = true; } }));
  assert.equal(cancelled, true); assert.equal(converted, false);
});

test('the API deadline cancels a hung paid attempt without retrying', async () => {
  let calls = 0;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(editReference({ prompt: 'Edit', apiKey: 'test', timeoutMs: 20,
      readReference: async () => png,
      fetchImpl: async (_url, { signal }) => {
        calls++;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      } }), { name: 'TimeoutError' });
    assert.equal(calls, 1);
  } finally { clearTimeout(keepAlive); }
});

test('image configuration has explicit defaults and validates quality and daily limits', () => {
  const env = { CONFIG_PATH: fileURLToPath(new URL('../config.example.json', import.meta.url)) };
  assert.deepEqual(loadConfig(env).imageStickers, { apiKey: '', quality: 'max', dailyLimit: 20 });
  assert.deepEqual(loadConfig({ ...env, OPENAI_API_KEY: ' test ', OPENAI_IMAGE_QUALITY: 'high', STICKER_DAILY_LIMIT: '5' }).imageStickers,
    { apiKey: 'test', quality: 'high', dailyLimit: 5 });
  for (const changes of [{ OPENAI_IMAGE_QUALITY: 'invalid' }, { STICKER_DAILY_LIMIT: '0' },
    { STICKER_DAILY_LIMIT: 'NaN' }, { STICKER_DAILY_LIMIT: '1.5' }]) assert.throws(() => loadConfig({ ...env, ...changes }));
});

test('API errors retain support identifiers and billing codes without provider messages or unknown fields', async () => {
  await assert.rejects(editReference({ prompt: 'private prompt', apiKey: 'test', readReference: async () => png,
    fetchImpl: async () => Response.json({ error: { code: 'billing_hard_limit_reached',
      type: 'invalid_request_error', param: null, message: 'private prompt and sk-secret', secret: 'omit' } },
    { status: 400, headers: { 'x-request-id': 'req_123abc' } }) }), (error) => {
    assert.deepEqual(imageErrorDetails(error), { code: 'api_rejected', status: 400, requestId: 'req_123abc',
      apiCode: 'billing_hard_limit_reached', apiType: 'invalid_request_error' });
    assert.doesNotMatch(JSON.stringify(error), /private prompt|sk-secret|omit/);
    return true;
  });
  await assert.rejects(editReference({ prompt: 'Edit', apiKey: 'test', readReference: async () => png,
    fetchImpl: async () => Response.json({ error: { code: 'sk-private', type: 'private prompt', param: 'secret' } },
      { status: 403, headers: { 'x-request-id': 'sk-private' } }) }), (error) => {
    assert.deepEqual(imageErrorDetails(error), { code: 'api_rejected', status: 403 }); return true;
  });
});

test('oversized and non-JSON API errors preserve HTTP status and remain bounded without retries', async () => {
  for (const body of ['private upstream HTML', 'x'.repeat(16 * 1024 + 1)]) {
    let cancelled = false, calls = 0;
    await assert.rejects(editReference({ prompt: 'Edit', apiKey: 'test', readReference: async () => png,
      fetchImpl: async () => { calls++; return new Response(new ReadableStream({
        start(controller) { controller.enqueue(Buffer.from(body)); if (body.length < 16384) controller.close(); },
        cancel() { cancelled = true; },
      }), { status: 503, headers: { 'x-request-id': 'req_upstream' } }); } }), (error) => {
      assert.deepEqual(imageErrorDetails(error), { code: 'api_rejected', status: 503, requestId: 'req_upstream' });
      return true;
    });
    assert.equal(calls, 1);
    if (body.length > 16384) assert.equal(cancelled, true);
  }
});

test('failed conversion is distinguished from API rejection and preserves the successful request ID', async () => {
  await assert.rejects(editReference({ prompt: 'Edit', apiKey: 'test', readReference: async () => png,
    fetchImpl: async () => Response.json({ data: [{ b64_json: png.toString('base64') }] },
      { headers: { 'x-request-id': 'req_conversion' } }),
    convert: async () => { throw new Error('private native error'); } }), (error) => {
    assert.deepEqual(imageErrorDetails(error), { code: 'conversion_failed', status: 200, requestId: 'req_conversion' });
    assert.doesNotMatch(JSON.stringify(error), /private native/); return true;
  });
});
