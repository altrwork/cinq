import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTax } from '../src/tax.js';
test('tax: 8%', () => assert.equal(withTax(10, 0.08), 10.8));
