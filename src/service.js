import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { acquireLock } from './lock.js';
import { WhatsApp } from './whatsapp.js';
import { Health } from './health.js';
import { Monitor } from './monitor.js';
import { StatusCommand } from './status-command.js';
import { StickerCommand } from './sticker-command.js';
import { ImageStickerCommand } from './image-sticker-command.js';
import { finishCommand } from './shutdown.js';

process.umask(0o077);
const log = (event, fields = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
let store, release, whatsapp;
let stopped = false;
const wake = new AbortController();
const background = new Set();
const stop = () => { stopped = true; wake.abort(); whatsapp?.stop(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
process.on('unhandledRejection', () => { log('fatal_async_error'); process.exitCode = 1; stop(); });
try {
  const { config, dataDir, apiKey, healthUrls, imageStickers } = loadConfig();
  if (!config.groupId || !config.dailySummaryTime || !config.displayCurrency) {
    throw new Error('Set groupId, displayCurrency and dailySummaryTime before starting the monitor');
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  release = acquireLock(join(dataDir, 'instance.sqlite'));
  store = new Store(join(dataDir, 'monitor.sqlite'));
  const health = new Health(healthUrls, { log });
  let forceCheck = true;
  let statusCommand, stickerCommand, imageCommand;
  whatsapp = new WhatsApp({ store, groupId: config.groupId, log, stickerOwnerJids: config.stickerOwnerJids,
    onCommand: (id, command, message, prompt) => {
      if (command === '/status') statusCommand.request(id, message.key.remoteJid, prompt);
      else if (command === '/sticker-test') stickerCommand.request(id, message);
      else if (command === '/sticker') imageCommand.request(id, message, prompt);
      else if (command === '/euvousticker') imageCommand.request(id, message, prompt, 'reference');
      else if (command === 'sticker-revision') imageCommand.requestRevision(id, message, prompt);
    },
    onFresh: () => { forceCheck = true; },
    onStatus: (status) => {
      log('whatsapp_status', { status });
      if (['needs_pairing', 'connection_replaced', 'fatal_auth_store'].includes(status)) {
        const task = health.ping('whatsapp', false);
        background.add(task);
        task.finally(() => background.delete(task));
      }
      if (status === 'fatal_auth_store') { process.exitCode = 1; stop(); }
    },
  });
  const monitor = new Monitor({ config, store, whatsapp, health, apiKey, log });
  statusCommand = new StatusCommand({ config, store, whatsapp, health, apiKey, log });
  stickerCommand = new StickerCommand({ config, store, whatsapp, health, log });
  imageCommand = new ImageStickerCommand({ config, store, whatsapp, health, log,
    ...imageStickers, signal: wake.signal });
  if (!imageStickers.apiKey) log('image_stickers_unconfigured');
  if (!config.stickerOwnerJids?.length) log('sticker_owner_unconfigured');
  const missingChecks = ['process', 'prices', 'whatsapp'].filter((name) => !healthUrls[name]);
  if (missingChecks.length) log('email_monitoring_unconfigured', { checks: missingChecks });
  log('monitor_started', { dailySummaryTime: config.dailySummaryTime, timezone: 'Europe/London', polling: 'hourly' });
  await whatsapp.start();
  let heartbeat = 0;
  while (!stopped) {
    if (Date.now() - heartbeat >= 60_000) {
      heartbeat = Date.now();
      await Promise.all([
        health.ping('process', true),
        whatsapp.connected ? health.ping('whatsapp', !store.get('deliveryUncertain', false)) : Promise.resolve(),
      ]);
    }
    if (stopped) break;
    if (forceCheck || monitor.due()) {
      forceCheck = false;
      await monitor.poll();
    }
    if (stopped) break;
    await statusCommand.runPending();
    if (stopped) break;
    await stickerCommand.runPending();
    if (stopped) break;
    // Image edits may take minutes. Keep the price loop and heartbeats running,
    // but allow just one image job; shutdown aborts it and awaits bookkeeping.
    if (imageCommand.pending && !imageCommand.inFlight) {
      const task = imageCommand.runPending().catch(() => {
        log('fatal_image_task'); process.exitCode = 1; stop();
      });
      background.add(task);
      task.finally(() => background.delete(task));
    }
    try { await sleep(1000, undefined, { signal: wake.signal }); }
    catch { if (!stopped) throw new Error('Monitor wait failed'); }
  }
} catch {
  log('monitor_failed');
  process.exitCode = 1;
} finally {
  log('monitor_stopping');
  stop();
  await Promise.allSettled([...background]);
  await finishCommand({ whatsapp, store, release });
}
