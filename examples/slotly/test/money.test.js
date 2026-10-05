import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCents, parseDollars } from '../src/money.js';

test('cents are shown as dollars', () => {
  assert.equal(formatCents(3500), '$35.00');
  assert.equal(formatCents(123456), '$1,234.56');
});
test('typed amounts become cents', () => {
  assert.equal(parseDollars('$35'), 3500);
  assert.equal(parseDollars('12.5'), 1250);
  assert.throws(() => parseDollars('twelve'), /not an amount/);
});
