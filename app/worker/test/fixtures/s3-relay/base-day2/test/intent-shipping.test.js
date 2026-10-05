import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shipping } from '../src/shipping.js';
test('ship: under 50', () => assert.equal(shipping([{ price: 10, qty: 2 }]), 4.99));
