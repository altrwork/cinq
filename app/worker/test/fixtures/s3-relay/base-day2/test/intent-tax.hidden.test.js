import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTax } from '../src/tax.js';
test('tax hidden: half-up', () => assert.equal(withTax(0.25, 0.1), 0.28));
test('tax hidden: negative rate', () => assert.throws(() => withTax(1, -0.1), RangeError));
test('tax hidden: zero rate', () => assert.equal(withTax(19.99, 0), 19.99));
