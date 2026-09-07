import { withTimeout } from './http.js';

// One-shot CLI only: a long-lived monitor must not call process.exit here.
// Baileys' WebSocket close handshake can wait 30s and its internal timers can
// outlive an operation. Finish application writes before ending the process.
export async function finishCommand({ whatsapp, activeTask, store, release, graceMs = 2000 }) {
  const closing = whatsapp?.stop();
  try {
    await activeTask;
    if (closing) await withTimeout(closing, graceMs).catch(() => {});
  } finally {
    try { store?.close(); } finally { release?.(); }
  }
  if (whatsapp) {
    // process.exit alone could truncate buffered stdout/stderr on pipes.
    await Promise.all([process.stdout, process.stderr].map((stream) =>
      new Promise((resolve) => stream.write('', resolve))));
    process.exit(process.exitCode ?? 0);
  }
}
