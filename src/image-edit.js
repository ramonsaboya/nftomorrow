import { readFile } from 'node:fs/promises';
import { makeGeneratedSticker, makeAnimatedSticker, ANIMATION_GRID, ANIMATION_FRAMES } from './generated-sticker.js';
import { MAX_INPUT_BYTES } from './sticker-input.js';
import { MAX_STICKER_IMAGES } from './sticker-album.js';
import { packStickerReferences } from './sticker-reference-sheets.js';
import sharp from 'sharp';

export const IMAGE_MODEL = 'gpt-image-2.5-sunburst';
export const REFERENCE_URL = new URL('../assets/stickers/default-reference.png', import.meta.url);
export const MAX_PROMPT_LENGTH = 4000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const PHOTO_INSTRUCTIONS = 'Edit the supplied photos according to the user request. '
  + 'By default preserve the original background, surroundings, framing and subject identity; change only the requested details. '
  + 'The word sticker describes the WhatsApp output format, not a request to remove or replace the background. '
  + 'Do not isolate the subject, add a white or solid-color backdrop, or add a cutout outline or border unless explicitly requested. '
  + 'Explicit requests for a different scene, transparency, a cutout or another style take precedence over these defaults. '
  + 'When combining photos, follow the requested composition and retain the relevant surroundings unless asked otherwise. '
  + '\nUser request: ';
const ANIMATION_INSTRUCTIONS = `Create a sprite sheet for a seamless two-second looping animated sticker. `
  + `Output exactly ${ANIMATION_FRAMES} consecutive animation frames in a ${ANIMATION_GRID} by ${ANIMATION_GRID} grid on a 1024x1024 canvas. `
  + 'Each cell is exactly 256x256 pixels; frames run left-to-right, then top-to-bottom. '
  + 'No gutters, margins, borders, panel labels or frame numbers. Each cell contains the entire scene, '
  + 'with consistent subject identity, scale, camera, lighting and background. Animate the requested motion '
  + 'in small successive steps, with a smooth transition from the last frame back to the first. '
  + 'The first frame must be complete and readable as a standalone sticker. Keep requested captions fixed across frames. '
  + 'Apply the following creative instructions separately to every frame, not to the overall sheet. ';
const INSTRUCTIONS = 'Customize the supplied original photo using the user\'s overall theme or scene. '
  + 'Create a square, full-frame image with an opaque background, not a transparent cutout or outlined sticker. '
  + 'By default stay very close to the original: preserve the man\'s facial identity, appearance, pose, framing, '
  + 'sofa and surroundings. Build on the existing photo with themed clothes, accessories and small details; '
  + 'make only the pose, appearance and scene changes needed for the requested theme. '
  + 'Allow major transformations when the user explicitly asks to go crazy, be creative or change those details. '
  + 'Add a caption only when requested. By default place it in the bottom-left corner, unless another location '
  + 'clearly makes more sense for the composition or is requested. Use readable plain black text in a simple, '
  + 'square sans-serif font, perfectly horizontal, without a background box, outline, shadow, tilt or decoration. '
  + 'Choose a readable placement and size. Elaborate typography is allowed only when explicitly requested. '
  + 'User theme and customization: ';

export class ImageEditError extends Error {
  constructor(code, details = {}) { super('Image edit failed'); this.code = code; this.details = details; }
}

// Never retain provider messages: they can contain the prompt or credentials.
export function imageErrorDetails(error) {
  const code = error instanceof ImageEditError ? error.code
    : error?.name === 'TimeoutError' ? 'timeout'
      : error?.name === 'AbortError' ? 'cancelled' : 'internal_error';
  const details = { code };
  const source = error instanceof ImageEditError ? error.details : {};
  if (Number.isInteger(source.status) && source.status >= 100 && source.status <= 599) details.status = source.status;
  if (/^req_[a-zA-Z0-9_-]{1,100}$/.test(source.requestId ?? '')) details.requestId = source.requestId;
  const codes = ['billing_hard_limit_reached', 'insufficient_quota', 'rate_limit_exceeded',
    'invalid_api_key', 'model_not_found', 'permission_denied', 'content_policy_violation',
    'moderation_blocked', 'invalid_value', 'invalid_parameter', 'unsupported_parameter',
    'server_error', 'invalid_request_error'];
  if (codes.includes(source.apiCode)) details.apiCode = source.apiCode;
  if (['invalid_request_error', 'authentication_error', 'permission_error', 'rate_limit_error',
    'server_error', 'insufficient_quota', 'billing_error'].includes(source.apiType)) details.apiType = source.apiType;
  if (['model', 'image', 'image[]', 'prompt', 'background', 'quality', 'size', 'output_format', 'n'].includes(source.param)) details.param = source.param;
  return details;
}

