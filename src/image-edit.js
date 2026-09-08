import { readFile } from 'node:fs/promises';
import { makeGeneratedSticker } from './generated-sticker.js';

export const IMAGE_MODEL = 'gpt-image-2';
export const REFERENCE_URL = new URL('../assets/stickers/default-reference.png', import.meta.url);
export const MAX_PROMPT_LENGTH = 1000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const INSTRUCTIONS = 'Edit the supplied reference photo according to the user request. '
  + 'Keep the person recognizable and preserve facial identity unless the requested change requires otherwise. '
  + 'Create one expressive WhatsApp sticker: isolated subject, fully transparent background, '
  + 'clean white outline, square composition, generous transparent margin, and no cropping of the subject. '
  + 'Remove the original sofa/background. Add text only if the user requests it. User request: ';

export class ImageEditError extends Error {
  constructor(code) { super('Image edit failed'); this.code = code; }
}

async function responseJson(response) {
  if (!response.body) throw new ImageEditError('invalid_response');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_RESPONSE_BYTES) throw new ImageEditError('response_too_large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export async function editReference({ prompt, apiKey, quality = 'medium', signal,
  fetchImpl = fetch, readReference = () => readFile(REFERENCE_URL),
  convert = makeGeneratedSticker, timeoutMs = 180_000 }) {
  if (!apiKey) throw new ImageEditError('not_configured');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH
      || !['low', 'medium', 'high'].includes(quality)) throw new ImageEditError('invalid_request');
  const requestSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  requestSignal.throwIfAborted();
  const reference = await readReference();
  if (!Buffer.isBuffer(reference) || !reference.length || reference.length > 10 * 1024 * 1024) {
    throw new ImageEditError('invalid_reference');
  }
  const form = new FormData();
  for (const [key, value] of Object.entries({ model: IMAGE_MODEL, prompt: INSTRUCTIONS + prompt.trim(),
    n: '1', size: '1024x1024', quality, background: 'transparent', output_format: 'png' })) form.set(key, value);
  form.set('image[]', new Blob([reference], { type: 'image/png' }), 'reference.png');
  requestSignal.throwIfAborted();
  // One paid attempt. Never auto-retry an uncertain image-generation request.
  const response = await fetchImpl('https://api.openai.com/v1/images/edits', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
    signal: requestSignal, redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ImageEditError(response.status === 429 ? 'rate_limited' : 'api_rejected');
  }
  const json = await responseJson(response);
  const encoded = json.data?.[0]?.b64_json;
  if (!Array.isArray(json.data) || json.data.length !== 1 || typeof encoded !== 'string'
      || !encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new ImageEditError('invalid_response');
  }
  requestSignal.throwIfAborted();
  const sticker = await convert(Buffer.from(encoded, 'base64'));
  requestSignal.throwIfAborted();
  const usage = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
    if (Number.isSafeInteger(json.usage?.[key]) && json.usage[key] >= 0) usage[key] = json.usage[key];
  }
  return { sticker, usage };
}
