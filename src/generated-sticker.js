import { createHash } from 'node:crypto';
import sharp from 'sharp';

// Bound native memory on the small monitor host; process one image at a time.
sharp.cache(false);
sharp.concurrency(1);
const options = { limitInputPixels: 4_194_304, failOn: 'warning' };
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const ANIMATION_GRID = 4;
export const ANIMATION_FRAMES = ANIMATION_GRID ** 2;
export const ANIMATION_DELAY_MS = 125;
const MAX_ANIMATED_BYTES = 500_000;

function webpFrameDelays(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP'
      || buffer.readUInt32LE(4) !== buffer.length - 8) throw new Error('Invalid WebP container');
  const delays = [];
  let offset = 12;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error('Truncated WebP chunk');
    const size = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (end > buffer.length) throw new Error('Truncated WebP chunk');
    if (buffer.toString('ascii', offset, offset + 4) === 'ANMF') {
      if (size < 16) throw new Error('Invalid WebP frame');
      delays.push(buffer.readUIntLE(offset + 20, 3));
    }
    offset = end;
  }
  return delays;
}

export async function validateGeneratedSticker(buffer, { requireAnimated = false } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_ANIMATED_BYTES || buffer.length < 12) {
    throw new Error('Invalid sticker size');
  }
  const image = sharp(buffer, { ...options, animated: true });
  const meta = await image.metadata();
  const frames = meta.pages ?? 1, animated = frames > 1;
  if (meta.format !== 'webp' || meta.width !== 512 || (meta.pageHeight ?? meta.height) !== 512
      || frames > ANIMATION_FRAMES || (!animated && (requireAnimated || buffer.length > 100_000))) {
    throw new Error('Invalid sticker format');
  }
  // Decoders normalize very short delays; enforce the actual encoded timings.
  const delays = webpFrameDelays(buffer);
  const durationMs = animated ? delays.reduce((sum, delay) => sum + delay, 0) : 0;
  if (animated && (meta.loop !== 0 || delays.length !== frames
      || delays.some((delay) => delay < 8)
      || !Number.isFinite(durationMs) || durationMs > 10_000)) throw new Error('Invalid sticker timing');
  // Decode rather than trusting headers; opaque square artwork is valid too.
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const frameBytes = 512 * 512 * info.channels;
  for (let frame = 0; frame < frames; frame++) {
    let visible = false;
    for (let i = frame * frameBytes + info.channels - 1; i < (frame + 1) * frameBytes; i += info.channels) {
      if (data[i] > 0) { visible = true; break; }
    }
    if (!visible) throw new Error('Sticker must have visible artwork in every frame');
  }
  return { width: 512, height: 512, bytes: buffer.length, animated, frames, durationMs,
    sha256: createHash('sha256').update(buffer).digest('hex') };
}

// One generated sheet supplies a complete loop without sixteen paid requests.
// Decode once, then extract sequentially to keep native memory bounded.
export async function makeAnimatedSticker(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_IMAGE_BYTES) {
    throw new Error('Invalid generated image size');
  }
  const source = sharp(buffer, options);
  const meta = await source.metadata();
  if (!['png', 'webp'].includes(meta.format) || (meta.pages ?? 1) !== 1
      || meta.width !== 1024 || meta.height !== 1024) throw new Error('Expected a 1024px animation sheet');
  const sheet = await source.ensureAlpha().raw().toBuffer();
  const frameBytes = 512 * 512 * 4;
  const frames = Buffer.alloc(frameBytes * ANIMATION_FRAMES);
  const cell = 1024 / ANIMATION_GRID;
  for (let index = 0; index < ANIMATION_FRAMES; index++) {
    const frame = await sharp(sheet, { raw: { width: 1024, height: 1024, channels: 4 } })
      .extract({ left: (index % ANIMATION_GRID) * cell, top: Math.floor(index / ANIMATION_GRID) * cell,
        width: cell, height: cell }).resize(512, 512).raw().toBuffer();
    frame.copy(frames, index * frameBytes);
  }
  for (const quality of [80, 65, 50, 35, 20]) {
    const sticker = await sharp(frames, { raw: { width: 512, height: 512 * ANIMATION_FRAMES,
      channels: 4, pageHeight: 512 } }).webp({ quality, alphaQuality: 100, effort: 4,
      loop: 0, delay: Array(ANIMATION_FRAMES).fill(ANIMATION_DELAY_MS) }).toBuffer();
    if (sticker.length <= MAX_ANIMATED_BYTES) {
      await validateGeneratedSticker(sticker, { requireAnimated: true });
      return sticker;
    }
  }
  throw new Error('Animated sticker cannot fit the size limit');
}

export async function makeGeneratedSticker(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_IMAGE_BYTES) {
    throw new Error('Invalid generated image size');
  }
  const source = sharp(buffer, options);
  const meta = await source.metadata();
  if (!['png', 'webp'].includes(meta.format) || (meta.pages ?? 1) !== 1) {
    throw new Error('Expected a static generated image');
  }
  if (meta.hasAlpha && (await source.stats()).channels.at(-1).max === 0) {
    throw new Error('Generated image lacks visible artwork');
  }
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
