// Money is integer cents everywhere; it becomes a string only when shown.
export function formatCents(cents, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}
export function parseDollars(text) {
  const m = String(text).trim().match(/^\$?(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`not an amount: ${text}`);
  return Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0'));
}
