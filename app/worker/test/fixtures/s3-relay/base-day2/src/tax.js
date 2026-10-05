import { fromCents } from './money.js';

export function withTax(amount, rate) {
  if (rate < 0) throw new RangeError('rate must not be negative');
  // Trim float noise (e.g. 1.005 * 100 = 100.49999...) before rounding half-up.
  const cents = Number((amount * 100 * (1 + rate)).toPrecision(12));
  return fromCents(Math.round(cents));
}
