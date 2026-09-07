import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';

// OS-managed SQLite lock is released even after SIGKILL. A separate file keeps
// the lifetime lock independent of short data/auth transactions.
export function acquireLock(path) {
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  try { db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE'); }
  catch { db.close(); throw new Error('Another nftomorrow process owns this data directory'); }
  return () => db.close();
}
