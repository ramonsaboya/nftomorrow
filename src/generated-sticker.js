import { createHash } from 'node:crypto';
import sharp from 'sharp';

// Bound native memory on the small monitor host; process one image at a time.
sharp.cache(false);
sharp.concurrency(1);
const options = { limitInputPixels: 4_194_304, failOn: 'warning' };
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export async function validateGeneratedSticker(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 100_000 || buffer.length < 12) {
    throw new Error('Invalid sticker size');
  }
  const image = sharp(buffer, options);
  const meta = await image.metadata();
  if (meta.format !== 'webp' || meta.width !== 512 || meta.height !== 512
      || !meta.hasAlpha || (meta.pages ?? 1) !== 1) throw new Error('Invalid sticker format');
  // Decode, rather than trusting headers; reject opaque and wholly blank output.
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparent = false, visible = false;
  for (let i = info.channels - 1; i < data.length; i += info.channels) {
    transparent ||= data[i] === 0;
    visible ||= data[i] > 0;
  }
  if (!transparent || !visible) throw new Error('Sticker must have visible artwork and transparency');
  return { width: 512, height: 512, bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex') };
}

export async function makeGeneratedSticker(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_IMAGE_BYTES) {
    throw new Error('Invalid generated image size');
  }
  const source = sharp(buffer, options);
  const meta = await source.metadata();
  if (!['png', 'webp'].includes(meta.format) || !meta.hasAlpha || (meta.pages ?? 1) !== 1) {
    throw new Error('Expected a static transparent generated image');
  }
  const alpha = (await source.stats()).channels.at(-1);
  if (alpha.min !== 0 || alpha.max === 0) throw new Error('Generated image lacks visible artwork or a transparent background');
  const resized = await source.rotate().resize(512, 512, {
    fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 },
  }).png().toBuffer();
  for (const quality of [90, 80, 70, 60, 45, 30]) {
    const sticker = await sharp(resized, options).webp({ quality, alphaQuality: 100, effort: 4 }).toBuffer();
    if (sticker.length <= 100_000) {
      await validateGeneratedSticker(sticker);
      return sticker;
    }
  }
  throw new Error('Generated sticker cannot fit the size limit');
}
