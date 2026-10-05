import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/cart.js';
test('bulk: 10% off qty>=10', () => assert.equal(total([{ price: 2, qty: 10 }]), 18));
