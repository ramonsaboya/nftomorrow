import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { acquireLock } from '../src/lock.js';
import { WhatsApp } from '../src/whatsapp.js';
import { sendPriceTest } from '../src/manual-send.js';
import { finishCommand } from '../src/shutdown.js';

// Explicit operator test, run on the Droplet with the main service stopped.
// This is inspectable provenance evidence, not cryptographic location attestation.
process.umask(0o077);
let store, release, whatsapp, activeTask;
try {
  const expectedIp = process.argv[2];
  if (!expectedIp) throw new Error('Pass the expected Droplet public IP');
  const metadata = async (path) => {
    const response = await fetch(`http://169.254.169.254/metadata/v1/${path}`, {
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) throw new Error('DigitalOcean metadata unavailable');
    return (await response.text()).trim();
  };
  const [dropletId, publicIp] = await Promise.all([
    metadata('id'), metadata('interfaces/public/0/ipv4/address'),
  ]);
  if (publicIp !== expectedIp || !/^\d+$/.test(dropletId)) throw new Error('Unexpected Droplet identity');
  const { config, dataDir, apiKey } = loadConfig();
  release = acquireLock(join(dataDir, 'instance.sqlite'));
  store = new Store(join(dataDir, 'monitor.sqlite'));
  const evidence = {
    code: randomBytes(6).toString('hex').toUpperCase(),
    hostname: hostname(), dropletId, publicIp, pid: process.pid,
    uid: process.getuid(), preparedAt: new Date().toISOString(),
    deployedRevision: readFileSync(new URL('../REVISION', import.meta.url), 'utf8').trim(),
    status: 'prepared',
  };
  const saveEvidence = () => {
    writeFileSync(join(dataDir, 'origin-test.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ event: 'droplet_origin_test', ...evidence }));
  };
  saveEvidence();
  const prefix = ['DROPLET ORIGIN TEST', `Code: ${evidence.code}`,
    `Host: ${evidence.hostname}`, `Public IP: ${publicIp}`, `Droplet ID: ${dropletId}`,
    `Time: ${evidence.preparedAt}`, `Revision: ${evidence.deployedRevision.slice(0, 12)}`].join('\n');
  await new Promise((resolve, reject) => {
    let sent = false;
    const timer = setTimeout(() => reject(new Error('Remote test timed out')), 120_000);
    const done = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
    whatsapp = new WhatsApp({ store, groupId: config.groupId,
      onStatus: (status) => {
        if (['needs_pairing', 'connection_replaced', 'fatal_auth_store'].includes(status)) done(new Error(status));
      },
      onFresh: () => {
        if (sent) return;
        sent = true;
        activeTask = sendPriceTest({ config, store, whatsapp, apiKey, prefix }).then((id) => {
          evidence.messageId = id;
          evidence.status = 'acknowledged';
          evidence.acknowledgedAt = new Date().toISOString();
          saveEvidence(); done();
        }, (error) => { evidence.status = 'failed_or_uncertain'; saveEvidence(); done(error); });
      },
    });
    whatsapp.start().catch(done);
  });
} catch (error) {
  console.error(`Droplet origin test: ${error.message}`);
  process.exitCode = 1;
} finally {
  await finishCommand({ whatsapp, activeTask, store, release });
}
