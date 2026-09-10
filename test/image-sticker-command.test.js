import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Store } from '../src/store.js';
import { ImageStickerCommand } from '../src/image-sticker-command.js';
import { WhatsApp } from '../src/whatsapp.js';
import { Monitor } from '../src/monitor.js';
import { COLLECTIONS } from '../src/collections.js';
import { ImageEditError } from '../src/image-edit.js';

const sticker = await readFile(new URL('../assets/stickers/sticker-test.webp', import.meta.url));
const incoming = (id = 'request', chat = '123@g.us') => ({ key: { id, remoteJid: chat, participant: '447700900111@s.whatsapp.net' },
  message: { conversation: '/sticker make him a DJ' } });

test('image inputs reach generation and failed downloads do not consume budget', async () => {
  const images = [Buffer.from('prepared image')];
  const h = harness({ loadImages: async () => images, generate: async (args) => {
    assert.equal(args.images, images);
    assert.equal(args.prompt, 'Make him a DJ');
    return { sticker, usage: {} };
  } });
  try {
    h.command.request('request', incoming(), 'Make him a DJ');
    await h.command.runPending();
    assert.equal(h.sends.length, 1);
    h.advance(60_000);
    h.command.loadImages = async () => { throw new Error('private download detail'); };
    h.command.request('failed', incoming('failed'), 'Make him a DJ');
    await h.command.runPending();
    assert.equal(h.store.get('image-sticker-budget').used, 1);
    assert.match(h.notices.at(-1).text, /could not read that photo/);
    assert.equal(h.acknowledgements.length, 1);
  } finally { h.store.close(); }
});

test('unauthorized senders cannot trigger photo downloads', async () => {
  let downloads = 0;
  const h = harness({ loadImages: async () => { downloads++; return []; } });
  try {
    const msg = incoming();
    msg.key.participant = '999@s.whatsapp.net';
    assert.equal(h.command.request('request', msg, 'Make him a DJ'), false);
    await h.command.runPending();
    assert.equal(downloads, 0);
  } finally { h.store.close(); }
});
function harness(overrides = {}) {
  const store = new Store(':memory:');
  const sends = [], notices = [], acknowledgements = [], logs = [];
  let now = Date.parse('2026-09-08T12:00:00Z'), calls = 0;
  const controller = new AbortController();
  const config = { groupId: '123@g.us', displayCurrency: 'USD', dailySummaryTime: '18:00',
    stickerOwnerJids: ['447700900111@s.whatsapp.net', '456@lid'],
    thresholds: [{ target: 'medallion', currency: 'USD', below: 6500 }] };
  const whatsapp = { connected: true, generation: 1,
    async sendGeneratedSticker(id, buffer, quote) {
      assert.equal(store.deliveries().find((d) => d.id === id).status, 'attempting');
      sends.push({ id, buffer, quote });
    },
    async replyText(id, text, quote) {
      const row = store.deliveries().find((d) => d.id === id);
      (row.data.kind === 'sticker-processing' ? acknowledgements : notices).push({ id, text, quote });
    },
    async send() {} };
  const dependencies = { store, config, whatsapp, apiKey: 'test', quality: 'medium', dailyLimit: 20,
    signal: controller.signal, now: () => now, health: { async ping() {} },
    log: (...args) => logs.push(args),
    generate: async (args) => {
      calls++;
      assert.equal(store.get('image-sticker-budget').used, calls);
      assert.equal(store.deliveries().at(-1).data.kind, 'sticker-generation');
      assert.equal(store.deliveries().at(-1).status, 'attempting');
      assert.equal(args.prompt, 'Make him a DJ');
      return { sticker, usage: { total_tokens: 50 } };
    }, ...overrides };
  return { store, config, whatsapp, dependencies, controller, sends, notices, acknowledgements, logs,
    command: new ImageStickerCommand(dependencies), calls: () => calls,
    advance: (ms) => { now += ms; } };
}

test('both image modes share one job slot and budget and return to an unregistered group', async () => {
  const modes = [];
  const h = harness({ generate: async ({ mode }) => { modes.push(mode); return { sticker, usage: {} }; } });
  try {
    for (const [index, mode] of ['reference', 'freeform'].entries()) {
      const message = incoming('mode-' + index, '999@g.us');
      assert.equal(h.command.request(message.key.id, message, 'Make him a DJ', mode), true);
      assert.equal(h.command.request('busy', incoming('busy', '888@g.us'), 'Dragon', 'freeform'), false);
      await h.command.runPending();
      assert.equal(h.sends.at(-1).quote.key.remoteJid, '999@g.us');
      h.advance(60_000);
    }
    assert.deepEqual(modes, ['reference', 'freeform']);
    assert.equal(h.store.get('image-sticker-budget').used, 2);
  } finally { h.store.close(); }
});

