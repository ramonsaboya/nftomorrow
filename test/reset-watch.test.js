import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { validateConfig } from '../src/config.js';
import { ResetWatch, RESET_INTERVAL, resetOwner, resetRelated, parseTracker, parseRecent, fetchResetPosts, formatResetPost } from '../src/reset-watch.js';

const owner = '123@s.whatsapp.net';
const config = { stickerOwnerJids: [owner, '456@lid'] };
const idAt = time => ((BigInt(time) - 1288834974657n) << 22n).toString();
const itemAt = (at, text = 'Maybe another reset tomorrow?') => ({ id: idAt(at), publishedAt: at, text, url: `https://x.com/thsottiaux/status/${idAt(at)}` });

test('owner selection uses one allowlisted phone, never the group or a duplicate LID destination', () => {
  assert.equal(resetOwner(config), owner);
  assert.throws(() => resetOwner({ stickerOwnerJids: [] }));
  assert.throws(() => resetOwner({ stickerOwnerJids: ['456@lid'] }));
  assert.throws(() => resetOwner({ stickerOwnerJids: [owner, '789@s.whatsapp.net'] }));
  validateConfig({ ...config, thresholds: [], resetAlerts: true });
  assert.throws(() => validateConfig({ thresholds: [], resetAlerts: true }));
  assert.throws(() => validateConfig({ thresholds: [], resetAlerts: 'yes' }));
});

test('broad matching includes hints, negations, policy and spelling errors without declaring completion', () => {
  for (const text of ['No reset today', 'Reseting your limits', 'Banked credits', 'Rate limits are confusing',
    'fresh usage for you', 'Button was pressed', 'Reset has propagated', 'Who says it will not reset?']) assert.ok(resetRelated(text), text);
  assert.equal(resetRelated('A new image model ships'), false);
  assert.equal(resetRelated('Yes'), true);
  assert.equal(resetRelated('Little surprise for you tomorrow.'), true);
  const text = formatResetPost(itemAt(Date.parse('2026-09-12T08:09:00Z'), 'No reset today https://evil.example/'));
  assert.match(text, /Tibo posted about resets/);
  assert.match(text, /No reset today/);
  assert.match(text, /09:09 BST/);
  assert.doesNotMatch(text, /evil.example|reset confirmed/i);
});

test('tracker extracts future/watch posts and uses original URL IDs rather than observation IDs', () => {
  const item = itemAt(Date.parse('2026-09-12T08:09:00Z'));
  const row = { id: 'observed-other', text: item.text, source: { url: item.url, author: 'thsottiaux' } };
  assert.deepEqual(parseTracker({ data: { latest_reset: row, scheduled_reset: row, active_watch: row } }, 'status'), [item, item, item]);
  assert.deepEqual(parseTracker({ data: [{ ...row, source: { url: 'https://x.com/imposter/status/' + item.id } }] }, 'history'), []);
  assert.throws(() => parseTracker({ data: {} }, 'history'));
  assert.throws(() => parseTracker({ data: {} }, 'status'));
});

test('recent page extracts author text and fails visibly on changed layout', () => {
  const id = '2098685367058612394';
  const html = `<a href="https://twiscan.com/en/x/thsottiaux/${id}">2026.09.12</a></div></div></div>
<!-- text --> <div class="whitespace-pre-wrap">Reset &amp; banked<br>news &#x1F389;</div> <!-- media -->`;
  const posts = parseRecent(html);
  assert.equal(posts[0].id, id);
  assert.equal(posts[0].text, 'Reset & banked\nnews 🎉');
  assert.throws(() => parseRecent('<html>Sign in</html>'));
  assert.throws(() => parseRecent(html.replace('/thsottiaux/', '/imposter/')));
});

function harness() {
  const store = new Store(':memory:');
  let now = Date.parse('2026-09-13T00:00:00Z'), posts = [], fail = false, failSend = false;
  const sends = [];
  const whatsapp = { connected: true, async sendResetAlert(id, text, recipient) {
    assert.equal(store.deliveries().at(-1).status, 'attempting');
    sends.push({ id, text, recipient });
    if (failSend) throw new Error('Unknown acknowledgement');
  } };
  const args = { config, store, whatsapp, now: () => now,
    fetchPosts: async () => { if (fail) throw new Error('Offline'); return posts; } };
  return { store, sends, whatsapp, args, watch: new ResetWatch(args), now: () => now,
    advance: (ms = RESET_INTERVAL) => { now += ms; }, posts: value => { posts = value; },
    fail: value => { fail = value; }, failSend: () => { failSend = true; } };
}

test('baseline skips old posts; new duplicates and restart produce just one owner alert; follows five-minute interval', async () => {
  const h = harness();
  try {
    h.posts([itemAt(h.now() - 1000)]);
    await h.watch.poll();
    assert.equal(h.sends.length, 0);
    assert.equal(h.watch.due(), false);
    h.advance(); assert.equal(h.watch.due(), true);
    const item = itemAt(h.now());
    h.posts([item, item, itemAt(h.now() - 1, 'Nice new images')]);
    await h.watch.poll();
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0].recipient, owner);
    assert.equal(h.store.deliveries()[0].status, 'acknowledged');
    await new ResetWatch(h.args).poll();
    assert.equal(h.sends.length, 1);
    h.advance(); h.posts([itemAt(h.now(), 'Not happening today; reset soon')]);
    await h.watch.poll(); assert.equal(h.sends.length, 2);
  } finally { h.store.close(); }
});

test('disconnected alerts persist, can send during source outage, and uncertain sends never replay', async () => {
  const h = harness();
  try {
    h.advance(); h.posts([itemAt(h.now())]); h.whatsapp.connected = false;
    await h.watch.poll(); assert.equal(h.sends.length, 0);
    assert.equal(h.store.get('resetWatch').pending.length, 1);
    h.fail(true); h.whatsapp.connected = true; h.failSend();
    await new ResetWatch(h.args).poll();
    assert.equal(h.sends.length, 1);
    assert.equal(h.store.deliveries()[0].status, 'uncertain');
    h.fail(false); await new ResetWatch(h.args).poll();
    assert.equal(h.sends.length, 1);
  } finally { h.store.close(); }
});

test('initial source failures preserve activation cutoff and overlapping polls share one fetch', async () => {
  const h = harness();
  try {
    h.fail(true); await h.watch.poll();
    h.advance(); h.fail(false); h.posts([itemAt(h.now()), itemAt(h.now() - 2 * RESET_INTERVAL)]);
    await Promise.all([h.watch.poll(), h.watch.poll()]);
    assert.equal(h.sends.length, 1);
  } finally { h.store.close(); }
});

test('source failure isolation and Retry-After preserve a working tracker feed', async () => {
  const store = new Store(':memory:');
  const now = Date.parse('2026-09-13T00:00:00Z');
  const item = itemAt(now), calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('twiscan')) return new Response('Unavailable', { status: 429, headers: { 'retry-after': '900' } });
    if (url.includes('/status')) throw new Error('Timeout');
    return new Response(JSON.stringify({ data: [{ text: item.text, source: { url: item.url } }] }));
  };
  try {
    assert.deepEqual(await fetchResetPosts({ store, fetchImpl, now: () => now }), [item]);
    assert.equal(store.get('resetSource:recent').retryAt, now + 900_000);
    assert.equal(store.get('resetSource:history').ok, true);
    await fetchResetPosts({ store, fetchImpl, now: () => now + RESET_INTERVAL });
    assert.equal(calls.filter(url => url.includes('twiscan')).length, 1);
  } finally { store.close(); }
});
