import { randomBytes } from 'node:crypto';

export const RESET_INTERVAL = 300_000;
const WEEK = 7 * 86_400_000;
const SOURCES = [
  ['recent', 'https://twiscan.com/en/x/thsottiaux'],
  ['status', 'https://codex-resets.com/api/v1/status'],
  ['history', 'https://codex-resets.com/api/v1/resets?limit=100'],
];

export function resetOwner(config) {
  const phones = [...new Set((config.stickerOwnerJids ?? []).filter(jid => /^\d+@s\.whatsapp\.net$/.test(jid)))];
  if (phones.length !== 1) throw new Error('Reset alerts require exactly one sticker-owner phone account');
  return phones[0];
}

export function resetRelated(text) {
  return typeof text === 'string' && (/\b(?:reset\w*|banked|replenish\w*|milestone|celebrat\w*)\b|\b(?:usage|rate)[ -]+limits?\b|\b(?:fresh|new|brand new)\s+usage\b|\b(?:press\w*.*button|button.*press\w*)\b|\b(?:landed|propagated|refill\w*)\b|100%/i.test(text)
    // The owner prefers false positives to missed hints and terse follow-ups.
    || (text.length <= 160 && /\b(?:yes|done|deliver|forgot|tomorrow|today|soon|meant|landing)\b/i.test(text)));
}

function post(id, text) {
  if (!/^\d{18,20}$/.test(id) || typeof text !== 'string' || !text.trim()) throw new Error('Invalid source post');
  const publishedAt = Number((BigInt(id) >> 22n) + 1288834974657n);
  if (!Number.isSafeInteger(publishedAt)) throw new Error('Invalid post time');
  return { id, text: text.trim(), publishedAt, url: `https://x.com/thsottiaux/status/${id}` };
}

// Decode text only. Links in upstream bodies are never used as destinations.
function plainText(html) {
  return html.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, value) => {
      const n = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[entity]);
}

export function parseRecent(html) {
  if (typeof html !== 'string') throw new Error('Invalid recent feed');
  const posts = [];
  // Bound the markup between the author's permalink and their text block.
  // A changed page or challenge must fail visibly, not establish an empty baseline.
  const pattern = /<a href="https:\/\/twiscan\.com\/en\/x\/thsottiaux\/(\d{18,20})">[^<]*<\/a>[\s\S]{0,250}?<!-- text -->\s*<div[^>]*>([\s\S]*?)<\/div>\s*<!-- media -->/g;
  for (const match of html.matchAll(pattern)) posts.push(post(match[1], plainText(match[2])));
  if (!posts.length) throw new Error('Recent feed layout unavailable');
  return posts;
}

