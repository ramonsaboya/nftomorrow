// Authorize protocol sender IDs only; profile names, mentions and quoted senders
// are user-controlled and must never grant access.
function userJid(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|lid)$/.exec(value);
  return match ? `${match[1]}@${match[2]}` : null;
}

export function isStickerOwner(message, ownerJids) {
  if (!Array.isArray(ownerJids) || !ownerJids.length || message?.key?.fromMe) return false;
  const key = message?.key;
  const group = /^\d+(?:-\d+)?@g\.us$/.test(key?.remoteJid ?? '');
  const sender = userJid(group ? key.participant : key?.remoteJid);
  if (!sender) return false;
  const alternate = userJid(group ? key.participantAlt : key.remoteJidAlt);
  const allowed = ownerJids.map(userJid).filter(Boolean);
  // Baileys supplies the alternate phone-number/LID identity on message keys.
  return allowed.includes(sender) || (alternate !== null
    && sender.split('@')[1] !== alternate.split('@')[1] && allowed.includes(alternate));
}
