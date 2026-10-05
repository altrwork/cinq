import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney } from '../src/format.js';
test('intent: negative amounts', () => assert.equal(formatMoney(-3.5), '-$3.50'));
