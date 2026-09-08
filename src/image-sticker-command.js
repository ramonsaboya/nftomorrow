import { createHash, randomBytes } from 'node:crypto';
import { StickerCommand } from './sticker-command.js';
import { editReference, imageErrorDetails, IMAGE_MODEL, MAX_PROMPT_LENGTH } from './image-edit.js';
import { validateGeneratedSticker } from './generated-sticker.js';

const messageId = () => `3EB0${randomBytes(14).toString('hex').toUpperCase()}`;

function failureNotice(error) {
  if (['billing_hard_limit_reached', 'insufficient_quota'].includes(error.apiCode)
      || error.apiType === 'insufficient_quota') return 'AI stickers are unavailable because the OpenAI account has reached its billing or credit limit. The bot owner needs to check API billing.';
  if ([401, 403].includes(error.status)) return 'AI stickers are unavailable because OpenAI rejected the bot\'s access. The bot owner needs to check the API key and model permissions.';
  if (['content_policy_violation', 'moderation_blocked'].includes(error.apiCode)) return 'OpenAI could not accept that image request. Please use a different prompt.';
  if (error.code === 'rate_limited') return 'OpenAI is receiving too many image requests. Please try again later.';
  if (error.code === 'timeout') return 'Image creation took too long to respond. It may still have been processed, so please wait before trying again.';
  if (error.code === 'conversion_failed') return 'The image was created, but I could not turn it into a valid sticker. The bot owner can check the error reference.';
  return 'I could not create that sticker. The bot owner can check the error reference before you try again.';
}

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
    if (!this.available(request)) return false;
    const id = messageId();
    this.store.reserve(id, { kind, chatId: request.chatId, ...data }, this.now());
    try {
      await send(id);
      this.store.transaction(() => {
        this.store.finish(id, 'acknowledged', this.now());
        this.store.set('deliveryUncertain', false);
      });
      this.log('message_acknowledged', { kind });
      return true;
    } catch {
      this.store.transaction(() => {
        this.store.finish(id, 'uncertain', this.now());
        this.store.set('deliveryUncertain', true);
      });
      this.log('delivery_uncertain', { kind });
      await this.health.ping('whatsapp', false);
      return false;
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
    let day = new Date(this.now()).toISOString().slice(0, 10);
    const budget = this.store.get('image-sticker-budget', {});
    let used = budget.day === day ? budget.used : 0;
    if (used >= this.dailyLimit) {
      await this.note(request, 'The daily AI sticker limit has been reached. Please try again tomorrow.');
      return;
    }
    const acknowledged = await this.deliver(request, 'sticker-processing',
      (id) => this.whatsapp.replyText(id,
        'Dobby’s on it 🪄 I’m making your sticker and will send it here when it’s ready. It may take a couple of minutes.',
        request.message));
    if (!acknowledged || !this.available(request)) return;
    // The acknowledgement can cross midnight; reserve against the generation day.
    day = new Date(this.now()).toISOString().slice(0, 10);
    const currentBudget = this.store.get('image-sticker-budget', {});
    used = currentBudget.day === day ? currentBudget.used : 0;
    const jobId = `image-${messageId()}`;
    this.store.transaction(() => {
      this.store.set('image-sticker-budget', { day, used: used + 1 });
      this.store.reserve(jobId, { kind: 'sticker-generation', chatId: request.chatId, model: IMAGE_MODEL,
        promptHash: createHash('sha256').update(request.prompt).digest('hex') }, this.now());
    });
    let result, asset;
    const startedAt = this.now(), reference = jobId.slice(-8);
    let stage = 'image_edit';
    try {
      result = await this.generate({ prompt: request.prompt, apiKey: this.apiKey,
        quality: this.quality, signal: this.signal });
      stage = 'sticker_validation';
      asset = await validateGeneratedSticker(result.sticker);
      this.store.finish(jobId, 'generated', this.now());
      this.log('sticker_generated', { model: IMAGE_MODEL, generationId: jobId,
        elapsedMs: this.now() - startedAt, bytes: asset.bytes, usage: result.usage });
    } catch (error) {
      this.store.finish(jobId, 'uncertain', this.now());
      const details = imageErrorDetails(error);
      this.log('sticker_generation_failed', { generationId: jobId, reference, stage,
        elapsedMs: this.now() - startedAt, ...details });
      await this.note(request, `${failureNotice(details)} Reference: ${reference}`);
      return;
    }
    await this.deliver(request, 'sticker-image',
      (id) => this.whatsapp.sendGeneratedSticker(id, result.sticker, request.message),
      { model: IMAGE_MODEL, sha256: asset.sha256, generationId: jobId });
  }
}
