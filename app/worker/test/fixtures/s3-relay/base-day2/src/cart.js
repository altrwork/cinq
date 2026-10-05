import { toCents, fromCents } from './money.js';

export function lineTotalCents(item) {
  if (!Number.isInteger(item.qty) || item.qty < 0) {
    throw new RangeError(`qty must be a non-negative integer, got ${item.qty}`);
  }
  const cents = toCents(item.price ?? item.unitPrice) * item.qty;
  // Bulk discount: 10% off lines with qty >= 10, rounded to the nearest cent.
  return item.qty >= 10 ? Math.round((cents * 9) / 10) : cents;
}

const COUPONS = {
  SAVE5: (cents) => Math.max(0, cents - toCents(5)),
};

export function total(items, options = {}) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  let cents = 0;
  for (const item of items) cents += lineTotalCents(item);
  const coupon = options?.coupon;
  if (coupon !== undefined && coupon !== null) {
    if (!Object.hasOwn(COUPONS, coupon)) throw new Error(`unknown coupon: ${coupon}`);
    cents = COUPONS[coupon](cents);
  }
  return fromCents(cents);
}

export function itemCount(items) {
  let count = 0;
  for (const item of items) count += item.qty;
  return count;
}
