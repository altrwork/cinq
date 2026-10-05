import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total, lineTotalCents } from '../src/cart.js';
test('alias hidden: price wins', () => assert.equal(total([{ price: 1, unitPrice: 9, qty: 1 }]), 1));
test('alias hidden: lineTotalCents', () => assert.equal(lineTotalCents({ unitPrice: 1.25, qty: 4 }), 500));
