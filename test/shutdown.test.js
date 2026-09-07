import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('CLI shutdown bounds a lingering socket, waits for bookkeeping, flushes output and retains exit code', async () => {
  const helper = new URL('../src/shutdown.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { finishCommand } from ${JSON.stringify(helper)};
    let saved = false;
    const activeTask = new Promise(resolve => setTimeout(() => { saved = true; resolve(); }, 40));
    setInterval(() => {}, 1000); // Simulate a dependency retaining the event loop.
    process.exitCode = 7;
    process.stdout.write('x'.repeat(1024 * 1024));
    process.stderr.write('shutdown-test');
    await finishCommand({
      whatsapp: { stop: () => new Promise(() => {}) }, activeTask, graceMs: 20,
      store: { close: () => { if (!saved) throw new Error('State closed before delivery bookkeeping'); process.stdout.write('SAVED'); } },
      release: () => process.stdout.write('UNLOCKED'),
    });
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(result, { code: 7, signal: null });
    assert.equal(stdout, 'x'.repeat(1024 * 1024) + 'SAVEDUNLOCKED');
    assert.equal(stderr, 'shutdown-test');
  } finally { clearTimeout(timeout); }
});
