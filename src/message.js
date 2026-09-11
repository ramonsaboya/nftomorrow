import { COLLECTIONS, LAMPORTS_PER_SOL } from './collections.js';
import { priceIn, validateSnapshot } from './prices.js';

const solNumber = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  const rows = [
    ...(currency ? [['', totalFiat == null ? 'unavailable' : fiatNumber.format(totalFiat), currency]] : []),
    ['', totalSol, 'SOL'],
    ...(currency ? [['1 SOL =', totalFiat == null ? 'unavailable' : fiatNumber.format(snapshot.fx.rates[currency]), currency]] : []),
    ...COLLECTIONS.map(({ id, name }) => [name + ':', solNumber.format(snapshot.lamports[id] / LAMPORTS_PER_SOL), 'SOL']),
  ];
  const width = Math.max(...rows.map(([, value]) => value.length));
  const labelWidth = Math.max(...rows.map(([label]) => label.length)) + 1;
  const lines = ['Medallion:'];
  for (const [label, value, unit] of rows) {
    if (label === '1 SOL =' || label === COLLECTIONS[0].name + ':') lines.push('');
    lines.push(label.padEnd(labelWidth) + value.padStart(width) + ' ' + unit);
  }
  return '\x60\x60\x60\n' + lines.join('\n') + '\n\x60\x60\x60\n\n' + checkedDate.format(snapshot.observedAt);
}
