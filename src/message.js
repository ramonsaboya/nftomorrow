import { COLLECTIONS, LAMPORTS_PER_SOL } from './collections.js';
import { priceIn, validateSnapshot } from './prices.js';

const solNumber = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const labels = ['Letter', 'Reflection', 'Symbol'];
const fiatNumber = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const checkedDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
});

export function formatPrices(snapshot, { displayCurrency = null, now = Date.now() } = {}) {
  validateSnapshot(snapshot, now);
  const totalSol = solNumber.format(snapshot.lamports.medallion / LAMPORTS_PER_SOL);
  const currency = displayCurrency && displayCurrency !== 'SOL' ? displayCurrency : null;
  const totalFiat = currency ? priceIn(snapshot, 'medallion', currency, now) : null;
  const lines = ['Medallion:'];
  if (currency) lines.push(`  ${totalFiat == null ? `${currency} unavailable` : `${fiatNumber.format(totalFiat)} ${currency}`}`);
  lines.push(`  ${totalSol} SOL`);
  if (currency) {
    const rate = totalFiat == null ? 'unavailable' : `${fiatNumber.format(snapshot.fx.rates[currency])} ${currency}`;
    lines.push('', `1 SOL = ${rate}`);
  }
  lines.push('', '');
  for (const [index, { id }] of COLLECTIONS.entries()) {
    lines.push(`${labels[index]}: ${solNumber.format(snapshot.lamports[id] / LAMPORTS_PER_SOL)} SOL`);
  }
  lines.push('', checkedDate.format(snapshot.observedAt));
  return lines.join('\n');
}
