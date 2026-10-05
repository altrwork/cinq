// Day 2 of the relay: 12 intents authored concurrently against base-day2 (the trunk run 1 produced).
// Includes a planted SABOTEUR PAIR: `tax-percent` changes withTax's contract (8 means 8%, was 0.08),
// and `checkout` adds a new caller that passes a fraction. They touch different files, so git merges
// them cleanly, and each is green alone. Together, checkout's tests go red.
// `tax-percent` is an approved contract change: its allowed paths include the tax tests it supersedes.
const H = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n`;

export const intents = [
  {
    id: 'tax-percent', saboteur: 'contract-change',
    allowed: ['src/tax.js', 'test/intent-tax.test.js', 'test/intent-tax.hidden.test.js'],
    supersedes: ['tax'],
    goal: 'Contract change (approved): withTax(amount, ratePercent) now takes the rate as a percentage, so 8 means 8%. Rounding (half-up to the nearest cent) and the RangeError for negative rates are unchanged. Update the existing tax tests (test/intent-tax.test.js and test/intent-tax.hidden.test.js) to the new contract.',
    frozen: H + `import { withTax } from '../src/tax.js';
test('tax%: 8 means 8%', () => assert.equal(withTax(10, 8), 10.8));\n`,
    hidden: H + `import { withTax } from '../src/tax.js';
test('tax% hidden: half-up', () => assert.equal(withTax(0.25, 10), 0.28));
test('tax% hidden: negative', () => assert.throws(() => withTax(1, -5), RangeError));
test('tax% hidden: zero', () => assert.equal(withTax(19.99, 0), 19.99));\n`,
  },
  {
    id: 'checkout', saboteur: 'depends-on-old-contract', allowed: ['src/checkout.js'],
    goal: 'Add src/checkout.js exporting checkout(items, taxRate): the order total from total() in src/cart.js with tax applied via withTax() from src/tax.js, plus shipping(items) from src/shipping.js, in dollars. taxRate is a fraction: 0.08 means 8%.',
    frozen: H + `import { checkout } from '../src/checkout.js';
test('checkout: 8% tax + shipping', () => assert.equal(checkout([{ price: 10, qty: 2 }], 0.08), 26.59));\n`,
    hidden: H + `import { checkout } from '../src/checkout.js';
test('checkout hidden: free shipping', () => assert.equal(checkout([{ price: 25, qty: 2 }], 0), 50));
test('checkout hidden: rounding', () => assert.equal(checkout([{ price: 0.25, qty: 1 }], 0.1), 5.27));\n`,
  },
  {
    id: 'coupon-percent', allowed: ['src/cart.js'],
    goal: 'New coupon "TEN": 10% off the order total after line discounts, rounded half-up to the nearest cent. Existing coupons keep working.',
    frozen: H + `import { total } from '../src/cart.js';
test('TEN: 10% off', () => assert.equal(total([{ price: 10, qty: 2 }], { coupon: 'TEN' }), 18));\n`,
    hidden: H + `import { total } from '../src/cart.js';
test('TEN hidden: half-up', () => assert.equal(total([{ price: 0.15, qty: 1 }], { coupon: 'TEN' }), 0.14));
test('TEN hidden: SAVE5 still works', () => assert.equal(total([{ price: 4, qty: 3 }], { coupon: 'SAVE5' }), 7));\n`,
  },
  {
    id: 'coupon-case-insensitive', allowed: ['src/cart.js'],
    goal: 'Coupon codes are case-insensitive ("save5" works like "SAVE5"). Unknown coupons still throw.',
    frozen: H + `import { total } from '../src/cart.js';
test('coupon case: save5', () => assert.equal(total([{ price: 4, qty: 3 }], { coupon: 'save5' }), 7));\n`,
    hidden: H + `import { total } from '../src/cart.js';
test('coupon case hidden: Save5', () => assert.equal(total([{ price: 4, qty: 3 }], { coupon: 'Save5' }), 7));
test('coupon case hidden: unknown throws', () => assert.throws(() => total([{ price: 1, qty: 1 }], { coupon: 'nope' }), /unknown coupon/i));\n`,
  },
  {
    id: 'max-qty', allowed: ['src/cart.js'],
    goal: 'lineTotalCents(item) throws a RangeError when qty is greater than 999.',
    frozen: H + `import { lineTotalCents } from '../src/cart.js';
test('max qty: 1000 throws', () => assert.throws(() => lineTotalCents({ price: 1, qty: 1000 }), RangeError));\n`,
    hidden: H + `import { lineTotalCents, total } from '../src/cart.js';
test('max qty hidden: 999 ok', () => assert.equal(lineTotalCents({ price: 1, qty: 999 }), 89910));
test('max qty hidden: via total', () => assert.throws(() => total([{ price: 1, qty: 5000 }]), RangeError));\n`,
  },
  {
    id: 'accounting-format', allowed: ['src/format.js'],
    goal: 'formatMoney accepts options.accounting: when true, negative amounts are shown in parentheses without a minus sign, e.g. -3.5 -> "($3.50)". Positive amounts are unchanged.',
    frozen: H + `import { formatMoney } from '../src/format.js';
test('accounting: parens', () => assert.equal(formatMoney(-3.5, { accounting: true }), '($3.50)'));\n`,
    hidden: H + `import { formatMoney } from '../src/format.js';
test('accounting hidden: symbol', () => assert.equal(formatMoney(-3.5, { accounting: true, symbol: '€' }), '(€3.50)'));
test('accounting hidden: thousands', () => assert.equal(formatMoney(-1234.5, { accounting: true }), '($1,234.50)'));
test('accounting hidden: positive', () => assert.equal(formatMoney(2, { accounting: true }), '$2.00'));\n`,
  },
  {
    id: 'no-cents', allowed: ['src/format.js'],
    goal: 'formatMoney accepts options.cents: when false, the amount is rounded to whole dollars (half away from zero) and shown without a decimal part, e.g. 1234.5 -> "$1,235".',
    frozen: H + `import { formatMoney } from '../src/format.js';
