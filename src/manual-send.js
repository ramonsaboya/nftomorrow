import { randomBytes } from 'node:crypto';
import { fetchSnapshot } from './prices.js';
import { formatPrices } from './message.js';

export async function sendPriceTest({ config, store, whatsapp, apiKey = '',
  getSnapshot = fetchSnapshot, now = Date.now }) {
  if (!/^\d+(?:-\d+)?@g\.us$/.test(config.groupId ?? '') || config.groupId !== whatsapp.groupId) {
    throw new Error('Set groupId in config.json to the intended group from npm run groups');
  }
  const snapshot = await getSnapshot(config, { apiKey });
  const text = formatPrices(snapshot, {
    displayCurrency: config.displayCurrency, now: now(),
  });
  if (!whatsapp.connected) throw new Error('WhatsApp disconnected before the test; no send attempted');
  const id = `3EB0${randomBytes(14).toString('hex').toUpperCase()}`;
  // Reserve durably before the network call. Never automatically retry an
  // ambiguous send: acknowledgement and local SQLite cannot commit atomically.
  store.reserve(id, { kind: 'test', groupId: config.groupId, text, snapshot }, now());
  try {
    await whatsapp.send(id, text);
    store.finish(id, 'acknowledged', now());
  } catch {
    store.finish(id, 'uncertain', now());
    throw new Error('Test delivery is uncertain. Check the group before deliberately running send-test again.');
  }
  return id;
}
