import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney } from '../src/format.js';
test('neg: -3.5', () => assert.equal(formatMoney(-3.5), '-$3.50'));
