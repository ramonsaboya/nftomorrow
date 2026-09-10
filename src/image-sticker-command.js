import { createHash, randomBytes } from 'node:crypto';
import { StickerCommand } from './sticker-command.js';
import { editReference, generateSticker, imageErrorDetails, IMAGE_MODEL, MAX_PROMPT_LENGTH } from './image-edit.js';
import { validateGeneratedSticker } from './generated-sticker.js';
import { loadStickerInputs } from './sticker-input.js';
import { STICKER_BATCH } from './sticker-album.js';

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
  constructor({ apiKey = '', quality = 'max', dailyLimit = 20, signal, loadImages = loadStickerInputs,
    generate = (options) => options.mode === 'reference' ? editReference(options) : generateSticker(options), ...dependencies }) {
    super({ ...dependencies, statePrefix: 'image-sticker-command' });
    Object.assign(this, { apiKey, quality, dailyLimit, signal, generate, loadImages });
  }
  request(id, message, prompt, mode = 'freeform') {
    if (!['freeform', 'reference'].includes(mode) || typeof prompt !== 'string' || this.signal?.aborted || !super.request(id, message)) return false;
    const animationFlag = /^--(?:animated|gif)(?:\s+|$)/i.exec(prompt.trim());
    this.pending.animated = Boolean(animationFlag);
    this.pending.prompt = animationFlag ? prompt.trim().slice(animationFlag[0].length).trim() : prompt.trim();
    this.pending.mode = mode;
    return true;
  }
  available(request) {
    return !this.signal?.aborted && this.whatsapp.connected
      && this.whatsapp.generation === request.generation
      && this.now() - request.at <= 420_000;
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
    const batchError = request.message[STICKER_BATCH]?.error;
    if (batchError) {
      await this.note(request, batchError === 'album_size'
        ? 'Please send up to 25 photos, without videos, with one /sticker prompt for the whole album. No AI generation was started.'
        : batchError === 'album_prompts'
          ? 'Please use one /sticker prompt for the whole album. I received different commands on its photos. No AI generation was started.'
          : 'I did not receive the complete photo album. Please resend the photos together with your /sticker prompt. No AI generation was started.');
      return;
    }
    if (!request.prompt || request.prompt.length > MAX_PROMPT_LENGTH) {
      await this.note(request, request.mode === 'reference'
        ? 'Use /euvousticker followed by an overall theme or scene, up to 4,000 characters. Example: /euvousticker beach holiday, caption "Eu vou"'
        : 'Use /sticker followed by a description, up to 4,000 characters. Example: /sticker a dancing dragon. For animation: /sticker --animated a dragon flapping its wings');
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
    let images;
    try { images = await this.loadImages(request.message, { signal: this.signal }); }
    catch {
      await this.note(request, 'I could not read that photo or complete photo set. Please resend up to 25 static JPEG, PNG or WebP photos under 20 MB each with /sticker and your description in the caption. Try smaller photos if the set is large. No AI generation was started.');
      return;
    }
    if (!this.available(request)) return;
    const acknowledged = await this.deliver(request, 'sticker-processing',
      (id) => this.whatsapp.replyText(id,
        `Dobby’s on it 🪄 I’m making your ${request.animated ? 'animated ' : ''}sticker${images.length ? ` using ${images.length} photo${images.length === 1 ? '' : 's'}` : ''} and will send it here when it’s ready. It may take a couple of minutes.`,
        request.message));
    if (!acknowledged || !this.available(request)) return;
    // The acknowledgement can cross midnight; reserve against the generation day.
    day = new Date(this.now()).toISOString().slice(0, 10);
    const currentBudget = this.store.get('image-sticker-budget', {});
    used = currentBudget.day === day ? currentBudget.used : 0;
    const jobId = `image-${messageId()}`;
    this.store.transaction(() => {
      this.store.set('image-sticker-budget', { day, used: used + 1 });
      this.store.reserve(jobId, { kind: 'sticker-generation', chatId: request.chatId, model: IMAGE_MODEL, mode: request.mode,
        imageCount: images.length, animated: request.animated,
        promptHash: createHash('sha256').update(request.prompt).digest('hex') }, this.now());
    });
    let result, asset;
    const startedAt = this.now(), reference = jobId.slice(-8);
    let stage = request.mode === 'reference' || images.length ? 'image_edit' : 'image_generation';
    try {
      result = await this.generate({ prompt: request.prompt, apiKey: this.apiKey, mode: request.mode,
        quality: this.quality, signal: this.signal, images, animated: request.animated });
      stage = 'sticker_validation';
      asset = await validateGeneratedSticker(result.sticker, { requireAnimated: request.animated });
      this.store.finish(jobId, 'generated', this.now());
      this.log('sticker_generated', { model: IMAGE_MODEL, generationId: jobId,
        elapsedMs: this.now() - startedAt, bytes: asset.bytes, animated: asset.animated,
        frames: asset.frames, durationMs: asset.durationMs, usage: result.usage });
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
