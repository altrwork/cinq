import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total, lineTotalCents } from '../src/cart.js';
import { formatMoney } from '../src/format.js';
test('total sums price*qty', () => assert.equal(total([{ price: 2, qty: 3 }, { price: 1.5, qty: 2 }]), 9));
test('total is exact in cents', () => assert.equal(total([{ price: 0.1, qty: 3 }]), 0.3));
test('lineTotalCents', () => assert.equal(lineTotalCents({ price: 1.25, qty: 4 }), 500));
test('formatMoney', () => assert.equal(formatMoney(3.5), '$3.50'));
test('formatMoney thousands', () => assert.equal(formatMoney(1234567.5), '$1,234,567.50'));