test('no cents: 1234.5', () => assert.equal(formatMoney(1234.5, { cents: false }), '$1,235'));\n`,
    hidden: H + `import { formatMoney } from '../src/format.js';
test('no cents hidden: negative', () => assert.equal(formatMoney(-2.4, { cents: false }), '-$2'));
test('no cents hidden: rounds down to zero', () => assert.equal(formatMoney(0.49, { cents: false }), '$0'));
test('no cents hidden: default keeps cents', () => assert.equal(formatMoney(1.5), '$1.50'));\n`,
  },
  {
    id: 'express-shipping', allowed: ['src/shipping.js'],
    goal: 'shipping(items, options) accepts options.express: when true, add 9.99 to the normal shipping charge (so carts that ship free pay 9.99). Without options, behaviour is unchanged.',
    frozen: H + `import { shipping } from '../src/shipping.js';
test('express: under 50', () => assert.equal(shipping([{ price: 10, qty: 2 }], { express: true }), 14.98));\n`,
    hidden: H + `import { shipping } from '../src/shipping.js';
test('express hidden: free threshold', () => assert.equal(shipping([{ price: 25, qty: 2 }], { express: true }), 9.99));
test('express hidden: default', () => assert.equal(shipping([{ price: 10, qty: 2 }]), 4.99));\n`,
  },
  {
    id: 'merge-lines', allowed: ['src/cart.js'],
    goal: 'Add and export mergeLines(items) from src/cart.js: returns a new array where lines with the same sku are combined into one line (qty summed, keeping the first line\'s other fields). Lines without a sku are kept as they are. Order follows first appearance. The input must not be modified.',
    frozen: H + `import { mergeLines } from '../src/cart.js';
test('merge: same sku', () => assert.deepEqual(mergeLines([{ sku: 'a', price: 1, qty: 1 }, { sku: 'a', price: 1, qty: 2 }]), [{ sku: 'a', price: 1, qty: 3 }]));\n`,
    hidden: H + `import { mergeLines } from '../src/cart.js';
test('merge hidden: order + no-sku', () => assert.deepEqual(mergeLines([{ sku: 'b', price: 2, qty: 1 }, { price: 9, qty: 1 }, { sku: 'a', price: 1, qty: 1 }, { sku: 'b', price: 2, qty: 4 }]), [{ sku: 'b', price: 2, qty: 5 }, { price: 9, qty: 1 }, { sku: 'a', price: 1, qty: 1 }]));
test('merge hidden: no mutation', () => { const a = [{ sku: 'x', price: 1, qty: 1 }, { sku: 'x', price: 1, qty: 1 }]; mergeLines(a); assert.equal(a[0].qty, 1); assert.equal(a.length, 2); });\n`,
  },
  {
    id: 'average-price', allowed: ['src/cart.js'],
    goal: 'Add and export averageUnitPrice(items) from src/cart.js: total(items) divided by the total qty, rounded half-up to the nearest cent; 0 when the total qty is 0.',
    frozen: H + `import { averageUnitPrice } from '../src/cart.js';
test('avg: two lines', () => assert.equal(averageUnitPrice([{ price: 2, qty: 1 }, { price: 4, qty: 1 }]), 3));\n`,
    hidden: H + `import { averageUnitPrice } from '../src/cart.js';
test('avg hidden: empty', () => assert.equal(averageUnitPrice([]), 0));
test('avg hidden: uses discounted total', () => assert.equal(averageUnitPrice([{ price: 1, qty: 10 }]), 0.9));
test('avg hidden: rounding', () => assert.equal(averageUnitPrice([{ price: 1, qty: 3 }, { price: 0, qty: 3 }]), 0.5));\n`,
  },
  {
    id: 'parse-money', allowed: ['src/format.js'],
    goal: 'Add and export parseMoney(text) from src/format.js: the inverse of formatMoney\'s default output, e.g. "$1,234.50" -> 1234.5 and "-$3.50" -> -3.5. Throw a TypeError for text that is not in that format.',
    frozen: H + `import { parseMoney } from '../src/format.js';
test('parse: thousands', () => assert.equal(parseMoney('$1,234.50'), 1234.5));\n`,
    hidden: H + `import { parseMoney, formatMoney } from '../src/format.js';
test('parse hidden: negative', () => assert.equal(parseMoney('-$3.50'), -3.5));
test('parse hidden: garbage', () => assert.throws(() => parseMoney('twelve dollars'), TypeError));
test('parse hidden: round trip', () => assert.equal(parseMoney(formatMoney(98765.43)), 98765.43));\n`,
  },
  {
    id: 'loyalty', allowed: ['src/loyalty.js'],
    goal: 'Add src/loyalty.js exporting points(items, options): one point per whole dollar of total(items, options) from src/cart.js (so discounts and coupons count), rounded down.',
    frozen: H + `import { points } from '../src/loyalty.js';
test('points: 20', () => assert.equal(points([{ price: 10, qty: 2 }]), 20));\n`,
    hidden: H + `import { points } from '../src/loyalty.js';
test('points hidden: bulk', () => assert.equal(points([{ price: 2, qty: 10 }]), 18));
test('points hidden: coupon', () => assert.equal(points([{ price: 4, qty: 3 }], { coupon: 'SAVE5' }), 7));
test('points hidden: floor', () => assert.equal(points([{ price: 0.99, qty: 1 }]), 0));\n`,
  },
];
