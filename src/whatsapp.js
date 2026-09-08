import makeWASocket, { Browsers, DisconnectReason, jidNormalizedUser, normalizeMessageContent } from '@whiskeysockets/baileys';
import pino from 'pino';
import { sqliteAuth } from './auth.js';
import { withTimeout } from './http.js';
import { isStickerChat, validateSticker } from './sticker.js';
import { validateGeneratedSticker } from './generated-sticker.js';

function isStatusRequest(content, me, direct) {
  const text = content?.conversation ?? content?.extendedTextMessage?.text;
  if (typeof text !== 'string') return false;
  if (direct) return text.trim().toLowerCase() === '/status';
  // WhatsApp renders the numeric mention token as the recipient's contact name.
  const match = /^@(\d+)\s+\/?status$/i.exec(text.trim());
  if (!match) return false;
  const identities = [me?.id, me?.lid].filter(Boolean).map(jidNormalizedUser);
  const mentions = content?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!Array.isArray(mentions)) return false;
  return mentions.some((jid) => {
    const normalized = jidNormalizedUser(jid);
    return identities.includes(normalized) && normalized.split('@')[0] === match[1];
  });
}

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
      socket.ev.on('messages.upsert', (event) => {
        if (event?.type !== 'notify' || !Array.isArray(event.messages)
            || this.stopped || !this.connected || generation !== this.generation) return;
        for (const message of event.messages) {
          if (!message || typeof message !== 'object') continue;
          const { key } = message;
          if (!key || typeof key !== 'object' || key.fromMe
              || typeof key.id !== 'string' || !key.id.trim()) continue;
          let timestamp, content;
          try {
            timestamp = Number(message.messageTimestamp) * 1000;
            content = normalizeMessageContent(message.message);
          } catch { continue; }
          if (!Number.isFinite(timestamp) || timestamp < openedAt
              || timestamp > this.now() + 60_000 || this.now() - timestamp > 300_000) continue;
          const text = content?.conversation ?? content?.extendedTextMessage?.text;
          const command = typeof text === 'string' ? text.trim().toLowerCase() : null;
          const direct = /^\d+@(s\.whatsapp\.net|lid)$/.test(key.remoteJid ?? '');
          if ((direct || key.remoteJid === this.groupId) && isStatusRequest(content, auth.state.creds.me, direct)) {
            this.onCommand(key.id, '/status', message);
          } else if (command === '/sticker-test' && isStickerChat(key.remoteJid, this.groupId)) {
            this.onCommand(key.id, command, message);
          } else if (typeof text === 'string' && /^\/sticker(?:\s|$)/i.test(text.trim())
              && isStickerChat(key.remoteJid, this.groupId)) {
            this.onCommand(key.id, '/sticker', message, text.trim().slice(8).trim());
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
    return this.#sendContent(id, { text, linkPreview: null });
  }
  async replyStatus(id, text, chatId) {
    if (!this.connected || !this.socket) throw new Error('WhatsApp unavailable');
    if (chatId !== this.groupId && !/^\d+@(s\.whatsapp\.net|lid)$/.test(chatId ?? '')) {
      throw new Error('Invalid status recipient');
    }
    const result = await withTimeout(this.socket.sendMessage(chatId,
      { text, linkPreview: null }, { messageId: id }), 30_000);
    if (result?.key?.id !== id) throw new Error('Missing WhatsApp send acknowledgement');
    return result;
  }
  async sendSticker(id, stickerBuffer, quotedMessage) {
    validateSticker(stickerBuffer);
    return this.#reply(id, { sticker: stickerBuffer, mimetype: 'image/webp' }, quotedMessage);
  }
  async sendGeneratedSticker(id, stickerBuffer, quotedMessage) {
    await validateGeneratedSticker(stickerBuffer);
    return this.#reply(id, { sticker: stickerBuffer, mimetype: 'image/webp' }, quotedMessage);
  }
  async replyText(id, text, quotedMessage) {
    return this.#reply(id, { text, linkPreview: null }, quotedMessage);
  }
  async #reply(id, content, quotedMessage) {
    const key = quotedMessage?.key;
    if (!key || key.fromMe || typeof key.id !== 'string' || !key.id.trim()
        || !isStickerChat(key.remoteJid, this.groupId)) {
      throw new Error('Invalid quoted sticker command');
    }
    return this.#sendContent(id, content, { quoted: quotedMessage }, true);
  }
  async #sendContent(id, content, options = {}, isReply = false) {
    if (!this.connected || !this.socket) throw new Error('WhatsApp unavailable');
    const recipient = isReply ? options.quoted?.key?.remoteJid : this.groupId;
    if (isReply) {
      if (!isStickerChat(recipient, this.groupId)) throw new Error('Invalid sticker reply destination');
    } else if (!/^\d+(?:-\d+)?@g\.us$/.test(recipient ?? '')) throw new Error('Invalid configured group');
    // Command replies follow their trigger; automatic price text stays in the group.
    const result = await withTimeout(this.socket.sendMessage(recipient,
      content, { ...options, messageId: id }), 30_000);
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
