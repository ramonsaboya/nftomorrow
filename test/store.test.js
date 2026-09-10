import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { sqliteAuth } from '../src/auth.js';
import { acquireLock } from '../src/lock.js';

test('state and Buffer/Signal keys survive restart; batches roll back on failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nftomorrow-test-'));
  const path = join(dir, 'state.sqlite');
  let store;
  try {
    store = new Store(path);
    const auth = sqliteAuth(store);
    const identity = Buffer.from(auth.state.creds.signedIdentityKey.private);
    await auth.state.keys.set({ session: { alice: Buffer.from([0, 1, 255]) },
      'app-state-sync-key': { first: { keyData: Buffer.from([5, 6]) } } });
    store.set('example', { saved: true });
    store.saveSticker('original', '123@g.us', { source: { prompt: 'A DJ', images: ['cGhvdG8='] },
      sticker: Buffer.from([1, 2, 3]) });
    store.saveSticker('edited', '123@g.us', { sourceId: 'original', edits: ['Red hat'], sticker: Buffer.from([4, 5]) });
    const circular = {}; circular.self = circular;
    await assert.rejects(auth.state.keys.set({ session: { alice: Buffer.from([9]), bob: circular } }));
    assert.deepEqual((await auth.state.keys.get('session', ['alice'])).alice, Buffer.from([0, 1, 255]));
    store.close();
    store = new Store(path);
    const restored = sqliteAuth(store);
    assert.deepEqual(restored.state.creds.signedIdentityKey.private, identity);
    assert.equal(store.get('example').saved, true);
    assert.deepEqual(store.stickerContext('edited', '123@g.us'), {
      sourceId: 'original', source: { prompt: 'A DJ', images: ['cGhvdG8='] },
      edits: ['Red hat'], sticker: Buffer.from([4, 5]),
    });
    assert.equal(store.stickerContext('edited', '999@g.us'), null);
    assert.deepEqual((await restored.state.keys.get('app-state-sync-key', ['first'])).first.keyData, Buffer.from([5, 6]));
    await restored.state.keys.set({ session: { alice: null } });
    assert.deepEqual(await restored.state.keys.get('session', ['alice']), {});
    // Windows uses ACLs and does not implement POSIX owner-only mode bits.
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('delivery attempts become uncertain after crash and audit survives', () => {
  const store = new Store(':memory:');
  store.reserve('unique', { text: 'test' }, 1);
  assert.throws(() => store.reserve('unique', {}, 2));
  assert.equal(store.recoverAttempts(3), 1);
  assert.equal(store.deliveries()[0].status, 'uncertain');
  store.close();
});
test('single process lock excludes concurrent instance and releases cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nftomorrow-lock-'));
  try {
    const path = join(dir, 'lock.sqlite');
    const release = acquireLock(path);
    assert.throws(() => acquireLock(path), /Another/);
    release();
    acquireLock(path)();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