test('reference edits require a theme and explain their own command without billing', async () => {
  const h = harness();
  try {
    h.command.request('empty', incoming('empty'), '', 'reference');
    await h.command.runPending();
    assert.match(h.notices[0].text, /\/euvousticker.*overall theme or scene/);
    assert.equal(h.calls(), 0);
  } finally { h.store.close(); }
});

test('image prompts reserve paid work durably, then send a validated quoted sticker without storing prompt text', async () => {
  const h = harness();
  try {
    assert.equal(h.command.request('request', incoming(), 'Make him a DJ'), true);
    await h.command.runPending();
    assert.equal(h.calls(), 1); assert.equal(h.sends.length, 1);
    assert.deepEqual(h.sends[0].quote, incoming());
    const rows = h.store.deliveries();
    assert.equal(rows[0].data.kind, 'sticker-processing'); assert.equal(rows[0].status, 'acknowledged');
    assert.equal(rows[1].status, 'generated'); assert.equal(rows[2].status, 'acknowledged');
    assert.equal(rows[2].data.model, 'gpt-image-2.5-sunburst');
    assert.equal(rows[2].data.generationId, rows[1].id);
    assert.equal(h.acknowledgements.length, 1);
    assert.match(h.acknowledgements[0].text, /Dobby’s on it/);
    assert.deepEqual(h.acknowledgements[0].quote, incoming());
    assert.doesNotMatch(JSON.stringify(rows), /Make him a DJ|test-key/);
  } finally { h.store.close(); }
});

test('empty/oversized prompts and an absent API key get a reply without paid work', async () => {
  for (const [apiKey, prompt] of [['test', ''], ['test', 'x'.repeat(4001)], ['', 'Make him a DJ']]) {
    const h = harness({ apiKey });
    try {
      h.command.request('request', incoming(), prompt); await h.command.runPending();
      assert.equal(h.calls(), 0); assert.equal(h.notices.length, 1);
      assert.equal(h.store.get('image-sticker-budget'), null);
      assert.equal(h.sends.length, 0);
      assert.equal(h.acknowledgements.length, 0);
    } finally { h.store.close(); }
  }
});

test('uncertain acknowledgement is never resent and prevents a paid generation', async () => {
  const h = harness();
  try {
    let attempts = 0;
    h.whatsapp.replyText = async () => { attempts++; throw new Error('lost acknowledgement'); };
    h.command.request('request', incoming(), 'Make him a DJ');
    await h.command.runPending(); await h.command.runPending();
    assert.equal(attempts, 1); assert.equal(h.calls(), 0);
    assert.equal(h.store.get('image-sticker-budget'), null);
    assert.equal(h.store.deliveries().length, 1);
    assert.equal(h.store.deliveries()[0].status, 'uncertain');
    assert.equal(h.store.get('deliveryUncertain'), true);
  } finally { h.store.close(); }
});

test('disconnect or shutdown during acknowledgement prevents generation and its budget reservation', async () => {
  for (const reason of ['reconnect', 'shutdown']) {
    const h = harness();
    try {
      h.whatsapp.replyText = async () => {
        if (reason === 'reconnect') h.whatsapp.generation++;
        else h.controller.abort();
      };
      h.command.request('request', incoming(), 'Make him a DJ'); await h.command.runPending();
      assert.equal(h.calls(), 0); assert.equal(h.store.get('image-sticker-budget'), null);
    } finally { h.store.close(); }
  }
});

test('duplicate requests and a restart cannot repeat a paid call; chat cooldowns stay separate', async () => {
  const h = harness();
  try {
    h.command.request('request', incoming(), 'Make him a DJ'); await h.command.runPending();
    h.advance(301_000);
    const restarted = new ImageStickerCommand(h.dependencies);
    assert.equal(restarted.request('request', incoming(), 'Make him a DJ'), false);
    await restarted.runPending(); assert.equal(h.calls(), 1);
    assert.equal(restarted.request('dm', incoming('dm', '456@lid'), 'Make him a DJ'), true);
    await restarted.runPending(); assert.equal(h.calls(), 2);
    assert.equal(h.sends[1].quote.key.remoteJid, '456@lid');
    assert.deepEqual(h.acknowledgements.map((a) => a.quote.key.remoteJid), ['123@g.us', '456@lid']);
  } finally { h.store.close(); }
});

