import { toCents, fromCents } from './money.js';

export function lineTotalCents(item) {
  return toCents(item.price) * item.qty;
}

export function total(items) {
  let cents = 0;
  for (const item of items) cents += lineTotalCents(item);
  return fromCents(cents);
}
