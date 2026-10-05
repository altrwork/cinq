import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney } from '../src/format.js';
test('symbol: euro', () => assert.equal(formatMoney(3.5, { symbol: '€' }), '€3.50'));
