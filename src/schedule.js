export const HOUR_MS = 3_600_000;
const london = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function previousDate(date) {
  const day = new Date(`${date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

// Calendar slot IDs avoid adding 24 hours across 23/25-hour London days.
// Spring-forward missing times fire at the first local time past the slot;
// a repeated autumn time is consumed once, using monotonically increasing IDs.
export function dailySlot(now, time) {
  const parts = Object.fromEntries(london.formatToParts(now).map(({ type, value }) => [type, value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return `${parts.hour}:${parts.minute}` >= time ? date : previousDate(date);
}
