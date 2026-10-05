import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney } from '../src/format.js';
test('neg hidden: thousands', () => assert.equal(formatMoney(-1234.5), '-$1,234.50'));
test('neg hidden: zero', () => assert.equal(formatMoney(0), '$0.00'));
