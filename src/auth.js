import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

// Every key batch commits atomically before its promise resolves. Baileys wraps
// this SignalKeyStore in its own transaction layer for logical Signal operations.
export function sqliteAuth(store) {
  const read = store.db.prepare('SELECT value FROM auth WHERE kind = ? AND id = ?');
  const write = store.db.prepare('INSERT INTO auth VALUES (?, ?, ?) ON CONFLICT(kind,id) DO UPDATE SET value = excluded.value');
  const remove = store.db.prepare('DELETE FROM auth WHERE kind = ? AND id = ?');
  const decode = (row) => row ? JSON.parse(row.value, BufferJSON.reviver) : undefined;
  const creds = decode(read.get('creds', 'main')) ?? initAuthCreds();
  const saveCreds = () => store.transaction(() => {
    write.run('creds', 'main', JSON.stringify(creds, BufferJSON.replacer));
  });
  saveCreds();
  return {
    state: { creds, keys: {
      async get(type, ids) {
        const result = {};
        for (const id of ids) {
          let value = decode(read.get(type, id));
          if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
          if (value !== undefined) result[id] = value;
        }
        return result;
      },
      async set(data) {
        store.transaction(() => {
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries)) {
              if (value == null) remove.run(type, id);
              else write.run(type, id, JSON.stringify(value, BufferJSON.replacer));
            }
          }
          write.run('creds', 'main', JSON.stringify(creds, BufferJSON.replacer));
        });
      },
    } },
    saveCreds,
  };
}
