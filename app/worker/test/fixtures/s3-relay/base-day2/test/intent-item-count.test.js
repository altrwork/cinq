import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemCount } from '../src/cart.js';
test('count: sums qty', () => assert.equal(itemCount([{ price: 1, qty: 2 }, { price: 5, qty: 3 }]), 5));
