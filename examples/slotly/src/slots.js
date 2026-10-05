import { all, first, run } from './db.js';

// A slot is a time a customer can book. Capacity is one booking per slot.
export async function createSlot(db, { startsAt, minutes = 30, title, priceCents = 0 }, now = Date.now()) {
  if (!Number.isInteger(startsAt)) throw new Error('startsAt must be a UTC timestamp in ms');
  if (!title?.trim()) throw new Error('a title is required');
  if (!Number.isInteger(priceCents) || priceCents < 0) throw new Error('priceCents must be a whole number of cents');
  const r = await run(db, 'INSERT INTO slots (starts_at, minutes, title, price_cents, created_at) VALUES (?, ?, ?, ?, ?)', startsAt, minutes, title.trim(), priceCents, now);
  return getSlot(db, r.meta.last_row_id);
}
export const getSlot = (db, id) => first(db, 'SELECT * FROM slots WHERE id = ?', id);

/** Slots from `from` onwards that nobody has booked yet. */
export function openSlots(db, from = Date.now()) {
  return all(db, `SELECT s.* FROM slots s WHERE s.starts_at >= ?
    AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') ORDER BY s.starts_at`, from);
}
export function allSlots(db) {
  return all(db, `SELECT s.*, (SELECT count(*) FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS booked FROM slots s ORDER BY s.starts_at`);
}
