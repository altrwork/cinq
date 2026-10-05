import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/cart.js';
import { formatMoney } from '../src/format.js';
test('total sums price*qty', () => assert.equal(total([{ price: 2, qty: 3 }, { price: 1.5, qty: 2 }]), 9));
test('formatMoney', () => assert.equal(formatMoney(3.5), '$3.50'));
