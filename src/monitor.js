import { randomBytes } from 'node:crypto';
import { COLLECTIONS } from './collections.js';
import { fetchSnapshot, priceIn, validateSnapshot } from './prices.js';
import { formatPrices } from './message.js';
import { dailySlot, previousDate, HOUR_MS } from './schedule.js';

export class Monitor {
  constructor({ config, store, whatsapp, health, apiKey = '', now = Date.now,
    getSnapshot = fetchSnapshot, log = () => {} }) {
    Object.assign(this, { config, store, whatsapp, health, apiKey, now, getSnapshot, log });
    this.stateKey = `monitor:${config.groupId}`;
    this.time = config.dailySummaryTime;
    if (!this.time || !config.groupId) throw new Error('Monitor requires a group and dailySummaryTime');
    if (!store.get(this.stateKey)) {
      // First installation starts with the next daily slot, not a retroactive summary.
      store.set(this.stateKey, { dailySlot: dailySlot(now(), this.time) });
    }
    if (store.recoverAttempts(now())) store.set('deliveryUncertain', true);
  }
  due(now = this.now()) {
    const state = this.store.get(this.stateKey);
    return Math.floor(now / HOUR_MS) !== state.lastCheckHour
      || (dailySlot(now, this.time) > state.dailySlot && now - state.lastCheckAt >= 300_000);
  }
  async poll() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.check();
    try { return await this.inFlight; } finally { this.inFlight = null; }
  }
  async check() {
    const started = this.now();
    const generation = this.whatsapp.generation;
    const state = this.store.get(this.stateKey);
    state.lastCheckHour = Math.floor(started / HOUR_MS);
    state.lastCheckAt = started;
    this.store.set(this.stateKey, state);
    let snapshot;
    try {
      snapshot = await this.getSnapshot(this.config, { apiKey: this.apiKey });
      validateSnapshot(snapshot, this.now());
    } catch {
      this.log('price_check_failed');
      await this.health.ping('prices', false);
      return;
    }
    this.store.observation(snapshot);
    this.log('price_check_complete', { fiatAvailable: !snapshot.fxFailed });
    await this.health.ping('prices', !snapshot.fxFailed);
    // Reconnection must fetch again; never send an observation from an old socket.
    if (!this.whatsapp.connected || generation !== this.whatsapp.generation) return;
    const now = this.now();
    validateSnapshot(snapshot, now);
    const slot = dailySlot(now, this.time);
    const dueDaily = slot > state.dailySlot;
    const triggered = this.config.thresholds.filter((threshold) => {
      const price = priceIn(snapshot, threshold.target, threshold.currency, now);
      return price != null && price < threshold.below;
    });
    const hour = Math.floor(now / HOUR_MS);
    // Repeats are allowed each hourly check. Restarts/reconnects in the SAME
    // hour must not duplicate an already attempted threshold message.
    const alert = triggered.length > 0 && state.lastAlertHour !== hour;
    const alreadyAlerted = state.lastAlertSlot === previousDate(slot) || state.lastAlertSlot === slot;
    const summary = dueDaily && !alreadyAlerted;
    if (!alert && (!summary || triggered.length > 0)) {
      if (dueDaily) { state.dailySlot = slot; this.store.set(this.stateKey, state); }
      return;
    }
    const text = formatPrices(snapshot, { displayCurrency: this.config.displayCurrency, now })
      + (alert ? '\n\nBelow threshold: ' + triggered.map(({ target, below, currency }) => {
        const name = target === 'medallion' ? 'Medallion' : COLLECTIONS.find(({ id }) => id === target).name;
        return `${name} < ${new Intl.NumberFormat('en-GB').format(below)} ${currency}`;
      }).join('; ') : '');
    const id = `3EB0${randomBytes(14).toString('hex').toUpperCase()}`;
    this.store.transaction(() => {
      this.store.reserve(id, { kind: alert ? (dueDaily ? 'alert-and-summary' : 'alert') : 'summary',
        groupId: this.config.groupId, snapshot, text, triggered }, now);
      if (dueDaily) state.dailySlot = slot;
      if (alert) { state.lastAlertHour = hour; state.lastAlertSlot = slot; }
      // Commit BEFORE sending; crashes or uncertain acknowledgements are never
      // replayed. The next hourly observation may generate a fresh alert.
      this.store.set(this.stateKey, state);
    });
    try {
      await this.whatsapp.send(id, text);
      this.store.transaction(() => {
        this.store.finish(id, 'acknowledged', this.now());
        this.store.set('deliveryUncertain', false);
      });
      this.log('message_acknowledged', { kind: alert ? 'alert' : 'summary' });
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
