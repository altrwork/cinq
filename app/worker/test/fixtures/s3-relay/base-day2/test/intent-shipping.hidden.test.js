import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shipping } from '../src/shipping.js';
test('ship hidden: exactly 50 is free', () => assert.equal(shipping([{ price: 25, qty: 2 }]), 0));
test('ship hidden: empty cart', () => assert.equal(shipping([]), 4.99));
