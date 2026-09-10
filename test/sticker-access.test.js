import test from 'node:test';
import assert from 'node:assert/strict';
import { isStickerOwner } from '../src/sticker-access.js';
import { validateConfig } from '../src/config.js';
import { StickerCommand } from '../src/sticker-command.js';
import { ImageStickerCommand } from '../src/image-sticker-command.js';

const owner = '447700900111@s.whatsapp.net';
const lid = '1234567890@lid';
const msg = (key) => ({ key: { id: 'request', ...key } });

test('owner identity works in groups and DMs using PN, LID and protocol alternate IDs', () => {
  for (const key of [
    { remoteJid: owner },
    { remoteJid: '447700900111:3@s.whatsapp.net' },
    { remoteJid: lid, remoteJidAlt: owner },
    { remoteJid: '123@g.us', participant: owner },
    { remoteJid: '999@g.us', participant: lid, participantAlt: owner },
  ]) assert.equal(isStickerOwner(msg(key), [owner]), true);
  assert.equal(isStickerOwner(msg({ remoteJid: lid }), [owner, lid]), true);
});

test('missing identities and impersonation through names, mentions or quotes fail closed', () => {
  for (const key of [
    { remoteJid: '123@g.us' },
    { remoteJid: '123@g.us', participantAlt: owner },
    { remoteJid: '123@g.us', participant: '222@s.whatsapp.net', remoteJidAlt: owner },
    { remoteJid: '222@s.whatsapp.net', participant: owner },
    { remoteJid: '222@s.whatsapp.net', remoteJidAlt: owner },
    { remoteJid: 'status@broadcast', remoteJidAlt: owner },
    { remoteJid: owner, fromMe: true },
  ]) {
    const message = { ...msg(key), pushName: '@ramonsaboya',
      message: { extendedTextMessage: { text: '/sticker dragon',
        contextInfo: { participant: owner, mentionedJid: [owner] } } } };
    assert.equal(isStickerOwner(message, [owner]), false);
  }
  for (const list of [undefined, [], ['@ramonsaboya'], [null]]) {
    assert.equal(isStickerOwner(msg({ remoteJid: owner }), list), false);
  }
});

test('all sticker modes reject other senders before state, cooldown, replies or paid work', async () => {
  for (const mode of ['test', 'freeform', 'reference']) {
    const config = { groupId: '123@g.us', stickerOwnerJids: [owner] };
    const unexpected = () => assert.fail('unauthorized request had side effects');
    const dependencies = { config, store: { get: unexpected, set: unexpected },
      whatsapp: { connected: true, generation: 1, replyText: unexpected,
        sendSticker: unexpected, sendGeneratedSticker: unexpected },
      generate: unexpected, getSticker: unexpected };
    const command = mode === 'test' ? new StickerCommand(dependencies) : new ImageStickerCommand(dependencies);
    for (const key of [{ remoteJid: '222@s.whatsapp.net' },
      { remoteJid: '123@g.us', participant: '222@s.whatsapp.net' }]) {
      assert.equal(command.request('request', msg(key), 'dragon', mode), false);
      await command.runPending();
      assert.equal(command.pending, undefined);
    }
    delete config.stickerOwnerJids;
    assert.equal(command.request('request', msg({ remoteJid: owner }), 'dragon', mode), false);
  }
});

test('owner configuration accepts account IDs and rejects names or group IDs', () => {
  const config = { thresholds: [], stickerOwnerJids: [owner, lid] };
  assert.equal(validateConfig(config), config);
  for (const stickerOwnerJids of ['@ramonsaboya', ['@ramonsaboya'], ['123@g.us'], [null]]) {
    assert.throws(() => validateConfig({ ...config, stickerOwnerJids }));
  }
});
