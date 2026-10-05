import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/cart.js';
test('validate: non-array', () => assert.throws(() => total('nope'), TypeError));
