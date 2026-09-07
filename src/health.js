export class Health {
  constructor(urls, { fetchImpl = fetch, log = () => {} } = {}) {
    this.urls = urls;
    this.fetch = fetchImpl;
    this.log = log;
  }
  async ping(check, ok) {
    const url = this.urls[check];
    if (!url) return;
    try {
      const response = await this.fetch(`${url}${ok ? '' : '/fail'}`, {
        method: 'POST', body: `${check}: ${ok ? 'healthy' : 'attention required'}`,
        signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
      if (!response.ok) throw new Error('Health ping failed');
    } catch {
      // Never log the secret ping URL or an error containing it.
      this.log('health_ping_failed', { check });
    }
  }
}
