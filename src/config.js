import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TARGETS } from './collections.js';

const currencies = ['SOL', 'USD', 'GBP', 'EUR'];
export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Config must be an object');
  const allowed = ['groupId', 'displayCurrency', 'thresholds', 'dailySummaryTime', 'stickerOwnerJids', 'resetAlerts'];
  if (config.resetAlerts !== undefined && typeof config.resetAlerts !== 'boolean') throw new Error('resetAlerts must be boolean');
  if (config.resetAlerts && new Set((config.stickerOwnerJids ?? []).filter(jid => typeof jid === 'string' && /^\d+@s\.whatsapp\.net$/.test(jid))).size !== 1) {
    throw new Error('Reset alerts require exactly one sticker-owner phone account');
  }
  if (Object.keys(config).some((key) => !allowed.includes(key))) throw new Error('Unknown config option');
  if (config.stickerOwnerJids !== undefined && (!Array.isArray(config.stickerOwnerJids)
      || config.stickerOwnerJids.some((jid) => typeof jid !== 'string'
        || !/^\d+@(s\.whatsapp\.net|lid)$/.test(jid)))) {
    throw new Error('stickerOwnerJids must contain WhatsApp phone-number or LID account IDs');
  }
  if (config.groupId != null && !/^\d+(?:-\d+)?@g\.us$/.test(config.groupId)) throw new Error('groupId must be a WhatsApp group JID');
  if (config.displayCurrency != null && !currencies.includes(config.displayCurrency)) throw new Error('displayCurrency must be SOL, USD, GBP, EUR or null');
  if (!Array.isArray(config.thresholds)) throw new Error('thresholds must be an array');
  if (config.dailySummaryTime !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.dailySummaryTime)) {
    throw new Error('dailySummaryTime must be HH:mm in Europe/London');
  }
  const seen = new Set();
  for (const threshold of config.thresholds) {
    if (!threshold || Object.keys(threshold).some((key) => !['target', 'currency', 'below'].includes(key))
        || !TARGETS.includes(threshold.target) || !currencies.includes(threshold.currency)
        || typeof threshold.below !== 'number' || !Number.isFinite(threshold.below) || threshold.below <= 0) {
      throw new Error('Each threshold needs a valid target, currency and positive below value');
    }
    if (seen.has(threshold.target)) throw new Error('Only one threshold per target is supported');
    seen.add(threshold.target);
  }
  return config;
}

export function loadConfig(env = process.env) {
  const path = resolve(env.CONFIG_PATH || 'config.json');
  let config;
  try { config = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('Cannot read configuration; copy config.example.json to config.json and edit it'); }
  validateConfig(config);
  const healthUrls = {};
  for (const [check, name] of Object.entries({ prices: 'HEALTHCHECK_PRICES_URL', whatsapp: 'HEALTHCHECK_WHATSAPP_URL', process: 'HEALTHCHECK_PROCESS_URL' })) {
    const value = env[name]?.trim();
    if (!value) continue;
    let url;
    try { url = new URL(value); } catch { throw new Error(`Invalid ${name}`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || !/^\/[0-9a-f-]{36}$/i.test(url.pathname)) throw new Error(`Invalid ${name}`);
    healthUrls[check] = value.replace(/\/$/, '');
  }
  const quality = env.OPENAI_IMAGE_QUALITY || 'max';
  const dailyLimit = Number(env.STICKER_DAILY_LIMIT || '20');
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'auto'].includes(quality)) throw new Error('Invalid OPENAI_IMAGE_QUALITY');
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 1000) throw new Error('Invalid STICKER_DAILY_LIMIT');
  return { config, dataDir: resolve(env.DATA_DIR || 'data'), healthUrls,
    imageStickers: { apiKey: env.OPENAI_API_KEY?.trim() || '', quality, dailyLimit },
    apiKey: env.COINGECKO_DEMO_API_KEY || '' };
}
