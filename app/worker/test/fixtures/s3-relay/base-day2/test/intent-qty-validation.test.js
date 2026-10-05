import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineTotalCents } from '../src/cart.js';
test('qty: negative', () => assert.throws(() => lineTotalCents({ price: 1, qty: -1 }), RangeError));
