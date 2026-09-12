import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { COLLECTIONS } from '../src/collections.js';
import { buildStatusSvgs, renderStatusImages, parseStatusDays, DAY_MS, MEDALLION_COLOR } from '../src/status-images.js';
import { Store } from '../src/store.js';

const now = Date.parse('2026-09-11T12:00:00Z');
const sample = (at = now, rate = 100) => ({ observedAt: at,
  lamports: { ...Object.fromEntries(COLLECTIONS.map(({ id }) => [id, 1e9])), medallion: 3e9 },
  fx: rate == null ? null : { rates: { USD: rate }, updatedAt: at }, fxFailed: rate == null });

test('status ranges default to 30 days and bound retained history', () => {
  for (const [input, expected] of [['', 30], ['7d', 7], ['2w', 14], ['3M', 90], ['365d', 365], ['0d', null], ['366d', null], ['all', null]]) assert.equal(parseStatusDays(input), expected);
});
test('four deterministic album PNGs contain all four panels with purple Medallion values', async () => {
  const s = sample();
  const images = await renderStatusImages(s, [], { now });
  assert.equal(images.length, 4);
  for (const buffer of images) {
    const meta = await sharp(buffer).metadata();
    assert.equal(meta.format, 'png'); assert.equal(meta.width, 1200);
    assert.equal(meta.height, 940);
  }
  assert.deepEqual(images, await renderStatusImages(s, [], { now }));
  const svgs = buildStatusSvgs(s, [], { now });
  assert.match(svgs[0], /300.00 USD/); assert.match(svgs[0], /3.00 SOL/);
  assert.match(svgs[1], /Only one observation/);
  for (const panel of svgs.slice(1, 3)) {
    assert.match(panel, new RegExp(`fill="${MEDALLION_COLOR}"[^>]*>Medallion</text>`));
    assert.match(panel, new RegExp(`stroke="${MEDALLION_COLOR}" stroke-width="3"`));
  }
  const missing = buildStatusSvgs(sample(now, null), [], { now });
  assert.match(missing[0], /Unavailable/); assert.match(missing[2], /3.00 SOL/);
  assert.match(missing[3], /USD history unavailable/);
});
test('historical conversions use contemporaneous FX and exclude out-of-range data', () => {
  const s = sample();
  const older = sample(now - 3600_000, 200);
  const svg = buildStatusSvgs(s, [sample(now - 40 * DAY_MS, 10000), older], { now })[1];
  // Maximum historical medallion USD is 600, with 10% headroom.
  assert.match(svg, />660<\/text>/);
  const stale = { ...older, fx: { rates: { USD: 200 }, updatedAt: older.observedAt - 600_000 } };
  assert.doesNotMatch(buildStatusSvgs(s, [stale], { now })[1], />660<\/text>/);
});
test('history queries respect both bounds and sort chronologically', () => {
  const store = new Store(':memory:');
  try {
    for (const offset of [-1, -3, -2, 1]) store.observation(sample(now + offset * DAY_MS));
    assert.deepEqual(store.observationsSince(now - 2 * DAY_MS, now).map((s) => s.observedAt), [now - 2 * DAY_MS, now - DAY_MS]);
  } finally { store.close(); }
});
