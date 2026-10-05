import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/cart.js';
test('alias: unitPrice', () => assert.equal(total([{ unitPrice: 2, qty: 3 }]), 6));
