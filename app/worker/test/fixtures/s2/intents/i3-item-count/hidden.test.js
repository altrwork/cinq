import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemCount, total } from '../src/cart.js';
test('hidden: empty cart', () => assert.equal(itemCount([]), 0));
test('hidden: total unaffected', () => assert.equal(total([{ price: 0.1, qty: 3 }]), 0.3));
