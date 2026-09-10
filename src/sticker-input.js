import { downloadContentFromMessage, normalizeMessageContent } from '@whiskeysockets/baileys';
import sharp from 'sharp';
import { MAX_STICKER_IMAGES, STICKER_BATCH } from './sticker-album.js';

export const MAX_INPUT_BYTES = 20 * 1024 * 1024;

export function stickerImageSources(message) {
  const content = normalizeMessageContent(message?.message);
  const context = (content?.imageMessage ?? content?.extendedTextMessage)?.contextInfo;
  const quoted = normalizeMessageContent(context?.quotedMessage);
  if (message?.[STICKER_BATCH]) {
    return [...message[STICKER_BATCH].sources, ...(!quoted?.imageMessage ? [] : [quoted.imageMessage])];
  }
  return [content?.imageMessage, quoted?.imageMessage].filter(Boolean);
}

export async function prepareStickerInput(buffer, dimension = 2048) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_INPUT_BYTES) {
    throw new Error('Invalid input image size');
  }
  const source = sharp(buffer, { limitInputPixels: 16_777_216, failOn: 'warning' });
  const meta = await source.metadata();
  if (!['jpeg', 'png', 'webp'].includes(meta.format) || (meta.pages ?? 1) !== 1) {
    throw new Error('Expected a static photo');
  }
  // Decode, orient, strip metadata and bound upload dimensions and memory.
  const png = await source.rotate().resize(dimension, dimension, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  if (png.length > MAX_INPUT_BYTES) throw new Error('Input image too large');
  return png;
}

export async function loadStickerInputs(message, { signal, download = downloadContentFromMessage,
  timeoutMs = 120_000 } = {}) {
  if (message?.[STICKER_BATCH]?.error) throw new Error('Incomplete image batch');
  const sources = stickerImageSources(message);
  if (sources.length > MAX_STICKER_IMAGES) throw new Error('Too many input images');
  if (!sources.length) return [];
  const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  const images = [];
  let totalBytes = 0;
  for (const source of sources) {
    deadline.throwIfAborted();
    if (source.fileLength != null && (!Number.isFinite(Number(source.fileLength))
        || Number(source.fileLength) < 0 || Number(source.fileLength) > MAX_INPUT_BYTES)) {
      throw new Error('Input image too large');
    }
    // Use WhatsApp's fixed media host, never a sender-selected download host.
    if (typeof source.directPath !== 'string' || !source.directPath.startsWith('/')) {
      throw new Error('Photo download unavailable');
    }
    let stream;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => { stream?.destroy(); reject(deadline.reason); };
      deadline.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const work = (async () => {
        stream = await download({ ...source, url: undefined }, 'image', { host: 'mmg.whatsapp.net' });
        if (deadline.aborted) { stream.destroy(); deadline.throwIfAborted(); }
        const chunks = [];
        let length = 0;
        for await (const chunk of stream) {
          deadline.throwIfAborted();
          length += chunk.length;
          if (length > MAX_INPUT_BYTES) throw new Error('Input image too large');
          chunks.push(chunk);
        }
        const image = await prepareStickerInput(Buffer.concat(chunks), sources.length > 15 ? 1024 : 2048);
        deadline.throwIfAborted();
        return image;
      })();
      const image = await Promise.race([work, aborted]);
      totalBytes += image.length;
      if (totalBytes > 50 * 1024 * 1024) throw new Error('Combined images too large');
      images.push(image);
    } finally {
      deadline.removeEventListener('abort', onAbort);
      stream?.destroy();
    }
  }
  return images;
}
