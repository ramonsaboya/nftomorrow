import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import qrcode from 'qrcode-terminal';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { acquireLock } from './lock.js';
import { fetchSnapshot } from './prices.js';
import { formatPrices } from './message.js';
import { WhatsApp } from './whatsapp.js';
import { sendPriceTest } from './manual-send.js';
import { finishCommand } from './shutdown.js';

// In particular, SQLite journals/WAL and authentication files inherit 0600.
process.umask(0o077);
let store;
let release;
let whatsapp;
let activeTask;
try {
  const command = process.argv[2] ?? 'check';
  if (!['check', 'pair', 'groups', 'send-test'].includes(command)) {
    throw new Error('Available commands: check, pair, groups, send-test. Continuous alerts await policy confirmation.');
  }
  const { config, dataDir, apiKey } = loadConfig();
  if (command === 'check') {
    const snapshot = await fetchSnapshot(config, { apiKey });
    console.log(formatPrices(snapshot, { displayCurrency: config.displayCurrency }));
    if (snapshot.fxFailed) process.exitCode = 1;
  } else {
    if (!process.stdout.isTTY) throw new Error('WhatsApp commands require an interactive terminal');
    if (command === 'send-test' && !config.groupId) {
      throw new Error('Set groupId in config.json to the intended group from npm run groups');
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    release = acquireLock(join(dataDir, 'instance.sqlite'));
    store = new Store(join(dataDir, 'monitor.sqlite'));
    store.recoverAttempts(Date.now());
    if (command === 'pair' && store.get('whatsappLoggedOut', false)) {
      // Explicit pair command replaces only unusable auth, preserving price/alert history.
      store.transaction(() => {
        store.db.exec('DELETE FROM auth');
        store.set('whatsappLoggedOut', false);
      });
    }
    await new Promise((resolve, reject) => {
      let handledConnection = false;
      const timer = setTimeout(() => reject(new Error('Pairing/connection timed out; rerun the command')), 180_000);
      const done = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      process.once('SIGINT', () => done());
      process.once('SIGTERM', () => done());
      whatsapp = new WhatsApp({ store, groupId: config.groupId,
        onQr: command === 'pair' ? (qr) => qrcode.generate(qr, { small: true }) : undefined,
        onStatus: (status) => {
          if (['needs_pairing', 'connection_replaced', 'fatal_auth_store'].includes(status)) done(new Error(`WhatsApp: ${status}`));
        },
        onFresh: () => {
          // A reconnect during price fetching must not start another send.
          if (handledConnection) return;
          handledConnection = true;
          if (command === 'pair') { console.log('WhatsApp linked. No message sent.'); done(); }
          else if (command === 'send-test') {
            activeTask = sendPriceTest({ config, store, whatsapp, apiKey }).then(() => {
              console.log('Test send acknowledged. Check the group on a recipient phone; acknowledgement does not prove a phone notification.');
              done();
            }, done);
          }
          else whatsapp.groups().then((groups) => { console.log(JSON.stringify(groups, null, 2)); done(); }, done);
        },
      });
      whatsapp.start().catch(done);
    });
  }
} catch (error) {
  // Only application errors reach here; request errors get a fixed message.
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await finishCommand({ whatsapp, activeTask, store, release });
}
