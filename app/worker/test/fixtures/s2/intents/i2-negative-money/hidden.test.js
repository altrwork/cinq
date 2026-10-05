import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney } from '../src/format.js';
test('hidden: negative with thousands', () => assert.equal(formatMoney(-1234.5), '-$1,234.50'));
test('hidden: zero', () => assert.equal(formatMoney(0), '$0.00'));
test('hidden: small negative', () => assert.equal(formatMoney(-0.05), '-$0.05'));
