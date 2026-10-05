import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/cart.js';
test('coupon hidden: floor at zero', () => assert.equal(total([{ price: 1, qty: 2 }], { coupon: 'SAVE5' }), 0));
test('coupon hidden: unknown throws', () => assert.throws(() => total([{ price: 1, qty: 1 }], { coupon: 'NOPE' }), /unknown coupon/i));
test('coupon hidden: no options', () => assert.equal(total([{ price: 0.1, qty: 3 }]), 0.3));
