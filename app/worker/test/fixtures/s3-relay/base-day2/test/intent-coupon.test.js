import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/cart.js';
test('coupon: SAVE5', () => assert.equal(total([{ price: 4, qty: 3 }], { coupon: 'SAVE5' }), 7));
