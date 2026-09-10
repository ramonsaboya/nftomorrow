import sharp from 'sharp';

// The Image API accepts at most 16 inputs, including the Eu Vou original.
export async function packStickerReferences(images, slots) {
  if (images.length <= slots) return images;
  const sheets = [];
  for (let i = 0; i < images.length; i += 2) {
    const tiles = [];
    for (let j = 0; j < 2 && i + j < images.length; j++) {
      const tile = await sharp(images[i + j], { limitInputPixels: 16_777_216, failOn: 'warning' })
        .resize(1024, 1024, { fit: 'contain', background: 'white' }).png().toBuffer();
      tiles.push({ input: tile, left: j * 1024, top: 40 });
      const label = Buffer.from(`<svg width="1024" height="40"><rect width="100%" height="100%" fill="white"/><text x="16" y="28" font-size="24" fill="black">Photo ${i + j + 1}</text></svg>`);
      tiles.push({ input: label, left: j * 1024, top: 0 });
    }
    sheets.push(await sharp({ create: { width: i + 1 < images.length ? 2048 : 1024,
      height: 1064, channels: 3, background: 'white' } }).composite(tiles).png().toBuffer());
  }
  return sheets;
}
