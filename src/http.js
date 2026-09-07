import { setTimeout as sleep } from 'node:timers/promises';

// Only idempotent reads/health pings use retries. Never retry a WhatsApp send blindly.
export async function getJson(url, { fetchImpl = fetch, headers = {}, attempts = 3,
  timeoutMs = 10_000, pause = sleep } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (error.retryable === false || attempt === attempts - 1) throw error;
      await pause(Math.min(1000 * 2 ** attempt, 4000));
    }
  }
  throw new Error('No HTTP attempts configured');
}

export async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Operation timed out')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
