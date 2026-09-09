import { randomBytes } from 'node:crypto';
import { fetchSnapshot, MAX_AGE_MS } from './prices.js';
import { formatPrices } from './message.js';
import { isStickerChat } from './sticker.js';

// The service drains this single pending request in its main loop so shutdown
// waits for delivery bookkeeping and requests cannot create unbounded work.
export class StatusCommand {
  constructor({ config, store, whatsapp, health, apiKey = '', now = Date.now,
    getSnapshot = fetchSnapshot, log = () => {} }) {
    Object.assign(this, { config, store, whatsapp, health, apiKey, now, getSnapshot, log });
    this.stateKey = `status-command:${config.groupId}`;
  }
  request(id, chatId = this.config.groupId) {
    if (!isStickerChat(chatId) || !this.whatsapp.connected || this.pending || this.inFlight) return false;
    const now = this.now();
    const stateKey = `status-command:${chatId}`;
    const state = this.store.get(stateKey, { recent: [] });
    const recent = state.recent.filter((entry) => now - entry.at <= MAX_AGE_MS + 60_000);
    if ((state.lastAcceptedAt != null && now - state.lastAcceptedAt < 60_000)
        || recent.some((entry) => entry.id === id)) return false;
    // Persist acceptance before any network work. Restart never replays a reply.
    this.store.set(stateKey, { lastAcceptedAt: now, recent: [...recent, { id, at: now }] });
    this.pending = { generation: this.whatsapp.generation, at: now, chatId };
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
    let snapshot = null, text;
    try {
      snapshot = await this.getSnapshot(this.config, { apiKey: this.apiKey });
      text = formatPrices(snapshot, { displayCurrency: this.config.displayCurrency, now: this.now() });
    } catch {
      snapshot = null;
      text = 'Current prices are unavailable because the fresh price check failed. Please try again in a minute.';
      this.log('status_price_check_failed');
    }
    if (snapshot) this.store.observation(snapshot);
    await this.health.ping('prices', !!snapshot && !snapshot.fxFailed);
    if (!available()) return;
    // Revalidate after the health request; never label an aged snapshot current.
    if (snapshot) {
      try { text = formatPrices(snapshot, { displayCurrency: this.config.displayCurrency, now: this.now() }); }
      catch { return; }
    }
    const id = `3EB0${randomBytes(14).toString('hex').toUpperCase()}`;
    this.store.reserve(id, { kind: 'status', chatId: request.chatId, snapshot, text }, this.now());
    try {
      await this.whatsapp.replyStatus(id, text, request.chatId);
      this.store.transaction(() => {
        this.store.finish(id, 'acknowledged', this.now());
        this.store.set('deliveryUncertain', false);
      });
      this.log('message_acknowledged', { kind: 'status' });
    } catch {
      this.store.transaction(() => {
        this.store.finish(id, 'uncertain', this.now());
        this.store.set('deliveryUncertain', true);
      });
      this.log('delivery_uncertain');
      await this.health.ping('whatsapp', false);
    }
  }
}
