import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
    }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind, id));
      CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL,
        data TEXT NOT NULL, finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS sticker_sources (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sticker_versions (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, source_id TEXT NOT NULL,
        edits TEXT NOT NULL, sticker BLOB NOT NULL
      );
    `);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key, value) {
    this.db.prepare('INSERT INTO kv VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }
  observation(snapshot) {
    this.db.prepare('INSERT INTO observations (observed_at, data) VALUES (?, ?)')
      .run(snapshot.observedAt, JSON.stringify(snapshot));
    // A year of hourly history; delivery audit retained separately.
    this.db.prepare('DELETE FROM observations WHERE observed_at < ?').run(snapshot.observedAt - 366 * 86_400_000);
  }
  reserve(id, data, now) {
    this.db.prepare('INSERT INTO deliveries VALUES (?, ?, ?, ?, NULL)')
      .run(id, now, 'attempting', JSON.stringify(data));
  }
  finish(id, status, now) {
    this.db.prepare('UPDATE deliveries SET status = ?, finished_at = ? WHERE id = ?').run(status, now, id);
  }
  recoverAttempts(now) {
    return this.db.prepare("UPDATE deliveries SET status = 'uncertain', finished_at = ? WHERE status = 'attempting'").run(now).changes;
  }
  deliveries() {
    return this.db.prepare('SELECT * FROM deliveries ORDER BY created_at, rowid').all()
      .map((row) => ({ ...row, data: JSON.parse(row.data) }));
  }
  close() { this.db.close(); }
  saveSticker(id, chatId, { sourceId = id, source, edits = [], sticker }) {
    this.transaction(() => {
      if (source) this.db.prepare('INSERT INTO sticker_sources VALUES (?, ?)')
        .run(sourceId, JSON.stringify(source));
      this.db.prepare('INSERT INTO sticker_versions VALUES (?, ?, ?, ?, ?)')
        .run(id, chatId, sourceId, JSON.stringify(edits), sticker);
    });
  }
  hasSticker(id, chatId) {
    return typeof id === 'string' && typeof chatId === 'string'
      && Boolean(this.db.prepare('SELECT 1 FROM sticker_versions WHERE id = ? AND chat_id = ?').get(id, chatId));
  }
  stickerContext(id, chatId) {
    const row = this.db.prepare(`SELECT v.*, s.data FROM sticker_versions v
      JOIN sticker_sources s ON s.id = v.source_id WHERE v.id = ? AND v.chat_id = ?`).get(id, chatId);
    return row ? { sourceId: row.source_id, source: JSON.parse(row.data),
      edits: JSON.parse(row.edits), sticker: Buffer.from(row.sticker) } : null;
  }
}