test('daily paid-attempt limit is shared across chats, persists across handlers and resets on the next UTC day', async () => {
  const h = harness({ dailyLimit: 1 });
  try {
    h.command.request('request', incoming(), 'Make him a DJ'); await h.command.runPending();
    const restarted = new ImageStickerCommand(h.dependencies);
    restarted.request('dm', incoming('dm', '456@lid'), 'Make him a DJ'); await restarted.runPending();
    assert.equal(h.calls(), 1); assert.match(h.notices[0].text, /daily AI sticker limit/);
    assert.equal(h.acknowledgements.length, 1);
    h.advance(86_400_000);
    restarted.generate = async () => ({ sticker, usage: {} });
    restarted.request('tomorrow', incoming('tomorrow'), 'Make him a DJ'); await restarted.runPending();
    assert.equal(h.store.get('image-sticker-budget').used, 1); assert.equal(h.sends.length, 2);
  } finally { h.store.close(); }
});

test('slow image generation bounds work while monitor polls continue independently', async () => {
  const h = harness();
  try {
    let complete, began;
    const started = new Promise((resolve) => { began = resolve; });
    h.command.generate = () => new Promise((resolve) => { complete = resolve; began(); });
    const monitor = new Monitor({ ...h.dependencies, async getSnapshot() {
      const now = h.dependencies.now();
      return { observedAt: now, lamports: { ...Object.fromEntries(COLLECTIONS.map(({ id }) => [id, 1e9])), medallion: 3e9 },
        fx: { rates: { USD: 100 }, updatedAt: now }, fxFailed: false };
    } });
    h.command.request('request', incoming(), 'Make him a DJ');
    const first = h.command.runPending();
    assert.equal(h.command.request('dm', incoming('dm', '456@lid'), 'Make him a DJ'), false);
    const second = h.command.runPending();
    await started;
    assert.equal(h.acknowledgements.length, 1);
    await monitor.poll();
    assert.equal(h.store.deliveries().at(-1).data.kind, 'alert');
    complete({ sticker, usage: {} }); await Promise.all([first, second]);
    assert.equal(h.sends.length, 1);
  } finally { h.store.close(); }
});

test('generation failure is charged against the cap, sanitized and never auto-retried', async () => {
  const h = harness();
  try {
    let attempts = 0;
    h.command.generate = async () => { attempts++; throw new Error('private key/prompt/provider details'); };
    h.command.request('request', incoming(), 'Make him a DJ'); await h.command.runPending();
    await h.command.runPending();
    assert.equal(attempts, 1); assert.equal(h.store.get('image-sticker-budget').used, 1);
    assert.equal(h.store.deliveries().find((d) => d.data.kind === 'sticker-generation').status, 'uncertain');
    assert.equal(h.notices.length, 1);
    assert.doesNotMatch(JSON.stringify([h.logs, h.notices]), /private key|provider details/);
  } finally { h.store.close(); }
});

test('failure references correlate safe diagnostic logs with useful billing notices', async () => {
  const h = harness({ generate: async () => { throw new ImageEditError('api_rejected', {
    status: 400, requestId: 'req_billing', apiCode: 'billing_hard_limit_reached', message: 'sk-private prompt',
  }); } });
  try {
    h.command.request('request', incoming(), 'Make him a DJ'); await h.command.runPending();
    const failure = h.logs.find(([event]) => event === 'sticker_generation_failed')[1];
    assert.equal(failure.status, 400); assert.equal(failure.apiCode, 'billing_hard_limit_reached');
    assert.equal(failure.requestId, 'req_billing'); assert.equal(failure.stage, 'image_generation');
    assert.equal(failure.generationId, h.store.deliveries().find((d) => d.data.kind === 'sticker-generation').id);
    assert.equal(failure.reference, failure.generationId.slice(-8));
    assert.match(h.notices[0].text, /billing or credit limit/);
    assert.ok(h.notices[0].text.endsWith(failure.reference));
    assert.doesNotMatch(JSON.stringify([h.logs, h.notices]), /sk-private|Make him a DJ/);
  } finally { h.store.close(); }
});

