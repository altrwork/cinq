import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/cart.js';
test('hidden: qty 9 is not discounted', () => assert.equal(total([{ price: 2, qty: 9 }]), 18));
test('hidden: discount is per line', () => assert.equal(total([{ price: 2, qty: 10 }, { price: 3, qty: 1 }]), 21));
test('hidden: stays exact in cents', () => assert.equal(total([{ price: 0.1, qty: 30 }]), 2.7));