async function responseJson(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (!response.body) throw new ImageEditError('invalid_response');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) throw new ImageEditError('response_too_large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export function editReference(options) { return createImage({ ...options, mode: 'reference' }); }
export function generateSticker(options) { return createImage({ ...options, mode: 'freeform' }); }

async function createImage({ prompt, apiKey, quality = 'max', signal, mode, images = [], animated = false,
  revision, referenceImage,
  fetchImpl = fetch, readReference = () => readFile(REFERENCE_URL),
  convert = animated ? makeAnimatedSticker : makeGeneratedSticker, timeoutMs = 240_000 }) {
  if (!apiKey) throw new ImageEditError('not_configured');
  if (!Array.isArray(images) || images.length > MAX_STICKER_IMAGES || images.some((image) =>
    !Buffer.isBuffer(image) || !image.length || image.length > MAX_INPUT_BYTES)) throw new ImageEditError('invalid_request');
  if (typeof animated !== 'boolean' || typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH
      || !['low', 'medium', 'high', 'xhigh', 'max', 'auto'].includes(quality)) throw new ImageEditError('invalid_request');
  const requestSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  requestSignal.throwIfAborted();
  let body, headers = { Authorization: `Bearer ${apiKey}` };
  const params = { model: IMAGE_MODEL, prompt: mode === 'reference' ? INSTRUCTIONS + prompt.trim() : prompt.trim(),
    n: 1, size: '1024x1024', quality, background: mode === 'reference' ? 'opaque' : 'auto', output_format: 'png' };
  if (mode === 'freeform' && images.length) params.prompt = PHOTO_INSTRUCTIONS + prompt.trim();
  if (animated) params.prompt = ANIMATION_INSTRUCTIONS + params.prompt;
  if (revision) params.prompt = (animated ? ANIMATION_INSTRUCTIONS : '')
    + 'Edit the supplied current sticker. Preserve its identity, composition and all details unless the latest request changes them. '
    + 'Preserve its background and framing unless asked to change them; sticker refers to the output format, not a cutout style. '
    + 'Do not add a white backdrop, remove the background or add an outline unless explicitly requested. '
    + 'Use the original photos for identity and details, and the original prompt and earlier edits as context. '
    + 'If asked to restore the original photo background, use the original photos to restore it while retaining the other requested edits. '
    + 'The latest request takes precedence over earlier instructions. '
    + (animated ? 'The current sticker image shows its first frame; preserve the requested motion while applying the edit. ' : '')
    + '\nOriginal prompt: ' + revision.originalPrompt
    + '\nEarlier edits in order: ' + JSON.stringify(revision.edits)
    + '\nLatest change request: ' + prompt.trim();
  const editing = mode === 'reference' || images.length > 0 || Boolean(revision);
  if (editing) {
    const form = new FormData();
    for (const [key, value] of Object.entries(params)) form.set(key, String(value));
    if (mode === 'reference') {
      let reference;
      try { reference = referenceImage ?? await readReference(); }
      catch { throw new ImageEditError('reference_unavailable'); }
      if (!Buffer.isBuffer(reference) || !reference.length || reference.length > 10 * 1024 * 1024) {
        throw new ImageEditError('invalid_reference');
      }
      form.append('image[]', new Blob([reference], { type: 'image/png' }), 'reference.png');
      referenceImage = reference;
      if (images.length && !revision) form.set('prompt', 'The first image is the original photo to customize. '
        + 'Use the remaining images as additional references according to the user request. ' + params.prompt);
    }
    if (revision) {
      const current = await sharp(revision.sticker, { limitInputPixels: 4_194_304 }).png().toBuffer();
      form.append('image[]', new Blob([current], { type: 'image/png' }), 'current-sticker.png');
      form.set('prompt', (mode === 'reference'
        ? 'Image 1 is the original Eu Vou photo. Image 2 is the current sticker to edit. '
        : 'Image 1 is the current sticker to edit. ')
        + 'Remaining images are the original user photos. ' + params.prompt);
    }
    const references = await packStickerReferences(images, 16 - (mode === 'reference' ? 1 : 0) - (revision ? 1 : 0));
    if (references !== images) form.set('prompt', form.get('prompt')
      + '\nThe attached reference sheets contain all ' + images.length
      + ' user photos in order, numbered Photo 1 onward, two per sheet. Use every photo as relevant to the request. '
      + 'These are input references, not a requested output layout: do not copy the sheet borders, numbers or grid unless requested.');
    for (const [index, image] of references.entries()) {
      form.append('image[]', new Blob([image], { type: 'image/png' }), `attachment-${index + 1}.png`);
    }
    body = form;
  } else {
    body = JSON.stringify(params);
    headers['Content-Type'] = 'application/json';
  }
  requestSignal.throwIfAborted();
  // One paid attempt. Never auto-retry an uncertain image-generation request.
  let response;
  try { response = await fetchImpl(`https://api.openai.com/v1/images/${editing ? 'edits' : 'generations'}`, {
    method: 'POST', headers, body,
    signal: requestSignal, redirect: 'error',
  }); } catch {
    requestSignal.throwIfAborted();
    throw new ImageEditError('network_error');
  }
  const details = { status: response.status, requestId: response.headers.get('x-request-id') };
  if (!response.ok) {
    let failure;
    try { failure = (await responseJson(response, 16 * 1024))?.error; } catch { /* Keep HTTP details even for non-JSON or oversized errors. */ }
    throw new ImageEditError(response.status === 429 ? 'rate_limited' : 'api_rejected',
      { ...details, apiCode: failure?.code, apiType: failure?.type, param: failure?.param });
  }
  let json;
  try { json = await responseJson(response); }
  catch (error) {
    requestSignal.throwIfAborted();
    throw new ImageEditError(error instanceof ImageEditError ? error.code : 'invalid_response', details);
  }
  const encoded = json?.data?.[0]?.b64_json;
  if (!Array.isArray(json?.data) || json.data.length !== 1 || typeof encoded !== 'string'
      || !encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new ImageEditError('invalid_response', details);
  }
  requestSignal.throwIfAborted();
  let sticker;
  try { sticker = await convert(Buffer.from(encoded, 'base64')); }
  catch { throw new ImageEditError('conversion_failed', details); }
  requestSignal.throwIfAborted();
  const usage = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
    if (Number.isSafeInteger(json.usage?.[key]) && json.usage[key] >= 0) usage[key] = json.usage[key];
  }
  return { sticker, usage, referenceImage };
}