export function parseTracker(body, kind) {
  let rows;
  if (kind === 'history') {
    if (!Array.isArray(body?.data)) throw new Error('Invalid reset history');
    rows = body.data;
  } else {
    if (!body?.data || !Object.hasOwn(body.data, 'latest_reset')
        || !Object.hasOwn(body.data, 'scheduled_reset') || !Object.hasOwn(body.data, 'active_watch')) {
      throw new Error('Invalid reset status');
    }
    rows = [body.data.latest_reset, body.data.scheduled_reset, body.data.active_watch].filter(Boolean);
  }
  return rows.flatMap(row => {
    // Tracker observation IDs and timestamps can differ from the actual post.
    const match = /^https:\/\/(?:x|twitter)\.com\/thsottiaux\/status\/(\d{18,20})(?:\?[^#]*)?$/.exec(row?.source?.url ?? '');
    if (!match || (row.source.author && row.source.author !== 'thsottiaux')) return [];
    return [post(match[1], row.text)];
  });
}

export async function fetchResetPosts({ fetchImpl = fetch, store, now = Date.now, log = () => {}, signal } = {}) {
  const results = await Promise.allSettled(SOURCES.map(async ([name, url]) => {
    const stateKey = `resetSource:${name}`;
    const previous = store.get(stateKey, {});
    if (previous.retryAt > now()) throw new Error('Source backoff');
    try {
      const response = await fetchImpl(url, { redirect: 'error',
        headers: { accept: name === 'recent' ? 'text/html' : 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
      if (!response.ok) {
        const retry = response.headers?.get('retry-after');
        const retryMs = retry == null ? 0 : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now();
        store.set(stateKey, { ...previous, ok: false, checkedAt: now(), retryAt: now() + Math.max(RESET_INTERVAL, Number.isFinite(retryMs) ? retryMs : 0) });
        throw new Error('Feed unavailable');
      }
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error('Feed too large');
      const posts = name === 'recent' ? parseRecent(text) : parseTracker(JSON.parse(text), name);
      store.set(stateKey, { ok: true, checkedAt: now(), lastSuccessAt: now(), posts: posts.length });
      log('reset_source_ok', { source: name, posts: posts.length });
      return posts;
    } catch (error) {
      store.set(stateKey, { ...store.get(stateKey, previous), ok: false, checkedAt: now() });
      log('reset_source_failed', { source: name });
      throw error;
    }
  }));
  if (results.every(result => result.status === 'rejected')) throw new Error('All reset sources failed');
  return results.filter(result => result.status === 'fulfilled').flatMap(result => result.value);
}

export function formatResetPost(item) {
  const text = item.text.replace(/https?:\/\/\S+/g, '').trim();
  // Keep alerts brief and point to the full original post.
  const resetStart = text.search(/\b(?:reset\w*|banked|replenish\w*)\b/i);
  const sentenceStart = resetStart > 0 ? Math.max(text.lastIndexOf('\n', resetStart), text.lastIndexOf('. ', resetStart)) + 1 : 0;
  const relevant = text.slice(sentenceStart).replace(/\s+/g, ' ').trim();
  const words = relevant.split(' ');
  const excerpt = words.slice(0, 25).join(' ') + (words.length > 25 ? '…' : '');
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(item.publishedAt);
  return `Tibo posted about resets\n\n${excerpt}\n\n${date}\n${item.url}`;
}

export class ResetWatch {
  constructor({ config, store, whatsapp, now = Date.now, fetchPosts = fetchResetPosts, log = () => {}, signal }) {
    Object.assign(this, { store, whatsapp, now, fetchPosts, log, signal });
    this.recipient = resetOwner(config);
    if (!store.get('resetWatch')) store.set('resetWatch', { startedAt: now(), nextCheckAt: 0, pending: [] });
  }
  due() { return this.now() >= this.store.get('resetWatch').nextCheckAt; }
  async poll() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.check();
    try { return await this.inFlight; } finally { this.inFlight = null; }
  }
  async check() {
    const state = this.store.get('resetWatch');
    state.nextCheckAt = this.now() + RESET_INTERVAL;
    this.store.set('resetWatch', state);
    try {
      const posts = await this.fetchPosts({ store: this.store, now: this.now, log: this.log, signal: this.signal });
      const queued = new Set(state.pending.map(item => item.id));
      for (const item of posts) {
        if (item.publishedAt < state.startedAt || item.publishedAt < this.now() - WEEK
            || item.publishedAt > this.now() + 60_000 || !resetRelated(item.text)
            || this.store.get(`resetPost:${item.id}`) || queued.has(item.id)) continue;
        queued.add(item.id);
        state.pending.push(item);
      }
      state.lastSuccessAt = this.now();
      this.log('reset_check_complete', { posts: posts.length, pending: state.pending.length });
    } catch { this.log('reset_check_failed'); }
    state.pending = state.pending.filter(item => item.publishedAt >= this.now() - WEEK);
    this.store.set('resetWatch', state);
    for (const item of [...state.pending]) {
      if (this.signal?.aborted || !this.whatsapp.connected) break;
      const id = `3EB0${randomBytes(14).toString('hex').toUpperCase()}`;
      const text = formatResetPost(item);
      this.store.transaction(() => {
        this.store.reserve(id, { kind: 'reset-post', postId: item.id, recipient: this.recipient, url: item.url }, this.now());
        this.store.set(`resetPost:${item.id}`, { attemptedAt: this.now(), deliveryId: id });
        state.pending = state.pending.filter(pending => pending.id !== item.id);
        this.store.set('resetWatch', state);
      });
      try {
        await this.whatsapp.sendResetAlert(id, text, this.recipient);
        this.store.finish(id, 'acknowledged', this.now());
        this.log('reset_message_acknowledged', { postId: item.id });
      } catch {
        this.store.finish(id, 'uncertain', this.now());
        this.store.set('deliveryUncertain', true);
        this.log('reset_delivery_uncertain', { postId: item.id });
      }
    }
  }
}
