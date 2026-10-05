import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney } from '../src/format.js';
test('symbol hidden: thousands', () => assert.equal(formatMoney(1234.5, { symbol: '£' }), '£1,234.50'));
test('symbol hidden: default', () => assert.equal(formatMoney(2), '$2.00'));
