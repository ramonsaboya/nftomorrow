import { createHash, randomBytes } from 'node:crypto';
import { StickerCommand } from './sticker-command.js';
import { editReference, IMAGE_MODEL, MAX_PROMPT_LENGTH } from './image-edit.js';
import { validateGeneratedSticker } from './generated-sticker.js';

const messageId = () => `3EB0${randomBytes(14).toString('hex').toUpperCase()}`;

export class ImageStickerCommand extends StickerCommand {
  constructor({ apiKey = '', quality = 'medium', dailyLimit = 20, signal,
    generate = editReference, ...dependencies }) {
    super({ ...dependencies, statePrefix: 'image-sticker-command' });
    Object.assign(this, { apiKey, quality, dailyLimit, signal, generate });
  }
  request(id, message, prompt) {
    if (typeof prompt !== 'string' || this.signal?.aborted || !super.request(id, message)) return false;
    this.pending.prompt = prompt.trim();
    return true;
  }
  available(request) {
    return !this.signal?.aborted && this.whatsapp.connected
      && this.whatsapp.generation === request.generation
      && this.now() - request.at <= 300_000;
  }
  async deliver(request, kind, send, data = {}) {
    if (!this.available(request)) return;
    const id = messageId();
    this.store.reserve(id, { kind, chatId: request.chatId, ...data }, this.now());
    try {
      await send(id);
      this.store.transaction(() => {
        this.store.finish(id, 'acknowledged', this.now());
        this.store.set('deliveryUncertain', false);
      });
      this.log('message_acknowledged', { kind });
    } catch {
      this.store.transaction(() => {
        this.store.finish(id, 'uncertain', this.now());
        this.store.set('deliveryUncertain', true);
      });
      this.log('delivery_uncertain', { kind });
      await this.health.ping('whatsapp', false);
    }
  }
  async note(request, text) {
    return this.deliver(request, 'sticker-notice',
      (id) => this.whatsapp.replyText(id, text, request.message));
  }
  async reply(request) {
    if (!this.available(request)) return;
    if (!request.prompt || request.prompt.length > MAX_PROMPT_LENGTH) {
      await this.note(request, 'Use /sticker followed by a description, up to 1,000 characters. Example: /sticker make him a DJ');
      return;
    }
    if (!this.apiKey) {
      await this.note(request, 'AI stickers are not configured yet. /sticker-test still works.');
      return;
    }
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const budget = this.store.get('image-sticker-budget', {});
    const used = budget.day === day ? budget.used : 0;
    if (used >= this.dailyLimit) {
      await this.note(request, 'The daily AI sticker limit has been reached. Please try again tomorrow.');
      return;
    }
    const jobId = `image-${messageId()}`;
    this.store.transaction(() => {
      this.store.set('image-sticker-budget', { day, used: used + 1 });
      this.store.reserve(jobId, { kind: 'sticker-generation', chatId: request.chatId, model: IMAGE_MODEL,
        promptHash: createHash('sha256').update(request.prompt).digest('hex') }, this.now());
    });
    let result, asset;
    try {
      result = await this.generate({ prompt: request.prompt, apiKey: this.apiKey,
        quality: this.quality, signal: this.signal });
      asset = await validateGeneratedSticker(result.sticker);
      this.store.finish(jobId, 'generated', this.now());
      this.log('sticker_generated', { model: IMAGE_MODEL, bytes: asset.bytes, usage: result.usage });
    } catch {
      this.store.finish(jobId, 'uncertain', this.now());
      this.log('sticker_generation_failed');
      await this.note(request, 'I could not create that sticker. Please try again later or use a different prompt.');
      return;
    }
    await this.deliver(request, 'sticker-image',
      (id) => this.whatsapp.sendGeneratedSticker(id, result.sticker, request.message),
      { model: IMAGE_MODEL, sha256: asset.sha256, generationId: jobId });
  }
}
