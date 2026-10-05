import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, seed, NOW } from './helpers.js';
import { book, cancel, upcomingFor, BookingError } from '../src/bookings.js';
import { setPlan } from '../src/users.js';
import { createSlot } from '../src/slots.js';
import { HOUR } from '../src/time.js';

test('a customer books an open slot and sees it in their upcoming bookings', async () => {
  const db = testDb(); const { ana, haircut } = await seed(db);
  const b = await book(db, { slotId: haircut.id, userId: ana.id, note: 'short on the sides' }, NOW);
  assert.equal(b.status, 'confirmed');
  assert.deepEqual((await upcomingFor(db, ana.id, NOW)).map((x) => x.title), ['Haircut']);
});

test('a booked slot cannot be booked again', async () => {
  const db = testDb(); const { ana, ben, haircut } = await seed(db);
  await book(db, { slotId: haircut.id, userId: ana.id }, NOW);
  await assert.rejects(book(db, { slotId: haircut.id, userId: ben.id }, NOW), (e) => e instanceof BookingError && e.code === 'taken');
});

test('a cancelled booking frees the slot', async () => {
  const db = testDb(); const { ana, ben, haircut } = await seed(db);
  const b = await book(db, { slotId: haircut.id, userId: ana.id }, NOW);
  await cancel(db, { bookingId: b.id, userId: ana.id });
  assert.equal((await book(db, { slotId: haircut.id, userId: ben.id }, NOW)).status, 'confirmed');
});

test('past slots and other people\'s bookings are refused', async () => {
  const db = testDb(); const { ana, ben, haircut } = await seed(db);
  await assert.rejects(book(db, { slotId: haircut.id, userId: ana.id }, NOW + 4 * HOUR), /already started/);
  const b = await book(db, { slotId: haircut.id, userId: ana.id }, NOW);
  await assert.rejects(cancel(db, { bookingId: b.id, userId: ben.id }), /no such booking/);
});

test('the free plan has a monthly cap; pro does not', async () => {
  const db = testDb(); const { ana } = await seed(db);
  for (let i = 0; i < 21; i++) await createSlot(db, { startsAt: NOW + (30 + i) * HOUR, title: `Class ${i}` }, NOW);
  const ids = (await db.prepare("SELECT id FROM slots WHERE title LIKE 'Class %' ORDER BY id").all()).results.map((r) => r.id);
  for (const id of ids.slice(0, 20)) await book(db, { slotId: id, userId: ana.id }, NOW);
  await assert.rejects(book(db, { slotId: ids[20], userId: ana.id }, NOW), (e) => e.code === 'plan-limit');
  await setPlan(db, ana.id, 'pro');
  assert.equal((await book(db, { slotId: ids[20], userId: ana.id }, NOW)).status, 'confirmed');
});
