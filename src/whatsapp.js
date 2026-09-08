import makeWASocket, { Browsers, DisconnectReason, normalizeMessageContent } from '@whiskeysockets/baileys';
import pino from 'pino';
import { sqliteAuth } from './auth.js';
import { withTimeout } from './http.js';

export class WhatsApp {
  constructor({ store, groupId, onFresh = () => {}, onStatus = () => {}, onCommand = () => {}, onQr,
    now = Date.now,
    log = () => {}, makeSocket = makeWASocket, schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { store, groupId, onFresh, onStatus, onCommand, onQr, now, log, makeSocket, schedule, cancel });
    this.connected = false;
    this.generation = 0;
    this.attempt = 0;
    this.stopped = false;
  }
  async start() {
    const auth = sqliteAuth(this.store);
    // QR pairing saves creds.me but does not set registered in Baileys rc14.
    // Match its login path instead of rejecting a valid persisted QR session.
    if (!this.onQr && (!auth.state.creds.me?.id || this.store.get('whatsappLoggedOut', false))) {
      this.onStatus('needs_pairing');
      return;
    }
    this.connect(auth);
  }
  connect(auth) {
    if (this.stopped) return;
    const generation = ++this.generation;
    try {
      const socket = this.makeSocket({
        auth: auth.state,
        // Internal protocol logging can contain private keys, JIDs and messages.
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        markOnlineOnConnect: false,
        emitOwnEvents: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 30_000,
        defaultQueryTimeoutMs: 30_000,
        retryRequestDelayMs: 1000,
        maxMsgRetryCount: 2,
        // No replay of old application messages after reconnect/decryption retry.
        getMessage: async () => undefined,
      });
      this.socket = socket;
      let openedAt = Infinity;
      socket.ev.on('messages.upsert', ({ type, messages }) => {
        if (type !== 'notify' || this.stopped || !this.connected || generation !== this.generation) return;
        for (const message of messages) {
          const { key } = message;
          const timestamp = Number(message.messageTimestamp) * 1000;
          if (key?.remoteJid !== this.groupId || key.fromMe || !key.id
              || !Number.isFinite(timestamp) || timestamp < openedAt
              || timestamp > this.now() + 60_000 || this.now() - timestamp > 300_000) continue;
          const content = normalizeMessageContent(message.message);
          const text = content?.conversation ?? content?.extendedTextMessage?.text;
          if (typeof text === 'string' && text.trim().toLowerCase() === '/status') {
            this.onCommand(key.id);
          }
        }
      });
      socket.ev.on('creds.update', () => {
        if (this.stopped || generation !== this.generation) return;
        try { auth.saveCreds(); }
        catch { this.log('auth_write_failed'); this.stop(); this.onStatus('fatal_auth_store'); }
      });
      socket.ev.on('connection.update', (update) => {
        if (this.stopped || generation !== this.generation) return;
        if (update.qr) {
          if (this.onQr) this.onQr(update.qr);
          else {
            this.store.set('whatsappLoggedOut', true);
            this.stop();
            this.onStatus('needs_pairing');
          }
        }
        if (update.connection === 'open') {
          openedAt = Math.floor(this.now() / 1000) * 1000;
          this.connected = true;
          this.attempt = 0;
          this.store.set('whatsappLoggedOut', false);
          this.onStatus('connected');
          this.onFresh();
        } else if (update.connection === 'close') {
          this.connected = false;
          const code = update.lastDisconnect?.error?.output?.statusCode;
          if ([DisconnectReason.loggedOut, DisconnectReason.badSession,
            DisconnectReason.multideviceMismatch, DisconnectReason.forbidden].includes(code)) {
            this.store.set('whatsappLoggedOut', true);
            this.onStatus('needs_pairing');
            return;
          }
          if (code === DisconnectReason.connectionReplaced) {
            this.onStatus('connection_replaced');
            return;
          }
          this.onStatus('disconnected');
          this.retry(auth);
        }
      });
    } catch {
      this.connected = false;
      this.onStatus('disconnected');
      this.retry(auth);
    }
  }
  retry(auth) {
    if (this.stopped) return;
    this.cancel(this.timer);
    const delay = Math.min(1000 * 2 ** Math.min(this.attempt++, 9), 300_000);
    this.timer = this.schedule(() => {
      if (this.stopped) return;
      ++this.generation;
      this.socket?.end(new Error('Reconnecting'));
      this.connect(auth);
    }, delay);
  }
  async send(id, text) {
    if (!this.connected || !this.socket) throw new Error('WhatsApp unavailable');
    if (!/^\d+(?:-\d+)?@g\.us$/.test(this.groupId ?? '')) throw new Error('Invalid configured group');
    // There is intentionally no recipient parameter: this is the only send path.
    const result = await withTimeout(this.socket.sendMessage(this.groupId,
      { text, linkPreview: null }, { messageId: id }), 30_000);
    if (result?.key?.id !== id) throw new Error('Missing WhatsApp send acknowledgement');
    return result;
  }
  async groups() {
    if (!this.connected) throw new Error('WhatsApp unavailable');
    const groups = await withTimeout(this.socket.groupFetchAllParticipating(), 30_000);
    return Object.values(groups).map(({ id, subject }) => ({ id, subject }));
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.connected = false;
    ++this.generation;
    this.cancel(this.timer);
    this.stopPromise = Promise.resolve().then(() => this.socket?.end(new Error('Shutting down')))
      .catch(() => { this.log('socket_shutdown_failed'); });
    return this.stopPromise;
  }
}
