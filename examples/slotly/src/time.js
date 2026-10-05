// Times are stored as UTC milliseconds and shown in the viewer's timezone.
export const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
export function formatWhen(ms, timezone = 'UTC') {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms);
}
