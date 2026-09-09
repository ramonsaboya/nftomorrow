import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const STICKER_SHA256 = '17f2455288460fbc1756ad4d34322bd31d445c11bb77201f42025d0075d13a58';
export const STICKER_URL = new URL('../assets/stickers/sticker-test.webp', import.meta.url);

export function isStickerChat(jid) {
  return typeof jid === 'string' && (/^\d+(?:-\d+)?@g\.us$/.test(jid)
    || /^\d+@(s\.whatsapp\.net|lid)$/.test(jid));
}

// This prototype serves one offline-decoded, visually reviewed asset. Pinning
// its bytes also rejects damaged bitstreams without adding a runtime codec.
export function validateSticker(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 30 || buffer.length > 100_000
      || buffer.toString('ascii', 0, 4) !== 'RIFF'
      || buffer.readUInt32LE(4) !== buffer.length - 8
      || buffer.toString('ascii', 8, 16) !== 'WEBPVP8X'
      || buffer.readUInt32LE(16) !== 10
      || (buffer[20] & 0x12) !== 0x10
      || buffer.readUIntLE(24, 3) + 1 !== 512
      || buffer.readUIntLE(27, 3) + 1 !== 512) {
    throw new Error('Expected a transparent static 512x512 WebP under 100 KB');
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== STICKER_SHA256) throw new Error('Sticker does not match the validated prototype asset');
  return { width: 512, height: 512, bytes: buffer.length, sha256 };
}

export async function loadSticker() {
  const buffer = await readFile(STICKER_URL);
  validateSticker(buffer);
  return buffer;
}
