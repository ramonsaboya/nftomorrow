import sharp from 'sharp';
import { COLLECTIONS } from './collections.js';
import { priceIn, validateSnapshot } from './prices.js';

export const DAY_MS = 86_400_000;
export function parseStatusDays(input = '') {
  if (!input.trim()) return 30;
  const match = /^(\d{1,3})(d|w|m)$/i.exec(input.trim());
  const days = match ? Number(match[1]) * ({ d: 1, w: 7, m: 30 }[match[2].toLowerCase()]) : NaN;
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : null;
}
export const MEDALLION_COLOR = '#b3a1ff';
const colors = { medallion: MEDALLION_COLOR, tomorrowland_winter: '#75e3c0',
  the_reflection_of_love: '#ffcc73', tomorrowland_love_unity: '#7bbcff', sol: '#75e3c0' };
const targets = [{ id: 'medallion', name: 'Medallion' }, ...COLLECTIONS];
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const text = (x, y, value, size = 24, color = '#eef2fb') => `<text x="${x}" y="${y}" fill="${color}" font-size="${size}">${escape(value)}</text>`;
const date = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: 'short', year: 'numeric' }).format(ms);
const value = (n, unit) => n == null ? 'Unavailable' : `${new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${unit}`;
const svg = (height, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" font-family="DejaVu Sans, Arial, sans-serif"><rect width="1200" height="${height}" fill="#101827"/>${body}</svg>`;
const usdRate = (s, now = s.observedAt) => {
  const usd = priceIn(s, 'medallion', 'USD', now);
  return usd == null ? null : s.fx.rates.USD;
};

// Historical USD values use the exchange rate recorded at that observation.
// Missing rates and gaps over three hours break lines rather than invent prices.
export function buildStatusSvgs(snapshot, history, { days = 30, now = Date.now() } = {}) {
  validateSnapshot(snapshot, now);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Invalid status range');
  const end = snapshot.observedAt, start = end - days * DAY_MS;
  const samples = [...history, snapshot].filter((s) => {
    try { validateSnapshot(s, s.observedAt); return s.observedAt >= start && s.observedAt <= end; } catch { return false; }
  });
  const rows = [...new Map(samples.map((s) => [s.observedAt, s])).values()].sort((a, b) => a.observedAt - b.observedAt);
  const checked = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' }).format(end);
  const foot = `Checked ${checked} (London) • Collection floors • Excludes fees`;
  const summary = svg(940, text(60, 70, 'TOMORROWLAND • MEDALLION', 32, MEDALLION_COLOR)
    + text(60, 108, `${date(start)} – ${date(end)} • ${days} days`, 23, '#a8b5cb')
    + [['Medallion USD cost', value(priceIn(snapshot, 'medallion', 'USD', now), 'USD')],
      ['Medallion SOL cost', value(priceIn(snapshot, 'medallion', 'SOL', now), 'SOL')],
      ['SOL / USD conversion', `1 SOL = ${value(priceIn(snapshot, 'medallion', 'USD', now) == null ? null : snapshot.fx.rates.USD, 'USD')}`]]
      .map(([label, amount], i) => text(60, 220 + i * 215, label, 29, i < 2 ? MEDALLION_COLOR : '#a8b5cb')
        + text(60, 295 + i * 215, amount, 54, i < 2 ? MEDALLION_COLOR : colors.sol)).join('')
    + text(60, 907, foot, 19, '#a8b5cb'));
  const charts = [['NFT floors in USD', 'USD', targets], ['NFT floors in SOL', 'SOL', targets], ['SOL price in USD', 'USD', [{ id: 'sol', name: '1 SOL' }]]].map(([title, unit, series]) => {
    const get = (s, id) => id === 'sol' ? usdRate(s) : priceIn(s, id, unit, s.observedAt);
    const values = rows.flatMap((s) => series.map(({ id }) => get(s, id))).filter((v) => v != null);
    const max = Math.max(1, ...values) * 1.1;
    const x = (t) => 145 + (t - start) / (end - start) * 990;
    const y = (v) => 480 - v / max * 310;
    let body = text(60, 65, title, 36) + text(60, 108, `${date(start)} – ${date(end)} • ${days} days`, 23, '#a8b5cb');
    for (let i = 0; i <= 4; i++) {
      const v = max * i / 4;
      body += `<path d="M145 ${y(v)} H1135" stroke="#2a374c"/>` + text(20, y(v) + 7, new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1, notation: 'compact' }).format(v), 21, '#a8b5cb');
      body += text(145 + i * 247.5, 520, date(start + i / 4 * (end - start)), 18, '#a8b5cb')
        .replace('<text ', `<text text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}" `);
    }
    series.forEach(({ id, name }, index) => {
      const color = colors[id];
      let path = '', previous = null;
      for (const s of rows) {
        const v = get(s, id);
        if (v == null) { previous = null; continue; }
        path += `${previous != null && s.observedAt - previous <= 3 * 3600_000 ? 'L' : 'M'}${x(s.observedAt).toFixed(2)},${y(v).toFixed(2)} `;
        body += `<circle cx="${x(s.observedAt)}" cy="${y(v)}" r="2.5" fill="${color}"/>`;
        previous = s.observedAt;
      }
      body += `<path d="${path}" fill="none" stroke="${color}" stroke-width="3"/>`;
      const current = id === 'sol' ? usdRate(snapshot, now) : priceIn(snapshot, id, unit, now);
      body += text(60, 625 + index * 54, name, 25, color) + text(820, 625 + index * 54, value(current, unit), 27, color);
    });
    body += text(60, 568, 'CURRENT VALUES', 19, '#a8b5cb');
    body += text(60, 865, values.length ? `Recorded history from ${date(rows[0].observedAt)} • Gaps indicate missing observations or rates` : 'USD history unavailable • Waiting for recorded exchange rates', 20, '#a8b5cb');
    if (rows.length === 1) body += text(280, 275, 'Only one observation available; history builds over time.', 23);
    body += text(60, 907, foot, 19, '#a8b5cb');
    return svg(940, body);
  });
  return [summary, ...charts];
}

export async function renderStatusImages(snapshot, history, options) {
  return Promise.all(buildStatusSvgs(snapshot, history, options).map((source) => sharp(Buffer.from(source)).png().toBuffer()));
}
