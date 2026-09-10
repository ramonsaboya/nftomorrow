import { jidNormalizedUser } from '@whiskeysockets/baileys';

export const MAX_STICKER_IMAGES = 25;
export const STICKER_BATCH = Symbol('sticker image batch');
const IMAGE_COMMANDS = ['/sticker', '/euvousticker'];

// Association metadata can live outside an associatedChildMessage wrapper.
function association(message) {
  let content = message.message;
  for (let i = 0; content && i < 6; i++) {
    const value = content.messageContextInfo?.messageAssociation;
    if (value?.associationType === 1) return value;
    const wrapper = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2',
      'viewOnceMessageV2Extension', 'associatedChildMessage', 'documentWithCaptionMessage']
      .find((key) => content[key]?.message);
    content = wrapper ? content[wrapper].message : undefined;
  }
}

export class StickerAlbums {
  constructor({ store, emit, authorize, now = Date.now, schedule = setTimeout, cancel = clearTimeout,
    quietMs = 5000, deadlineMs = 90000 }) {
    Object.assign(this, { store, emit, authorize, now, schedule, cancel, quietMs, deadlineMs });
    this.groups = new Map();
  }
  accept(message, content, parsed) {
    const link = association(message);
    const header = content?.albumMessage;
    if (!header && !link && !content?.imageMessage) return false;
    // Other commands retain their normal intake, even with a photo nearby.
    if (parsed && !IMAGE_COMMANDS.includes(parsed.command)) return false;
    if (!this.authorize(message)) return Boolean(header || link);
    const chat = message.key.remoteJid;
    const sender = jidNormalizedUser(message.key.participant ?? chat);
    const parent = link?.parentMessageKey;
    if (link && (typeof parent?.id !== 'string' || !parent.id
        || (parent.remoteJid && parent.remoteJid !== chat)
        || (parent.participant && jidNormalizedUser(parent.participant) !== sender)
        || parent.fromMe)) return true;
    const albumId = header ? message.key.id : parent?.id;
    const key = JSON.stringify([chat, sender, albumId ?? 'photo-burst']);
    const recent = this.store.get('sticker-album-completed', [])
      .filter((item) => this.now() - item.at < 360_000);
    if (albumId && recent.some((item) => item.key === key)) return true;
    let group = this.groups.get(key);
    if (!group) {
      if (this.groups.size >= 16) return true;
      group = { key, albumId, photos: new Map(), parsed: null, message: null };
      this.groups.set(key, group);
      group.deadline = this.schedule(() => this.finish(group, true), this.deadlineMs);
    }
    if (header) {
      const count = header.expectedImageCount;
      if (!Number.isInteger(count) || count < 1 || count > MAX_STICKER_IMAGES
          || (header.expectedVideoCount ?? 0) !== 0) group.error = 'album_size';
      if (group.expected != null && group.expected !== count) group.error = 'album_incomplete';
      group.expected = count;
    } else {
      if (!group.photos.has(message.key.id)) {
        if (!content.imageMessage) group.error = 'album_size';
        else if (group.photos.size >= MAX_STICKER_IMAGES) group.error = 'album_size';
        else group.photos.set(message.key.id, { source: content.imageMessage,
          index: Number.isInteger(link?.messageIndex) ? link.messageIndex : group.photos.size });
      }
      if (parsed) {
        if (group.parsed && (group.parsed.command !== parsed.command || group.parsed.prompt !== parsed.prompt)) {
          group.error = 'album_prompts';
        } else if (!group.parsed) {
          group.parsed = parsed;
          group.message = message;
        }
      }
    }
    if (group.albumId && group.expected != null && group.photos.size > group.expected) group.error = 'album_incomplete';
    if (group.albumId && group.parsed && (group.error || group.photos.size === group.expected)) {
      this.finish(group);
    } else if (!group.albumId) {
      this.cancel(group.quiet);
      group.quiet = this.schedule(() => this.finish(group), this.quietMs);
    }
    return true;
  }
  finish(group, expired = false) {
    if (this.groups.get(group.key) !== group) return;
    this.groups.delete(group.key);
    this.cancel(group.deadline);
    this.cancel(group.quiet);
    if (!group.parsed) return;
    if (group.albumId) {
      const recent = this.store.get('sticker-album-completed', [])
        .filter((item) => this.now() - item.at < 360_000);
      this.store.set('sticker-album-completed', [...recent, { key: group.key, at: this.now() }].slice(-128));
    }
    const error = group.error || (expired ? 'album_incomplete' : undefined);
    const sources = [...group.photos.values()].sort((a, b) => a.index - b.index).map((item) => item.source);
    const message = { ...group.message, [STICKER_BATCH]: { sources, error } };
    this.emit(message.key.id, group.parsed.command, message, group.parsed.prompt);
  }
  clear() {
    for (const group of this.groups.values()) {
      this.cancel(group.deadline);
      this.cancel(group.quiet);
    }
    this.groups.clear();
  }
}
