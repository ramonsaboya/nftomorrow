import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderStatusImages, parseStatusDays } from '../src/status-images.js';

// JSON input: { snapshot, history: [...] }. No network or image-generation API.
const [input, output = 'data/status-preview', range = '30d'] = process.argv.slice(2);
if (!input || parseStatusDays(range) == null) throw new Error('Usage: node scripts/render-status.js input.json [output-directory] [30d]');
const { snapshot, history = [] } = JSON.parse(await readFile(input, 'utf8'));
const images = await renderStatusImages(snapshot, history, { days: parseStatusDays(range), now: snapshot.observedAt });
await mkdir(output, { recursive: true });
for (const [index, name] of ['summary', 'nft-usd', 'nft-sol', 'sol-usd'].entries()) {
  const path = resolve(output, name + '.png');
  await writeFile(path, images[index]);
  console.log(path);
}
