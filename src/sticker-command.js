import { randomBytes } from 'node:crypto';
import { MAX_AGE_MS } from './prices.js';
import { isStickerChat, loadSticker, validateSticker } from './sticker.js';

// Drained in the monitor loop: one bounded request, with durable acceptance
// before sending and no replay after restart, reconnect or uncertain delivery.
export class StickerCommand {
  constructor({ config, store, whatsapp, health, now = Date.now,
    getSticker = loadSticker, log = () => {}, statePrefix = 'sticker-command' }) {
    Object.assign(this, { config, store, whatsapp, health, now, getSticker, log, statePrefix });
    this.stateKey = `${statePrefix}:${config.groupId}`;
  }
  request(id, message) {
    const chatId = message?.key?.remoteJid;
    if (typeof id !== 'string' || !id || message?.key?.id !== id
        || !isStickerChat(chatId, this.config.groupId) || message.key.fromMe
        || !this.whatsapp.connected || this.pending || this.inFlight) return false;
    const now = this.now();
    const stateKey = `${this.statePrefix}:${chatId}`;
    const state = this.store.get(stateKey, { recent: [] });
    // Intake tolerates 60 seconds of sender clock skew; a future-dated request
    // can remain admissible for six minutes after its first acceptance.
    const recent = state.recent.filter((entry) => now - entry.at <= MAX_AGE_MS + 60_000);
    if ((state.lastAcceptedAt != null && now - state.lastAcceptedAt < 60_000)
        || recent.some((entry) => entry.id === id)) return false;
    this.store.set(stateKey, { lastAcceptedAt: now, recent: [...recent, { id, at: now }] });
    this.pending = { generation: this.whatsapp.generation, at: now, message, chatId };
    return true;
  }
  async runPending() {
    if (this.inFlight) return this.inFlight;
    if (!this.pending) return;
    const request = this.pending;
    this.pending = null;
    this.inFlight = this.reply(request);
    try { return await this.inFlight; } finally { this.inFlight = null; }
  }
  async reply(request) {
    const available = () => this.whatsapp.connected
      && this.whatsapp.generation === request.generation
      && this.now() - request.at <= MAX_AGE_MS;
    if (!available()) return;
    let sticker, asset;
    try {
      sticker = await this.getSticker();
      asset = validateSticker(sticker);
    } catch {
      // A missing or damaged optional asset must not stop price monitoring.
      this.log('sticker_unavailable');
      return;
    }
    if (!available()) return;
    const id = `3EB0${randomBytes(14).toString('hex').toUpperCase()}`;
    this.store.reserve(id, { kind: 'sticker-test', chatId: request.chatId,
      asset: 'sticker-test.webp', sha256: asset.sha256 }, this.now());
    try {
      await this.whatsapp.sendSticker(id, sticker, request.message);
      this.store.transaction(() => {
        this.store.finish(id, 'acknowledged', this.now());
        this.store.set('deliveryUncertain', false);
      });
      this.log('message_acknowledged', { kind: 'sticker-test' });
    } catch {
      this.store.transaction(() => {
        this.store.finish(id, 'uncertain', this.now());
        this.store.set('deliveryUncertain', true);
      });
      this.log('delivery_uncertain', { kind: 'sticker-test' });
      await this.health.ping('whatsapp', false);
    }
  }
}