test('timeout, access and conversion failures produce distinct notices without encouraging prompt changes', async () => {
  for (const [error, expected] of [[new DOMException('secret', 'TimeoutError'), /took too long/],
    [new ImageEditError('api_rejected', { status: 403 }), /check the API key/],
    [new ImageEditError('conversion_failed', { status: 200 }), /could not turn it into a valid sticker/]]) {
    const h = harness({ generate: async () => { throw error; } });
    try {
      h.command.request('request', incoming(), 'Make him a DJ'); await h.command.runPending();
      assert.match(h.notices[0].text, expected);
      assert.doesNotMatch(h.notices[0].text, /different prompt|secret/);
    } finally { h.store.close(); }
  }
});

test('disconnect, reconnect, expiry and shutdown suppress late image replies', async () => {
  for (const reason of ['disconnect', 'reconnect', 'expiry', 'shutdown']) {
    const h = harness();
    try {
      h.command.generate = async () => {
        if (reason === 'disconnect') h.whatsapp.connected = false;
        if (reason === 'reconnect') h.whatsapp.generation++;
        if (reason === 'expiry') h.advance(420_001);
        if (reason === 'shutdown') h.controller.abort();
        return { sticker, usage: {} };
      };
      h.command.request('request', incoming(), 'Make him a DJ'); await h.command.runPending();
      assert.equal(h.sends.length, 0); assert.equal(h.notices.length, 0);
    } finally { h.store.close(); }
  }
});

test('uncertain sticker delivery does not regenerate or retry the send', async () => {
  const h = harness();
  try {
    let attempts = 0;
    h.whatsapp.sendGeneratedSticker = async () => { attempts++; throw new Error('lost acknowledgement'); };
    h.command.request('request', incoming(), 'Make him a DJ'); await h.command.runPending();
    await h.command.runPending();
    assert.equal(h.calls(), 1); assert.equal(attempts, 1);
    assert.equal(h.store.deliveries().at(-1).status, 'uncertain');
    assert.equal(h.store.get('deliveryUncertain'), true);
    assert.equal(h.notices.length, 0);
  } finally { h.store.close(); }
});

test('real command intake preserves prompts and replies to their group/DM while rejecting unrelated traffic', async () => {
  const store = new Store(':memory:'), socket = { ev: new EventEmitter(), end() {} };
  const now = Date.parse('2026-09-08T12:00:00Z'), commands = [], sends = [];
  const wa = new WhatsApp({ store, groupId: '123@g.us', now: () => now,
    onCommand: (...args) => commands.push(args), makeSocket: () => socket });
  socket.sendMessage = async (chat, content, options) => { sends.push({ chat, content, options }); return { key: { id: options.messageId } }; };
  try {
    wa.connect({ state: { creds: { me: { id: '999@s.whatsapp.net' } } }, saveCreds() {} });
    socket.ev.emit('connection.update', { connection: 'open' });
    const message = (id, chat, text) => ({ ...incoming(id, chat), messageTimestamp: now / 1000, message: { conversation: text } });
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [
      message('group', '123@g.us', ' /STICKER Make him a DJ '),
      message('dm', '456@lid', '/sticker Wear a RED hat'),
      message('other', '999@g.us', '/sticker ignored'), message('ordinary', '123@g.us', 'hello'),
      message('prefix', '123@g.us', '/stickers nope'), message('price-dm', '456@lid', '/status'),
      { ...message('photo', '789@s.whatsapp.net', ''), message: { imageMessage: { caption: '/sticker Photo wizard' } } },
    ] });
    assert.equal(commands.length, 5);
    assert.equal(commands[3][1], '/status');
    const imageCommands = commands.filter((c) => c[1] === '/sticker');
    assert.deepEqual(imageCommands.map((c) => c[3]), ['Make him a DJ', 'Wear a RED hat', 'ignored', 'Photo wizard']);
    for (const command of imageCommands) await wa.sendGeneratedSticker(command[0], sticker, command[2]);
    assert.deepEqual(sends.map((s) => s.chat), ['123@g.us', '456@lid', '999@g.us', '789@s.whatsapp.net']);
    await wa.replyText('notice', 'Try again', commands[1][2]);
    assert.equal(sends.at(-1).chat, '456@lid');
    await wa.send('price', 'Prices'); assert.equal(sends.at(-1).chat, '123@g.us');
    await assert.rejects(wa.replyText('invalid', 'Never send', incoming('other', 'invalid@g.us')));
    await assert.rejects(wa.sendGeneratedSticker('invalid', Buffer.from('bad'), commands[0][2]));
    const before = sends.length;
    const interrupted = wa.sendGeneratedSticker('reconnected', sticker, commands[0][2]);
    wa.generation++;
    await assert.rejects(interrupted, /connection changed/);
    assert.equal(sends.length, before);
  } finally { await wa.stop(); store.close(); }
});
