import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/cart.js';
test('validate hidden: null', () => assert.throws(() => total(null), TypeError));
test('validate hidden: empty ok', () => assert.equal(total([]), 0));
