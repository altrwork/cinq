import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemCount } from '../src/cart.js';
test('count hidden: empty', () => assert.equal(itemCount([]), 0));
test('count hidden: no mutation', () => { const a = [{ price: 1, qty: 3 }, { price: 1, qty: 1 }]; itemCount(a); assert.equal(a[0].qty, 3); });
