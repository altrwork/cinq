import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineTotalCents, total } from '../src/cart.js';
test('qty hidden: fractional', () => assert.throws(() => lineTotalCents({ price: 1, qty: 1.5 }), RangeError));
test('qty hidden: zero ok', () => assert.equal(lineTotalCents({ price: 3, qty: 0 }), 0));
test('qty hidden: via total', () => assert.throws(() => total([{ price: 1, qty: -2 }]), RangeError));
